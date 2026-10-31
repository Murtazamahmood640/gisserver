import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User, IUser } from '../../models/User';
import {
  TechnicianProfile,
  ITechnicianProfile,
  ITechnicianDocument,
  VerificationStatus,
  DayOfWeek,
  DocumentType,
} from '../../models/TechnicianProfile';
import { RefreshToken } from '../../models/RefreshToken';
import { Booking } from '../../models/Booking';
import { invalidateUserStatusCache } from '../../middleware/auth';
import {
  validateFileBuffer,
  uploadDocument as uploadToStorage,
  deleteDocument as deleteFromStorage,
  generateSignedUrl,
} from '../../services/storageService';
import {
  sendEmail,
  getEmailVerificationEmail,
  getTechApplicationReceivedEmail,
  getTechNewApplicationAdminEmail,
  getTechApprovedEmail,
  getTechRejectedEmail,
  getTechSuspendedEmail,
  getTechReinstatedEmail,
  getTechDocumentRejectedEmail,
  getTechDocumentExpiringEmail,
  getTechDocumentExpiredEmail,
} from '../../services/emailService';
import { generateEmailVerificationToken } from '../../utils/jwt';
import { realtimeEmitter } from '../../realtime/emitter';
import { createHttpError } from '../../utils/httpErrors';
import logger from '../../config/logger';

export const REQUIRED_DOCUMENT_TYPES: DocumentType[] = ['id'];

const VALID_STATE_TRANSITIONS: Record<VerificationStatus, VerificationStatus[]> = {
  draft: ['pending_review'],
  pending_review: ['approved', 'rejected'],
  approved: ['suspended'],
  rejected: ['pending_review'],
  suspended: ['approved'],
};

// In-memory rate limiting for document uploads: 20 per hour per user
interface RateBucket {
  count: number;
  resetAt: number;
}
const uploadRateMap = new Map<string, RateBucket>();

function checkUploadRateLimit(userId: string): void {
  const now = Date.now();
  const bucket = uploadRateMap.get(userId);
  if (!bucket || bucket.resetAt < now) {
    uploadRateMap.set(userId, { count: 1, resetAt: now + 3600 * 1000 });
    return;
  }
  if (bucket.count >= 20) {
    throw createHttpError('Upload rate limit exceeded. Max 20 uploads per hour.', 429, 'RATE_LIMIT_EXCEEDED');
  }
  bucket.count += 1;
}

function getBaseFrontendUrl(): string {
  const raw = process.env.FRONTEND_URL;
  if (raw && raw.trim()) {
    return raw.split(',')[0].trim().replace(/\/$/, '');
  }
  return 'https://globalintegratedsupport.com';
}

export class TechnicianService {
  /**
   * Register a new technician account (role='technician', status='pending').
   */
  static async registerTechnician(data: {
    email: string;
    password: string;
    fullName: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    phoneCountryCode?: string;
    businessType?: 'individual_contractor' | 'licensed_business' | 'employee';
    yearsExperience?: number;
    emergencyAfterHours?: boolean;
    languages?: string[];
    termsAccepted?: boolean;
    serviceArea?: {
      zipCodes?: string[];
      city?: string;
      state?: string;
      radiusKm?: number;
    };
    skills?: {
      categoryIds?: string[];
      serviceIds?: string[];
    };
    equipmentCapabilities?: {
      hasWaterTank?: boolean;
      hasGenerator?: boolean;
      hasCompressor?: boolean;
      hasScanner?: boolean;
    };
  }): Promise<{ user: Partial<IUser>; profile: Partial<ITechnicianProfile> }> {
    const normalizedEmail = data.email.toLowerCase().trim();

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      throw createHttpError('An account with this email address already exists', 409, 'CONFLICT');
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(data.password, salt);

    const resolvedFullName =
      data.fullName?.trim() ||
      [data.firstName, data.lastName].filter(Boolean).join(' ').trim() ||
      'Technician';
    const resolvedFirstName =
      data.firstName?.trim() || resolvedFullName.split(' ')[0] || '';
    const resolvedLastName =
      data.lastName?.trim() || resolvedFullName.split(' ').slice(1).join(' ') || '';

    const user = await User.create({
      email: normalizedEmail,
      password: hashedPassword,
      fullName: resolvedFullName,
      firstName: resolvedFirstName,
      lastName: resolvedLastName,
      phone: data.phone?.trim(),
      phoneCountryCode: data.phoneCountryCode || '+1',
      termsAcceptedAt: data.termsAccepted ? new Date() : undefined,
      privacyAcceptedAt: data.termsAccepted ? new Date() : undefined,
      role: 'technician',
      status: 'pending',
      isActive: true,
      emailVerified: false,
    });

    const profile = await TechnicianProfile.create({
      userId: user._id,
      displayName: resolvedFullName,
      phone: data.phone?.trim(),
      businessType: data.businessType || 'individual_contractor',
      yearsExperience: data.yearsExperience ?? 0,
      emergencyAfterHours: Boolean(data.emergencyAfterHours),
      languages: data.languages || ['English'],
      skills: {
        categoryIds: data.skills?.categoryIds || [],
        serviceIds: data.skills?.serviceIds || [],
      },
      serviceArea: {
        zipCodes: data.serviceArea?.zipCodes || [],
        city: data.serviceArea?.city,
        state: data.serviceArea?.state,
        radiusKm: data.serviceArea?.radiusKm ?? 40,
      },
      equipmentCapabilities: data.equipmentCapabilities || {},
      documents: [],
      verificationStatus: 'draft',
      availability: { isOnline: false, weeklySchedule: [], timeOff: [] },
      statusHistory: [
        {
          status: 'draft',
          by: user._id.toString(),
          at: new Date(),
          note: 'Technician application registered',
        },
      ],
    });

    // Send email verification
    const verificationToken = generateEmailVerificationToken({
      userId: user._id.toString(),
      email: user.email,
    });
    const frontendUrl = getBaseFrontendUrl();
    const verifyUrl = `${frontendUrl}/verify-email?token=${verificationToken}`;

    sendEmail({
      to: user.email,
      subject: 'Verify Your Email Address - Global Integrated Support',
      html: getEmailVerificationEmail({ fullName: user.fullName, verifyUrl }),
    }).catch((emailErr) => {
      logger.error({ err: emailErr }, 'Failed to send technician verification email');
    });

    return {
      user: {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        status: user.status,
        emailVerified: user.emailVerified,
      },
      profile: {
        _id: profile._id,
        userId: profile.userId,
        verificationStatus: profile.verificationStatus,
      },
    };
  }

  /**
   * Apply to become a technician (converts existing customer to technician).
   */
  static async applyForTechnician(userId: string): Promise<ITechnicianProfile> {
    const user = await User.findById(userId);
    if (!user) {
      throw createHttpError('User not found', 404, 'NOT_FOUND');
    }

    // Check if customer has active upcoming bookings
    const activeBooking = await Booking.findOne({
      customerId: user._id,
      status: { $in: ['pending', 'confirmed'] },
      scheduledAt: { $gte: new Date() },
    });
    if (activeBooking) {
      throw createHttpError('You have active upcoming bookings. Please cancel them or use a separate email address for your technician account.', 409, 'ACTIVE_BOOKINGS');
    }

    user.role = 'technician';
    user.status = 'pending';
    await user.save();
    invalidateUserStatusCache(user._id.toString());

    let profile = await TechnicianProfile.findOne({ userId: user._id });
    if (!profile) {
      profile = await TechnicianProfile.create({
        userId: user._id,
        displayName: user.fullName,
        phone: user.phone,
        skills: { categoryIds: [], serviceIds: [] },
        serviceArea: { zipCodes: [] },
        documents: [],
        verificationStatus: 'draft',
        availability: { isOnline: false, weeklySchedule: [], timeOff: [] },
        statusHistory: [
          {
            status: 'draft',
            by: user._id.toString(),
            at: new Date(),
            note: 'Existing customer converted to technician application',
          },
        ],
      });
    }

    return profile;
  }

  /**
   * Get technician's own profile.
   */
  static async getMe(userId: string) {
    const user = await User.findById(userId);
    if (!user) {
      throw createHttpError('User not found', 404, 'NOT_FOUND');
    }

    let profile = await TechnicianProfile.findOne({ userId });
    if (!profile) {
      // Auto-create draft profile if user is technician
      profile = await TechnicianProfile.create({
        userId: user._id,
        displayName: user.fullName,
        phone: user.phone,
        skills: { categoryIds: [], serviceIds: [] },
        serviceArea: { zipCodes: [] },
        documents: [],
        verificationStatus: 'draft',
        availability: { isOnline: false, weeklySchedule: [], timeOff: [] },
        statusHistory: [
          {
            status: 'draft',
            by: user._id.toString(),
            at: new Date(),
            note: 'Profile initialized',
          },
        ],
      });
    }

    return {
      profile,
      user: {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        role: user.role,
        status: user.status,
        emailVerified: user.emailVerified,
      },
    };
  }

  /**
   * Update technician profile details.
   */
  static async updateMe(
    userId: string,
    data: {
      displayName?: string;
      bio?: string;
      photoUrl?: string;
      phone?: string;
      vehicleInfo?: { type?: string; plate?: string; capacity?: string };
    }
  ) {
    const profile = await TechnicianProfile.findOne({ userId });
    if (!profile) {
      throw createHttpError('Technician profile not found', 404, 'NOT_FOUND');
    }

    if (data.displayName !== undefined) profile.displayName = data.displayName.trim();
    if (data.bio !== undefined) profile.bio = data.bio.trim();
    if (data.photoUrl !== undefined) profile.photoUrl = data.photoUrl;
    if (data.phone !== undefined) profile.phone = data.phone.trim();
    if (data.vehicleInfo !== undefined) {
      profile.vehicleInfo = {
        ...profile.vehicleInfo,
        ...data.vehicleInfo,
      };
    }

    await profile.save();
    return profile;
  }

  /**
   * Update skills (categories and services).
   */
  static async updateSkills(
    userId: string,
    data: { categoryIds: string[]; serviceIds?: string[] }
  ) {
    const profile = await TechnicianProfile.findOne({ userId });
    if (!profile) {
      throw createHttpError('Technician profile not found', 404, 'NOT_FOUND');
    }

    profile.skills.categoryIds = data.categoryIds.map((id) => new mongoose.Types.ObjectId(id));
    profile.skills.serviceIds = (data.serviceIds || []).map((id) => new mongoose.Types.ObjectId(id));

    await profile.save();
    return profile;
  }

  /**
   * Update service area.
   */
  static async updateServiceArea(
    userId: string,
    data: { zipCodes: string[]; city?: string; state?: string; radiusKm?: number }
  ) {
    const profile = await TechnicianProfile.findOne({ userId });
    if (!profile) {
      throw createHttpError('Technician profile not found', 404, 'NOT_FOUND');
    }

    profile.serviceArea.zipCodes = data.zipCodes;
    if (data.city !== undefined) profile.serviceArea.city = data.city;
    if (data.state !== undefined) profile.serviceArea.state = data.state;
    if (data.radiusKm !== undefined) profile.serviceArea.radiusKm = data.radiusKm;

    await profile.save();
    return profile;
  }

  /**
   * Update weekly schedule and time off.
   */
  static async updateAvailability(
    userId: string,
    data: { weeklySchedule?: Array<{ day: DayOfWeek; from: string; to: string }>; timeOff?: Array<{ from: Date; to: Date; reason?: string }> }
  ) {
    const profile = await TechnicianProfile.findOne({ userId });
    if (!profile) {
      throw createHttpError('Technician profile not found', 404, 'NOT_FOUND');
    }

    if (data.weeklySchedule !== undefined) {
      profile.availability.weeklySchedule = data.weeklySchedule;
    }
    if (data.timeOff !== undefined) {
      profile.availability.timeOff = data.timeOff;
    }

    await profile.save();
    return profile;
  }

  /**
   * Submit application for review.
   */
  static async submitApplication(userId: string) {
    const user = await User.findById(userId);
    const profile = await TechnicianProfile.findOne({ userId });
    if (!user || !profile) {
      throw createHttpError('Technician profile not found', 404, 'NOT_FOUND');
    }

    // State machine check
    if (!['draft', 'rejected'].includes(profile.verificationStatus)) {
      throw createHttpError(`Cannot submit application from current status '${profile.verificationStatus}'`, 400, 'INVALID_STATE');
    }

    // Required checks
    // 1. Required document types
    const uploadedTypes = new Set(profile.documents.map((d: ITechnicianDocument) => d.type));
    for (const reqType of REQUIRED_DOCUMENT_TYPES) {
      if (!uploadedTypes.has(reqType)) {
        throw createHttpError(`Missing required document: '${reqType}'. Please upload all required documents.`, 400, 'MISSING_REQUIRED_DOCUMENT');
      }
    }

    // 2. >= 1 skill category
    if (!profile.skills?.categoryIds || profile.skills.categoryIds.length === 0) {
      throw createHttpError('Please select at least one service category skill', 400, 'MISSING_SKILLS');
    }

    // 3. Service area zip codes
    if (!profile.serviceArea?.zipCodes || profile.serviceArea.zipCodes.length === 0) {
      throw createHttpError('Please provide at least one zip code in your service area', 400, 'MISSING_SERVICE_AREA');
    }

    profile.verificationStatus = 'pending_review';
    profile.statusHistory.push({
      status: 'pending_review',
      by: user._id.toString(),
      at: new Date(),
      note: 'Application submitted for admin review',
    });

    await profile.save();

    // Send emails
    const frontendUrl = getBaseFrontendUrl();
    const adminUrl = `${frontendUrl}/admin`;

    sendEmail({
      to: user.email,
      subject: 'Technician Application Received - Global Integrated Support',
      html: getTechApplicationReceivedEmail({ fullName: user.fullName }),
    }).catch((emailErr) => {
      logger.error({ err: emailErr }, 'Failed to send application received email');
    });

    const adminEmail = process.env.ADMIN_EMAIL || process.env.STACKMAIL_USER;
    if (adminEmail) {
      sendEmail({
        to: adminEmail,
        subject: 'New Technician Application Waiting for Review',
        html: getTechNewApplicationAdminEmail({
          techName: user.fullName,
          techEmail: user.email,
          adminUrl,
        }),
      }).catch((emailErr) => {
        logger.error({ err: emailErr }, 'Failed to send admin application notification email');
      });
    }

    return profile;
  }

  /**
   * Helper to resolve technician profile by profile ID or user ID.
   */
  private static async findProfileByIdOrUserId(id: string): Promise<ITechnicianProfile> {
    const isObjectId = mongoose.Types.ObjectId.isValid(id);
    if (!isObjectId) {
      throw createHttpError('Invalid technician identifier', 400, 'INVALID_ID');
    }

    let profile = await TechnicianProfile.findById(id);
    if (!profile) {
      profile = await TechnicianProfile.findOne({ userId: id });
    }

    if (!profile) {
      throw createHttpError('Technician profile not found', 404, 'NOT_FOUND');
    }

    return profile;
  }

  /**
   * Admin approves technician application.
   */
  static async approveApplication(technicianId: string, adminUserId: string) {
    const profile = await this.findProfileByIdOrUserId(technicianId);

    const allowed = VALID_STATE_TRANSITIONS[profile.verificationStatus];
    if (!allowed || !allowed.includes('approved')) {
      throw createHttpError(`Cannot transition application from '${profile.verificationStatus}' to 'approved'`, 400, 'INVALID_STATE_TRANSITION');
    }

    profile.verificationStatus = 'approved';
    profile.rejectionReason = undefined;
    profile.statusHistory.push({
      status: 'approved',
      by: adminUserId,
      at: new Date(),
      note: 'Technician verified and approved',
    });
    await profile.save();

    // Activate user
    const user = await User.findById(profile.userId);
    if (user) {
      user.status = 'active';
      user.isActive = true;
      await user.save();
      invalidateUserStatusCache(user._id.toString());

      const frontendUrl = getBaseFrontendUrl();
      const portalUrl = `${frontendUrl}/tech`;

      try {
        await sendEmail({
          to: user.email,
          subject: 'Technician Application Approved - Global Integrated Support',
          html: getTechApprovedEmail({ fullName: user.fullName, portalUrl }),
        });
      } catch (emailErr) {
        logger.error({ err: emailErr }, 'Failed to send approval email');
      }
    }

    return profile;
  }

  /**
   * Admin rejects technician application.
   */
  static async rejectApplication(technicianId: string, adminUserId: string, reason: string) {
    const profile = await this.findProfileByIdOrUserId(technicianId);

    const allowed = VALID_STATE_TRANSITIONS[profile.verificationStatus];
    if (!allowed || !allowed.includes('rejected')) {
      throw createHttpError(`Cannot transition application from '${profile.verificationStatus}' to 'rejected'`, 400, 'INVALID_STATE_TRANSITION');
    }

    profile.verificationStatus = 'rejected';
    profile.rejectionReason = reason;
    profile.activeSchedule = [];
    profile.statusHistory.push({
      status: 'rejected',
      by: adminUserId,
      at: new Date(),
      note: `Rejected: ${reason}`,
    });
    await profile.save();

    const user = await User.findById(profile.userId);
    if (user) {
      const frontendUrl = getBaseFrontendUrl();
      const portalUrl = `${frontendUrl}/tech`;

      try {
        await sendEmail({
          to: user.email,
          subject: 'Technician Application Status Update - Global Integrated Support',
          html: getTechRejectedEmail({ fullName: user.fullName, reason, portalUrl }),
        });
      } catch (emailErr) {
        logger.error({ err: emailErr }, 'Failed to send rejection email');
      }
    }

    return profile;
  }

  /**
   * Admin suspends technician.
   */
  static async suspendTechnician(technicianId: string, adminUserId: string, reason: string) {
    const profile = await this.findProfileByIdOrUserId(technicianId);

    const allowed = VALID_STATE_TRANSITIONS[profile.verificationStatus];
    if (!allowed || !allowed.includes('suspended')) {
      throw createHttpError(`Cannot transition application from '${profile.verificationStatus}' to 'suspended'`, 400, 'INVALID_STATE_TRANSITION');
    }

    profile.verificationStatus = 'suspended';
    profile.availability.isOnline = false;
    profile.rejectionReason = reason;
    profile.activeSchedule = [];
    profile.statusHistory.push({
      status: 'suspended',
      by: adminUserId,
      at: new Date(),
      note: `Suspended: ${reason}`,
    });
    await profile.save();

    const user = await User.findById(profile.userId);
    if (user) {
      user.status = 'suspended';
      user.isActive = false;
      await user.save();
      invalidateUserStatusCache(user._id.toString());
      realtimeEmitter.disconnectUserSockets(user._id.toString());

      // Revoke all refresh tokens
      await RefreshToken.updateMany(
        { userId: user._id, revoked: false },
        { $set: { revoked: true, revokedAt: new Date() } }
      );

      try {
        await sendEmail({
          to: user.email,
          subject: 'Technician Account Suspended - Global Integrated Support',
          html: getTechSuspendedEmail({ fullName: user.fullName, reason }),
        });
      } catch (emailErr) {
        logger.error({ err: emailErr }, 'Failed to send suspension email');
      }
    }

    return profile;
  }

  /**
   * Admin reinstates technician.
   */
  static async reinstateTechnician(technicianId: string, adminUserId: string) {
    const profile = await this.findProfileByIdOrUserId(technicianId);

    const allowed = VALID_STATE_TRANSITIONS[profile.verificationStatus];
    if (!allowed || !allowed.includes('approved')) {
      throw createHttpError(`Cannot transition application from '${profile.verificationStatus}' to 'approved'`, 400, 'INVALID_STATE_TRANSITION');
    }

    profile.verificationStatus = 'approved';
    profile.rejectionReason = undefined;
    profile.statusHistory.push({
      status: 'approved',
      by: adminUserId,
      at: new Date(),
      note: 'Reinstated by admin',
    });
    await profile.save();

    const user = await User.findById(profile.userId);
    if (user) {
      user.status = 'active';
      user.isActive = true;
      await user.save();
      invalidateUserStatusCache(user._id.toString());

      const frontendUrl = getBaseFrontendUrl();
      const portalUrl = `${frontendUrl}/tech`;

      try {
        await sendEmail({
          to: user.email,
          subject: 'Technician Account Reinstated - Global Integrated Support',
          html: getTechReinstatedEmail({ fullName: user.fullName, portalUrl }),
        });
      } catch (emailErr) {
        logger.error({ err: emailErr }, 'Failed to send reinstatement email');
      }
    }

    return profile;
  }

  /**
   * Upload technician document.
   */
  static async uploadDocument(
    userId: string,
    buffer: Buffer,
    mimeType: string,
    type: DocumentType,
    expiresAt?: Date
  ) {
    checkUploadRateLimit(userId);

    const profile = await TechnicianProfile.findOne({ userId });
    if (!profile) {
      throw createHttpError('Technician profile not found', 404, 'NOT_FOUND');
    }

    if (profile.documents.length >= 10) {
      throw createHttpError('Maximum of 10 documents reached', 400, 'DOCUMENT_LIMIT_REACHED');
    }

    // Validate file type, size and magic bytes
    try {
      await validateFileBuffer(buffer, mimeType);
    } catch (valErr: unknown) {
      const errInfo = valErr as { message?: string; code?: string };
      throw createHttpError(errInfo.message || 'Invalid file', 400, errInfo.code || 'INVALID_FILE');
    }

    // Upload to Cloudinary (authenticated mode)
    const { publicId, resourceType } = await uploadToStorage(buffer, mimeType, userId);

    const newDoc = {
      _id: new mongoose.Types.ObjectId(),
      type,
      storageRef: publicId,
      resourceType,
      status: 'pending' as const,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    };

    profile.documents.push(newDoc as unknown as ITechnicianDocument);
    await profile.save();

    return {
      _id: newDoc._id,
      type: newDoc.type,
      status: newDoc.status,
      expiresAt: newDoc.expiresAt,
    };
  }

  /**
   * Delete technician document.
   */
  static async deleteDocument(userId: string, docId: string) {
    const profile = await TechnicianProfile.findOne({ userId }).select('+documents.storageRef');
    if (!profile) {
      throw createHttpError('Technician profile not found', 404, 'NOT_FOUND');
    }

    if (profile.verificationStatus === 'approved') {
      throw createHttpError('Cannot delete documents once your profile has been approved', 403, 'FORBIDDEN');
    }

    const docIndex = profile.documents.findIndex(
      (d: ITechnicianDocument) => d._id.toString() === docId.toString()
    );
    if (docIndex === -1) {
      throw createHttpError('Document not found', 404, 'NOT_FOUND');
    }

    const doc = profile.documents[docIndex];
    if (doc.status === 'approved') {
      throw createHttpError('Cannot delete an already approved document', 403, 'FORBIDDEN');
    }

    // Delete from Cloudinary
    try {
      await deleteFromStorage(doc.storageRef, doc.resourceType || 'image');
    } catch (storageErr) {
      logger.error({ err: storageErr }, 'Failed to delete document from storage');
    }

    profile.documents.splice(docIndex, 1);
    await profile.save();

    return { success: true, message: 'Document deleted successfully' };
  }

  /**
   * Generate signed URL for document viewing (expires in 5 minutes).
   */
  static async getSignedDocumentUrl(
    docId: string,
    requestingUser: { userId: string; role: string },
    technicianId?: string
  ): Promise<{ url: string; expiresAt: number }> {
    let query: Record<string, unknown> = {};
    if (requestingUser.role === 'admin') {
      if (technicianId) {
        if (mongoose.Types.ObjectId.isValid(technicianId)) {
          query = {
            $or: [
              { _id: new mongoose.Types.ObjectId(technicianId) },
              { userId: new mongoose.Types.ObjectId(technicianId) },
            ],
          };
        } else {
          query = { userId: technicianId };
        }
      } else {
        query = { 'documents._id': new mongoose.Types.ObjectId(docId) };
      }
    } else {
      // Technician requesting their own document
      query = { userId: new mongoose.Types.ObjectId(requestingUser.userId) };
    }

    const profile = await TechnicianProfile.findOne(query).select('+documents.storageRef');
    if (!profile) {
      throw createHttpError('Document not found', 404, 'NOT_FOUND');
    }

    const doc = profile.documents.find((d: ITechnicianDocument) => d._id.toString() === docId.toString());
    if (!doc || !doc.storageRef) {
      throw createHttpError('Document record not found', 404, 'NOT_FOUND');
    }

    const signedUrl = generateSignedUrl(doc.storageRef, doc.resourceType || 'image');
    const expiresAt = Math.floor(Date.now() / 1000) + 300;

    // Audit log admin document views without logging the URL
    if (requestingUser.role === 'admin') {
      logger.info(
        {
          auditEvent: 'admin_document_view',
          viewedByUserId: requestingUser.userId,
          role: requestingUser.role,
          docId: docId.toString(),
          technicianUserId: profile.userId.toString(),
          viewedAt: new Date().toISOString(),
        },
        'Admin/dispatcher viewed technician document'
      );
    }

    return { url: signedUrl, expiresAt };
  }

  /**
   * Admin approves a specific document.
   */
  static async approveDocument(
    technicianId: string,
    docId: string,
    adminUserId: string,
    note?: string
  ) {
    const profile = await this.findProfileByIdOrUserId(technicianId);

    const doc = profile.documents.find((d: ITechnicianDocument) => d._id.toString() === docId.toString());
    if (!doc) {
      throw createHttpError('Document not found', 404, 'NOT_FOUND');
    }

    doc.status = 'approved';
    doc.reviewedBy = new mongoose.Types.ObjectId(adminUserId);
    doc.reviewedAt = new Date();
    if (note) doc.note = note;

    await profile.save();
    return doc;
  }

  /**
   * Admin rejects a specific document.
   */
  static async rejectDocument(
    technicianId: string,
    docId: string,
    adminUserId: string,
    note: string
  ) {
    const profile = await this.findProfileByIdOrUserId(technicianId);

    const doc = profile.documents.find((d: ITechnicianDocument) => d._id.toString() === docId.toString());
    if (!doc) {
      throw createHttpError('Document not found', 404, 'NOT_FOUND');
    }

    doc.status = 'rejected';
    doc.reviewedBy = new mongoose.Types.ObjectId(adminUserId);
    doc.reviewedAt = new Date();
    doc.note = note;

    await profile.save();

    // Send email to technician
    const user = await User.findById(profile.userId);
    if (user) {
      sendEmail({
        to: user.email,
        subject: `Document Rejected: ${doc.type.toUpperCase()} - Action Required`,
        html: getTechDocumentRejectedEmail({
          fullName: user.fullName,
          docType: doc.type,
          note,
        }),
      }).catch((emailErr) => {
        logger.error({ err: emailErr }, 'Failed to send document rejection email');
      });
    }

    return doc;
  }

  /**
   * Toggle online status.
   */
  static async setOnline(userId: string, isOnline: boolean) {
    const user = await User.findById(userId);
    const profile = await TechnicianProfile.findOne({ userId });

    if (!user || !profile) {
      throw createHttpError('Technician profile not found', 404, 'NOT_FOUND');
    }

    if (isOnline) {
      if (profile.verificationStatus !== 'approved') {
        throw createHttpError('Account must be approved before going online', 403, 'FORBIDDEN');
      }
      if (!user.emailVerified) {
        throw createHttpError('Email must be verified before going online', 403, 'EMAIL_NOT_VERIFIED');
      }
    }

    profile.availability.isOnline = isOnline;
    await profile.save();

    return { isOnline: profile.availability.isOnline };
  }

  /**
   * Cron job: check document expiration and send email alerts.
   */
  static async runDocumentExpiryCheck(): Promise<{ notifiedExpiring: number; notifiedExpired: number }> {
    const now = new Date();
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 3600 * 1000);

    let notifiedExpiring = 0;
    let notifiedExpired = 0;

    // Find profiles with documents that have expiresAt
    const profiles = await TechnicianProfile.find({
      'documents.expiresAt': { $exists: true, $ne: null },
    });

    for (const profile of profiles) {
      let profileUpdated = false;
      const user = await User.findById(profile.userId);
      if (!user) continue;

      for (const doc of profile.documents) {
        if (!doc.expiresAt) continue;

        const expiresDate = new Date(doc.expiresAt);

        // 1. Expired
        if (expiresDate < now && !doc.expiryNotifiedAt) {
          try {
            await sendEmail({
              to: user.email,
              subject: `Urgent: Your ${doc.type.toUpperCase()} Document Has Expired`,
              html: getTechDocumentExpiredEmail({
                fullName: user.fullName,
                docType: doc.type,
              }),
            });
            doc.expiryNotifiedAt = now;
            profileUpdated = true;
            notifiedExpired += 1;
          } catch (err) {
            logger.error({ err }, 'Failed to send document expired email');
          }
        }
        // 2. Expiring within 30 days
        else if (expiresDate <= thirtyDaysFromNow && expiresDate >= now && !doc.expiryNotifiedAt) {
          const daysLeft = Math.ceil((expiresDate.getTime() - now.getTime()) / (24 * 3600 * 1000));
          try {
            await sendEmail({
              to: user.email,
              subject: `Reminder: Your ${doc.type.toUpperCase()} Document Will Expire in ${daysLeft} Days`,
              html: getTechDocumentExpiringEmail({
                fullName: user.fullName,
                docType: doc.type,
                daysLeft,
              }),
            });
            doc.expiryNotifiedAt = now;
            profileUpdated = true;
            notifiedExpiring += 1;
          } catch (err) {
            logger.error({ err }, 'Failed to send document expiring email');
          }
        }
      }

      if (profileUpdated) {
        await profile.save();
      }
    }

    return { notifiedExpiring, notifiedExpired };
  }

  /**
   * List technicians with filtering and pagination (admin/dispatcher).
   */
  static async listTechnicians(filters: {
    status?: string;
    category?: string;
    zip?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(filters.limit) || 20));
    const skip = (page - 1) * limit;

    const profileQuery: Record<string, unknown> = {};
    if (filters.status) {
      profileQuery.verificationStatus = filters.status;
    }
    if (filters.category && mongoose.Types.ObjectId.isValid(filters.category)) {
      profileQuery['skills.categoryIds'] = new mongoose.Types.ObjectId(filters.category);
    }
    if (filters.zip) {
      profileQuery['serviceArea.zipCodes'] = filters.zip;
    }

    if (filters.search) {
      const searchRegex = new RegExp(filters.search.trim(), 'i');
      const matchingUsers = await User.find({
        role: 'technician',
        $or: [{ fullName: searchRegex }, { email: searchRegex }],
      }).select('_id');

      const userIds = matchingUsers.map((u) => u._id);
      profileQuery.$or = [
        { displayName: searchRegex },
        { userId: { $in: userIds } },
      ];
    }

    const [profiles, total] = await Promise.all([
      TechnicianProfile.find(profileQuery)
        .populate('userId', 'email fullName phone status emailVerified')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      TechnicianProfile.countDocuments(profileQuery),
    ]);

    return {
      technicians: profiles,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get technician profile by ID (admin/dispatcher).
   */
  static async getTechnician(id: string) {
    const profile = await this.findProfileByIdOrUserId(id);
    const user = await User.findById(profile.userId).select('email fullName phone status emailVerified');
    return {
      profile,
      user,
    };
  }

  /**
   * Admin patch skills and/or service area.
   */
  static async adminPatch(
    id: string,
    adminUserId: string,
    data: {
      skills?: { categoryIds?: string[]; serviceIds?: string[] };
      serviceArea?: { zipCodes?: string[]; city?: string; state?: string };
    }
  ) {
    const profile = await this.findProfileByIdOrUserId(id);

    if (data.skills?.categoryIds) {
      profile.skills.categoryIds = data.skills.categoryIds.map(
        (cid) => new mongoose.Types.ObjectId(cid)
      );
    }
    if (data.skills?.serviceIds) {
      profile.skills.serviceIds = data.skills.serviceIds.map(
        (sid) => new mongoose.Types.ObjectId(sid)
      );
    }
    if (data.serviceArea?.zipCodes) {
      profile.serviceArea.zipCodes = data.serviceArea.zipCodes;
    }
    if (data.serviceArea?.city !== undefined) {
      profile.serviceArea.city = data.serviceArea.city;
    }
    if (data.serviceArea?.state !== undefined) {
      profile.serviceArea.state = data.serviceArea.state;
    }

    profile.statusHistory.push({
      status: profile.verificationStatus,
      by: adminUserId,
      at: new Date(),
      note: 'Profile skills / service area updated by admin',
    });

    await profile.save();
    return profile;
  }

  /**
   * Get jobs (bookings) assigned to technician.
   */
  static async getTechnicianJobs(technicianId: string, page = 1, limit = 20) {
    const profile = await this.findProfileByIdOrUserId(technicianId);
    const skip = (Math.max(1, page) - 1) * Math.max(1, limit);

    // Bookings can reference either profile._id or user._id
    const query = {
      $or: [
        { technicianId: profile._id },
        { technicianId: profile.userId },
      ],
    };

    const [jobs, total] = await Promise.all([
      Booking.find(query).sort({ scheduledAt: -1 }).skip(skip).limit(limit),
      Booking.countDocuments(query),
    ]);

    return {
      jobs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Admin: List customers with booking counts.
   */
  static async listCustomers(filters: {
    search?: string;
    status?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(filters.limit) || 20));
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = { role: 'customer' };
    if (filters.status) {
      query.status = filters.status;
    }
    if (filters.search) {
      const regex = new RegExp(filters.search.trim(), 'i');
      query.$or = [{ fullName: regex }, { email: regex }, { phone: regex }];
    }

    const [users, total] = await Promise.all([
      User.find(query)
        .select('fullName email phone status isActive emailVerified createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(query),
    ]);

    // Aggregate booking counts
    const userIds = users.map((u) => u._id);
    const bookingCounts = await Booking.aggregate([
      { $match: { customerId: { $in: userIds } } },
      { $group: { _id: '$customerId', count: { $sum: 1 } } },
    ]);

    const countMap = new Map<string, number>();
    for (const item of bookingCounts) {
      countMap.set(item._id.toString(), item.count);
    }

    const customersWithCount = users.map((u) => ({
      ...u,
      bookingCount: countMap.get(u._id.toString()) || 0,
    }));

    return {
      customers: customersWithCount,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Admin: Suspend customer.
   */
  static async suspendCustomer(customerId: string, _adminUserId: string, _reason?: string) {
    const user = await User.findById(customerId);
    if (!user) {
      throw createHttpError('Customer not found', 404, 'NOT_FOUND');
    }

    user.status = 'suspended';
    user.isActive = false;
    await user.save();
    invalidateUserStatusCache(user._id.toString());
    realtimeEmitter.disconnectUserSockets(user._id.toString());

    // Revoke all refresh tokens
    await RefreshToken.updateMany(
      { userId: user._id, revoked: false },
      { $set: { revoked: true, revokedAt: new Date() } }
    );

    return { success: true, message: 'Customer suspended successfully', user };
  }

  /**
   * Admin: Reinstate customer.
   */
  static async reinstateCustomer(customerId: string, _adminUserId: string) {
    const user = await User.findById(customerId);
    if (!user) {
      throw createHttpError('Customer not found', 404, 'NOT_FOUND');
    }

    user.status = 'active';
    user.isActive = true;
    await user.save();
    invalidateUserStatusCache(user._id.toString());

    return { success: true, message: 'Customer reinstated successfully', user };
  }
}
