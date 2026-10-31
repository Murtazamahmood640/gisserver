import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { User, IUser } from '../../models/User';
import {
  SupplierProfile,
  ISupplierProfile,
  ISupplierDocument,
  SupplierBusinessType,
  SupplierDocumentType,
  SupplierVerificationStatus,
} from '../../models/SupplierProfile';
import { invalidateUserStatusCache } from '../../middleware/auth';
import {
  uploadDocument as uploadToStorage,
  deleteDocument as deleteFromStorage,
  generateSignedUrl,
  validateFileBuffer,
} from '../../services/storageService';
import {
  sendEmail,
  getEmailVerificationEmail,
  getSupplierApplicationReceivedEmail,
  getSupplierNewApplicationAdminEmail,
  getSupplierApprovedEmail,
  getSupplierRejectedEmail,
  getSupplierSuspendedEmail,
  getSupplierReinstatedEmail,
  getSupplierDocumentRejectedEmail,
} from '../../services/emailService';
import { generateEmailVerificationToken } from '../../utils/jwt';
import { createHttpError } from '../../utils/httpErrors';
import logger from '../../config/logger';

// Document types allowed for suppliers
export const SUPPLIER_DOCUMENT_TYPES: SupplierDocumentType[] = [
  'business_license',
  'tax_certificate',
  'insurance',
  'id',
  'other',
];

const VALID_STATE_TRANSITIONS: Record<SupplierVerificationStatus, SupplierVerificationStatus[]> = {
  draft: ['pending_review'],
  pending_review: ['approved', 'rejected'],
  approved: ['suspended'],
  rejected: ['pending_review'],
  suspended: ['approved'],
};

// Upload rate limiter bucket
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

function sanitizeSupplierProfile(profile: ISupplierProfile | null): any {
  if (!profile) return null;
  const doc = profile.toObject ? profile.toObject() : { ...profile };
  if (Array.isArray(doc.documents)) {
    doc.documents = doc.documents.map((d: any) => {
      const { storageRef, ...rest } = d;
      return rest;
    });
  }
  return doc;
}

export class SupplierService {
  /**
   * Helper to find supplier profile by profile._id OR profile.userId.
   */
  static async findProfileByIdOrUserId(id: string): Promise<ISupplierProfile> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw createHttpError('Invalid supplier identifier', 400, 'INVALID_ID');
    }
    const profile = await SupplierProfile.findOne({
      $or: [{ _id: id }, { userId: id }],
    });
    if (!profile) {
      throw createHttpError('Supplier profile not found', 404, 'NOT_FOUND');
    }
    return profile;
  }

  /**
   * Register a new supplier account (role='supplier', status='pending', verificationStatus='draft').
   */
  static async registerSupplier(data: {
    email: string;
    password: string;
    fullName: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    companyName: string;
    tradingName?: string;
    businessRegistrationNumber?: string;
    businessType: SupplierBusinessType;
    taxId?: string;
    website?: string;
    description?: string;
    businessPhone?: string;
    supportEmail?: string;
    businessAddress?: {
      street?: string;
      city?: string;
      state?: string;
      zipCode?: string;
      country?: string;
    };
    dispatchWarehouseAddress?: {
      street?: string;
      city?: string;
      state?: string;
      zipCode?: string;
      country?: string;
    };
    categories?: string[];
    brandsSpecialized?: string[];
    estimatedSkuCount?: number;
    catalogMethod?: 'manual' | 'csv' | 'api';
    willCallPickupAllowed?: boolean;
    orderCutoffTime?: string;
    fulfillmentLeadTimeHours?: number;
    warrantyPeriod?: string;
    returnWindowDays?: number;
    restockingFeePercent?: number;
    payoutDetails?: {
      accountHolderName?: string;
      bankName?: string;
      accountNumberLast4?: string;
      routingNumber?: string;
    };
  }): Promise<{ user: Partial<IUser>; profile: any }> {
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
      data.companyName.trim();
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
      role: 'supplier',
      status: 'pending',
      isActive: true,
      emailVerified: false,
    });

    const profile = await SupplierProfile.create({
      userId: user._id,
      companyName: data.companyName.trim(),
      tradingName: data.tradingName?.trim(),
      businessRegistrationNumber: data.businessRegistrationNumber?.trim(),
      businessType: data.businessType,
      taxId: data.taxId?.trim(),
      website: data.website?.trim(),
      description: data.description?.trim(),
      categories: data.categories || [],
      brandsSpecialized: data.brandsSpecialized || [],
      estimatedSkuCount: data.estimatedSkuCount || 0,
      catalogMethod: data.catalogMethod || 'manual',
      dispatchWarehouseAddress: data.dispatchWarehouseAddress || data.businessAddress || {},
      willCallPickupAllowed: Boolean(data.willCallPickupAllowed),
      orderCutoffTime: data.orderCutoffTime || '15:00',
      fulfillmentLeadTimeHours: data.fulfillmentLeadTimeHours ?? 24,
      warrantyPeriod: data.warrantyPeriod || '1_year',
      returnWindowDays: data.returnWindowDays ?? 30,
      restockingFeePercent: data.restockingFeePercent ?? 0,
      payoutDetails: data.payoutDetails || {},
      contactPerson: {
        name: resolvedFullName,
        phone: data.phone?.trim(),
        email: normalizedEmail,
      },
      businessPhone: data.businessPhone?.trim() || data.phone?.trim(),
      supportEmail: data.supportEmail?.trim() || normalizedEmail,
      businessAddress: data.businessAddress || {},
      documents: [],
      verificationStatus: 'draft',
      statusHistory: [
        {
          status: 'draft',
          by: user._id.toString(),
          at: new Date(),
          note: 'Supplier account registered',
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
      logger.error({ err: emailErr }, 'Failed to send supplier email verification');
    });

    // Send supplier received acknowledgement
    sendEmail({
      to: user.email,
      subject: 'Supplier Application Received - Global Integrated Support',
      html: getSupplierApplicationReceivedEmail({ companyName: profile.companyName }),
    }).catch((emailErr) => {
      logger.error({ err: emailErr }, 'Failed to send supplier welcome email');
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
      profile: sanitizeSupplierProfile(profile),
    };
  }

  /**
   * Apply for supplier from an existing user account (converts customer to supplier role).
   */
  static async applyForSupplier(
    userId: string,
    data: {
      companyName: string;
      businessType: SupplierBusinessType;
      taxId?: string;
      website?: string;
      description?: string;
      businessPhone?: string;
      supportEmail?: string;
      businessAddress?: {
        street?: string;
        city?: string;
        state?: string;
        zipCode?: string;
        country?: string;
      };
      categories?: string[];
    }
  ): Promise<any> {
    const user = await User.findById(userId);
    if (!user) {
      throw createHttpError('User not found', 404, 'NOT_FOUND');
    }

    user.role = 'supplier';
    user.status = 'pending';
    await user.save();
    invalidateUserStatusCache(user._id.toString());

    let profile = await SupplierProfile.findOne({ userId: user._id });
    if (!profile) {
      profile = await SupplierProfile.create({
        userId: user._id,
        companyName: data.companyName.trim(),
        businessType: data.businessType,
        taxId: data.taxId?.trim(),
        website: data.website?.trim(),
        description: data.description?.trim(),
        categories: data.categories || [],
        contactPerson: {
          name: user.fullName,
          email: user.email,
          phone: user.phone,
        },
        businessPhone: data.businessPhone?.trim() || user.phone,
        supportEmail: data.supportEmail?.trim() || user.email,
        businessAddress: data.businessAddress || {},
        documents: [],
        verificationStatus: 'draft',
        statusHistory: [
          {
            status: 'draft',
            by: user._id.toString(),
            at: new Date(),
            note: 'Existing user applied for supplier account',
          },
        ],
      });
    }

    return sanitizeSupplierProfile(profile);
  }

  /**
   * Get authenticated supplier's own profile and user details.
   */
  static async getMe(userId: string): Promise<{ user: Partial<IUser>; profile: any }> {
    const user = await User.findById(userId).select('-password');
    if (!user) {
      throw createHttpError('User not found', 404, 'NOT_FOUND');
    }

    let profile = await SupplierProfile.findOne({ userId: user._id });
    if (!profile) {
      profile = await SupplierProfile.create({
        userId: user._id,
        companyName: user.fullName,
        businessType: 'distributor',
        documents: [],
        verificationStatus: 'draft',
        categories: [],
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
      user: {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        role: user.role,
        status: user.status,
        emailVerified: user.emailVerified,
      },
      profile: sanitizeSupplierProfile(profile),
    };
  }

  /**
   * Update authenticated supplier's profile information.
   */
  static async updateMe(userId: string, updateData: any): Promise<any> {
    const profile = await SupplierProfile.findOne({ userId });
    if (!profile) {
      throw createHttpError('Supplier profile not found', 404, 'NOT_FOUND');
    }

    if (profile.verificationStatus === 'suspended') {
      throw createHttpError('Cannot update profile while account is suspended', 403, 'ACCOUNT_SUSPENDED');
    }

    const allowedFields = [
      'companyName',
      'businessType',
      'taxId',
      'website',
      'description',
      'categories',
      'contactPerson',
      'businessPhone',
      'supportEmail',
      'businessAddress',
    ];

    for (const field of allowedFields) {
      if (updateData[field] !== undefined) {
        (profile as any)[field] = updateData[field];
      }
    }

    await profile.save();
    return sanitizeSupplierProfile(profile);
  }

  /**
   * Submit application for administrative verification (transitions draft/rejected -> pending_review).
   */
  static async submitApplication(userId: string): Promise<any> {
    const profile = await SupplierProfile.findOne({ userId });
    if (!profile) {
      throw createHttpError('Supplier profile not found', 404, 'NOT_FOUND');
    }

    const allowed = VALID_STATE_TRANSITIONS[profile.verificationStatus as SupplierVerificationStatus];
    if (!allowed || !allowed.includes('pending_review')) {
      throw createHttpError(
        `Cannot submit application from status '${profile.verificationStatus}'`,
        400,
        'INVALID_STATE_TRANSITION'
      );
    }

    profile.verificationStatus = 'pending_review';
    profile.rejectionReason = undefined;
    profile.statusHistory.push({
      status: 'pending_review',
      by: userId,
      at: new Date(),
      note: 'Supplier application submitted for administrative review',
    });
    await profile.save();

    const user = await User.findById(userId);
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@globalintegratedsupport.com';
    const frontendUrl = getBaseFrontendUrl();
    const adminUrl = `${frontendUrl}/admin/suppliers`;

    sendEmail({
      to: adminEmail,
      subject: `New Supplier Application - ${profile.companyName}`,
      html: getSupplierNewApplicationAdminEmail({
        companyName: profile.companyName,
        supplierEmail: user?.email || '',
        adminUrl,
      }),
    }).catch((emailErr) => {
      logger.error({ err: emailErr }, 'Failed to send admin supplier submission notification');
    });

    return sanitizeSupplierProfile(profile);
  }

  /**
   * Upload a verification document.
   */
  static async uploadDocument(
    userId: string,
    buffer: Buffer,
    mimeType: string,
    type: SupplierDocumentType,
    fileName?: string,
    expiresAt?: Date
  ): Promise<any> {
    checkUploadRateLimit(userId);

    const profile = await SupplierProfile.findOne({ userId });
    if (!profile) {
      throw createHttpError('Supplier profile not found', 404, 'NOT_FOUND');
    }

    if (profile.documents.length >= 10) {
      throw createHttpError('Maximum of 10 documents reached', 400, 'DOCUMENT_LIMIT_REACHED');
    }

    // Validate file type and magic bytes
    try {
      await validateFileBuffer(buffer, mimeType);
    } catch (valErr: unknown) {
      const errInfo = valErr as { message?: string; code?: string };
      throw createHttpError(errInfo.message || 'Invalid file', 400, errInfo.code || 'INVALID_FILE');
    }

    // Upload to authenticated storage
    const uploadResult = await uploadToStorage(buffer, mimeType, `suppliers/${userId}`);

    const newDocId = new mongoose.Types.ObjectId();
    const docEntry: ISupplierDocument = {
      _id: newDocId,
      type,
      storageRef: uploadResult.publicId,
      resourceType: uploadResult.resourceType,
      fileName,
      status: 'pending',
      expiresAt,
    };

    profile.documents.push(docEntry);
    await profile.save();

    return {
      _id: docEntry._id,
      type: docEntry.type,
      fileName: docEntry.fileName,
      status: docEntry.status,
      expiresAt: docEntry.expiresAt,
    };
  }

  /**
   * Delete a verification document.
   */
  static async deleteDocument(userId: string, docId: string): Promise<void> {
    const profile = await SupplierProfile.findOne({ userId }).select('+documents.storageRef');
    if (!profile) {
      throw createHttpError('Supplier profile not found', 404, 'NOT_FOUND');
    }

    const docIndex = profile.documents.findIndex((d: ISupplierDocument) => d._id.toString() === docId);
    if (docIndex === -1) {
      throw createHttpError('Document not found', 404, 'NOT_FOUND');
    }

    const doc = profile.documents[docIndex];
    if (doc.storageRef) {
      try {
        await deleteFromStorage(doc.storageRef, doc.resourceType);
      } catch (err) {
        logger.warn({ err, docId }, 'Failed to delete file from storage during document deletion');
      }
    }

    profile.documents.splice(docIndex, 1);
    await profile.save();
  }

  /**
   * Generate a temporary signed URL for the supplier to view their own document.
   */
  static async getDocumentSignedUrl(userId: string, docId: string): Promise<string> {
    const profile = await SupplierProfile.findOne({ userId }).select('+documents.storageRef');
    if (!profile) {
      throw createHttpError('Supplier profile not found', 404, 'NOT_FOUND');
    }

    const doc = profile.documents.find((d: ISupplierDocument) => d._id.toString() === docId);
    if (!doc) {
      throw createHttpError('Document not found', 404, 'NOT_FOUND');
    }

    return generateSignedUrl(doc.storageRef, doc.resourceType);
  }

  // =========================================================================
  // Administrative Operations
  // =========================================================================

  /**
   * Admin lists all suppliers with optional status filtering, search and pagination.
   */
  static async listSuppliers(query: {
    status?: string;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{ suppliers: any[]; total: number; page: number; limit: number; totalPages: number }> {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const filter: Record<string, any> = {};

    if (query.status) {
      filter.verificationStatus = query.status;
    }

    if (query.search) {
      const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { companyName: { $regex: escaped, $options: 'i' } },
        { supportEmail: { $regex: escaped, $options: 'i' } },
        { businessPhone: { $regex: escaped, $options: 'i' } },
        { 'contactPerson.name': { $regex: escaped, $options: 'i' } },
      ];
    }

    const [profiles, total] = await Promise.all([
      SupplierProfile.find(filter)
        .populate('userId', 'email fullName phone status isActive emailVerified')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      SupplierProfile.countDocuments(filter),
    ]);

    const sanitized = profiles.map((p: any) => {
      if (Array.isArray(p.documents)) {
        p.documents = p.documents.map((d: any) => {
          const { storageRef, ...rest } = d;
          return rest;
        });
      }
      return p;
    });

    return {
      suppliers: sanitized,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Admin retrieves a supplier profile by ID.
   */
  static async getSupplierById(supplierId: string): Promise<any> {
    const profile = await this.findProfileByIdOrUserId(supplierId);
    await profile.populate('userId', 'email fullName phone status isActive emailVerified lastLoginAt');
    return sanitizeSupplierProfile(profile);
  }

  /**
   * Admin approves a supplier application.
   */
  static async approveSupplier(supplierId: string, adminUserId: string): Promise<any> {
    const profile = await this.findProfileByIdOrUserId(supplierId);

    const allowed = VALID_STATE_TRANSITIONS[profile.verificationStatus as SupplierVerificationStatus];
    if (!allowed || !allowed.includes('approved')) {
      throw createHttpError(
        `Cannot transition supplier from '${profile.verificationStatus}' to 'approved'`,
        400,
        'INVALID_STATE_TRANSITION'
      );
    }

    profile.verificationStatus = 'approved';
    profile.rejectionReason = undefined;
    profile.suspensionReason = undefined;
    profile.statusHistory.push({
      status: 'approved',
      by: adminUserId,
      at: new Date(),
      note: 'Supplier verified and approved by admin',
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
      const portalUrl = `${frontendUrl}/supplier`;

      sendEmail({
        to: user.email,
        subject: 'Supplier Application Approved - Global Integrated Support',
        html: getSupplierApprovedEmail({ companyName: profile.companyName, portalUrl }),
      }).catch((emailErr) => {
        logger.error({ err: emailErr }, 'Failed to send supplier approval email');
      });
    }

    return sanitizeSupplierProfile(profile);
  }

  /**
   * Admin rejects a supplier application.
   */
  static async rejectSupplier(supplierId: string, adminUserId: string, reason: string): Promise<any> {
    const profile = await this.findProfileByIdOrUserId(supplierId);

    const allowed = VALID_STATE_TRANSITIONS[profile.verificationStatus as SupplierVerificationStatus];
    if (!allowed || !allowed.includes('rejected')) {
      throw createHttpError(
        `Cannot transition supplier from '${profile.verificationStatus}' to 'rejected'`,
        400,
        'INVALID_STATE_TRANSITION'
      );
    }

    profile.verificationStatus = 'rejected';
    profile.rejectionReason = reason;
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
      const portalUrl = `${frontendUrl}/supplier`;

      sendEmail({
        to: user.email,
        subject: 'Supplier Application Status Update - Global Integrated Support',
        html: getSupplierRejectedEmail({ companyName: profile.companyName, reason, portalUrl }),
      }).catch((emailErr) => {
        logger.error({ err: emailErr }, 'Failed to send supplier rejection email');
      });
    }

    return sanitizeSupplierProfile(profile);
  }

  /**
   * Admin suspends an approved supplier.
   */
  static async suspendSupplier(supplierId: string, adminUserId: string, reason: string): Promise<any> {
    const profile = await this.findProfileByIdOrUserId(supplierId);

    const allowed = VALID_STATE_TRANSITIONS[profile.verificationStatus as SupplierVerificationStatus];
    if (!allowed || !allowed.includes('suspended')) {
      throw createHttpError(
        `Cannot transition supplier from '${profile.verificationStatus}' to 'suspended'`,
        400,
        'INVALID_STATE_TRANSITION'
      );
    }

    profile.verificationStatus = 'suspended';
    profile.suspensionReason = reason;
    profile.statusHistory.push({
      status: 'suspended',
      by: adminUserId,
      at: new Date(),
      note: `Suspended: ${reason}`,
    });
    await profile.save();

    // Suspend user
    const user = await User.findById(profile.userId);
    if (user) {
      user.status = 'suspended';
      await user.save();
      invalidateUserStatusCache(user._id.toString());

      sendEmail({
        to: user.email,
        subject: 'Supplier Account Suspended - Global Integrated Support',
        html: getSupplierSuspendedEmail({ companyName: profile.companyName, reason }),
      }).catch((emailErr) => {
        logger.error({ err: emailErr }, 'Failed to send supplier suspension email');
      });
    }

    return sanitizeSupplierProfile(profile);
  }

  /**
   * Admin reinstates a suspended supplier back to approved.
   */
  static async reinstateSupplier(supplierId: string, adminUserId: string): Promise<any> {
    const profile = await this.findProfileByIdOrUserId(supplierId);

    const allowed = VALID_STATE_TRANSITIONS[profile.verificationStatus as SupplierVerificationStatus];
    if (!allowed || !allowed.includes('approved')) {
      throw createHttpError(
        `Cannot reinstate supplier from '${profile.verificationStatus}' to 'approved'`,
        400,
        'INVALID_STATE_TRANSITION'
      );
    }

    profile.verificationStatus = 'approved';
    profile.suspensionReason = undefined;
    profile.statusHistory.push({
      status: 'approved',
      by: adminUserId,
      at: new Date(),
      note: 'Supplier account reinstated by admin',
    });
    await profile.save();

    // Reactivate user
    const user = await User.findById(profile.userId);
    if (user) {
      user.status = 'active';
      user.isActive = true;
      await user.save();
      invalidateUserStatusCache(user._id.toString());

      const frontendUrl = getBaseFrontendUrl();
      const portalUrl = `${frontendUrl}/supplier`;

      sendEmail({
        to: user.email,
        subject: 'Supplier Account Reinstated - Global Integrated Support',
        html: getSupplierReinstatedEmail({ companyName: profile.companyName, portalUrl }),
      }).catch((emailErr) => {
        logger.error({ err: emailErr }, 'Failed to send supplier reinstatement email');
      });
    }

    return sanitizeSupplierProfile(profile);
  }

  /**
   * Admin reviews a supplier document (approve or reject).
   */
  static async reviewDocument(
    supplierId: string,
    docId: string,
    adminUserId: string,
    action: 'approved' | 'rejected',
    note?: string
  ): Promise<any> {
    const profile = await this.findProfileByIdOrUserId(supplierId);
    const doc = profile.documents.find((d: ISupplierDocument) => d._id.toString() === docId);
    if (!doc) {
      throw createHttpError('Document not found', 404, 'NOT_FOUND');
    }

    doc.status = action;
    doc.reviewedBy = new mongoose.Types.ObjectId(adminUserId);
    doc.reviewedAt = new Date();
    doc.note = note;

    profile.statusHistory.push({
      status: profile.verificationStatus,
      by: adminUserId,
      at: new Date(),
      note: `Document (${doc.type}) ${action}: ${note || ''}`.trim(),
    });

    await profile.save();

    if (action === 'rejected') {
      const user = await User.findById(profile.userId);
      if (user) {
        sendEmail({
          to: user.email,
          subject: 'Supplier Document Update - Global Integrated Support',
          html: getSupplierDocumentRejectedEmail({
            companyName: profile.companyName,
            docType: doc.type,
            note: note || 'Document could not be verified',
          }),
        }).catch((err) => {
          logger.error({ err }, 'Failed to send document rejection email');
        });
      }
    }

    return sanitizeSupplierProfile(profile);
  }

  /**
   * Admin generates signed URL for document review and logs audit trail.
   */
  static async getAdminDocumentUrl(
    supplierId: string,
    docId: string,
    adminUserId: string
  ): Promise<string> {
    const profile = await SupplierProfile.findOne({
      $or: [{ _id: supplierId }, { userId: supplierId }],
    }).select('+documents.storageRef');

    if (!profile) {
      throw createHttpError('Supplier profile not found', 404, 'NOT_FOUND');
    }

    const doc = profile.documents.find((d: ISupplierDocument) => d._id.toString() === docId);
    if (!doc) {
      throw createHttpError('Document not found', 404, 'NOT_FOUND');
    }

    logger.info({ adminUserId, supplierId, docId, docType: doc.type }, 'Admin accessed supplier document URL');

    return generateSignedUrl(doc.storageRef, doc.resourceType);
  }
}
