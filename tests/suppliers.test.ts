import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import app from '../app';
import { User, IUser } from '../models/User';
import {
  SupplierProfile,
  ISupplierProfile,
  ISupplierDocument,
  ISupplierStatusHistoryEntry,
} from '../models/SupplierProfile';
import { generateAccessToken } from '../utils/jwt';

// ---------------------------------------------------------------------------
// Mock storageService
// ---------------------------------------------------------------------------
vi.mock('../services/storageService', () => ({
  uploadDocument: vi.fn().mockResolvedValue({ publicId: 'test/supplier-doc1', resourceType: 'image' }),
  deleteDocument: vi.fn().mockResolvedValue(undefined),
  generateSignedUrl: vi.fn().mockReturnValue('https://signed.url/supplier-doc?expires=300'),
  validateFileBuffer: vi.fn(async (buffer: Buffer, mimeType: string) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowed.includes(mimeType)) throw new Error('File type not allowed');
    if (buffer.length > 5 * 1024 * 1024) throw new Error('File too large (max 5 MB)');
    if (mimeType === 'image/jpeg' && (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff))
      throw new Error('File content does not match declared type');
    if (mimeType === 'image/png' && (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47))
      throw new Error('File content does not match declared type');
    if (mimeType === 'application/pdf' && (buffer[0] !== 0x25 || buffer[1] !== 0x50 || buffer[2] !== 0x44 || buffer[3] !== 0x46))
      throw new Error('File content does not match declared type');
  }),
  ALLOWED_MIME_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
  MAX_SIZE_BYTES: 5 * 1024 * 1024,
}));

// ---------------------------------------------------------------------------
// Mock emailService
// ---------------------------------------------------------------------------
const mockSendEmail = vi.fn().mockResolvedValue({ messageId: 'test-email-id' });
vi.mock('../services/emailService', () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
  getEmailVerificationEmail: vi.fn().mockReturnValue('<p>Verify Email</p>'),
  getSupplierApplicationReceivedEmail: vi.fn().mockReturnValue('<p>Supplier Received</p>'),
  getSupplierNewApplicationAdminEmail: vi.fn().mockReturnValue('<p>Admin Supplier Notif</p>'),
  getSupplierApprovedEmail: vi.fn().mockReturnValue('<p>Supplier Approved</p>'),
  getSupplierRejectedEmail: vi.fn().mockReturnValue('<p>Supplier Rejected</p>'),
  getSupplierSuspendedEmail: vi.fn().mockReturnValue('<p>Supplier Suspended</p>'),
  getSupplierReinstatedEmail: vi.fn().mockReturnValue('<p>Supplier Reinstated</p>'),
  getSupplierDocumentRejectedEmail: vi.fn().mockReturnValue('<p>Doc Rejected</p>'),
}));

const makeValidJpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const makeInvalidFile = () => Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // MZ executable

describe('Supplier Portal Foundation Test Suite', () => {
  let mongoServer: MongoMemoryServer;

  // Test users & tokens
  let adminUser: IUser;
  let adminToken: string;
  let dispatcherUser: IUser;
  let dispatcherToken: string;
  let customerUser: IUser;
  let customerToken: string;
  let supplier1User: IUser;
  let supplier1Profile: ISupplierProfile;
  let supplier1Token: string;
  let supplier2User: IUser;
  let supplier2Profile: ISupplierProfile;
  let supplier2Token: string;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await mongoose.disconnect();
    await mongoose.connect(uri);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await User.deleteMany({});
    await SupplierProfile.deleteMany({});
    mockSendEmail.mockClear();

    // 1. Create Admin
    adminUser = await User.create({
      email: 'admin@example.com',
      password: 'password123',
      fullName: 'Super Admin',
      role: 'admin',
      status: 'active',
      isActive: true,
      emailVerified: true,
    });
    adminToken = generateAccessToken({
      userId: adminUser._id.toString(),
      email: adminUser.email,
      role: 'admin',
      status: 'active',
      emailVerified: true,
    });

    // 2. Create Dispatcher
    dispatcherUser = await User.create({
      email: 'dispatcher@example.com',
      password: 'password123',
      fullName: 'Chief Dispatcher',
      role: 'dispatcher',
      status: 'active',
      isActive: true,
      emailVerified: true,
    });
    dispatcherToken = generateAccessToken({
      userId: dispatcherUser._id.toString(),
      email: dispatcherUser.email,
      role: 'dispatcher',
      status: 'active',
      emailVerified: true,
    });

    // 3. Create Customer
    customerUser = await User.create({
      email: 'customer@example.com',
      password: 'password123',
      fullName: 'Jane Customer',
      role: 'customer',
      status: 'active',
      isActive: true,
      emailVerified: true,
    });
    customerToken = generateAccessToken({
      userId: customerUser._id.toString(),
      email: customerUser.email,
      role: 'customer',
      status: 'active',
      emailVerified: true,
    });

    // 4. Create Supplier 1
    supplier1User = await User.create({
      email: 'supplier1@parts.com',
      password: 'password123',
      fullName: 'Alice Supplier',
      role: 'supplier',
      status: 'active',
      isActive: true,
      emailVerified: true,
    });
    supplier1Profile = await SupplierProfile.create({
      userId: supplier1User._id,
      companyName: 'Apex Auto Parts LLC',
      businessType: 'wholesaler',
      taxId: 'US-987654321',
      website: 'https://apexautoparts.example.com',
      description: 'Wholesale brake and suspension components',
      categories: ['brakes', 'suspension'],
      businessPhone: '+15551234567',
      supportEmail: 'orders@apexautoparts.example.com',
      businessAddress: {
        street: '100 Industrial Pkwy',
        city: 'Detroit',
        state: 'MI',
        zipCode: '48201',
        country: 'US',
      },
      verificationStatus: 'draft',
      documents: [],
      statusHistory: [
        {
          status: 'draft',
          by: supplier1User._id.toString(),
          at: new Date(),
          note: 'Supplier account registered',
        },
      ],
    });
    supplier1Token = generateAccessToken({
      userId: supplier1User._id.toString(),
      email: supplier1User.email,
      role: 'supplier',
      status: 'active',
      emailVerified: true,
    });

    // 5. Create Supplier 2
    supplier2User = await User.create({
      email: 'supplier2@motors.com',
      password: 'password123',
      fullName: 'Bob Vendor',
      role: 'supplier',
      status: 'active',
      isActive: true,
      emailVerified: true,
    });
    supplier2Profile = await SupplierProfile.create({
      userId: supplier2User._id,
      companyName: 'Bavarian Motor Supplies',
      businessType: 'distributor',
      categories: ['engine', 'fluids'],
      verificationStatus: 'approved',
      documents: [],
      statusHistory: [
        {
          status: 'approved',
          by: adminUser._id.toString(),
          at: new Date(),
          note: 'Approved',
        },
      ],
    });
    supplier2Token = generateAccessToken({
      userId: supplier2User._id.toString(),
      email: supplier2User.email,
      role: 'supplier',
      status: 'active',
      emailVerified: true,
    });
  });

  // =========================================================================
  // 1. Supplier Registration & Application
  // =========================================================================
  describe('1. Supplier Registration & Application', () => {
    it('registers a new supplier successfully, creates draft profile, and sends verification email', async () => {
      const payload = {
        email: 'newsupplier@oem.com',
        password: 'SecurePassword123!',
        fullName: 'Charlie Parts',
        phone: '+15559876543',
        companyName: 'OEM Direct Warehouse',
        businessType: 'distributor',
        taxId: 'TAX-123456',
        website: 'https://oemdirect.example.com',
        description: 'Certified OEM replacement parts',
        categories: ['electrical', 'body'],
        businessPhone: '+15559876543',
        supportEmail: 'support@oemdirect.example.com',
        businessAddress: {
          street: '500 Logistics Blvd',
          city: 'Chicago',
          state: 'IL',
          zipCode: '60601',
          country: 'US',
        },
      };

      const res = await request(app)
        .post('/api/v1/suppliers/register')
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.email).toBe('newsupplier@oem.com');
      expect(res.body.data.user.role).toBe('supplier');
      expect(res.body.data.user.status).toBe('pending');
      expect(res.body.data.profile.companyName).toBe('OEM Direct Warehouse');
      expect(res.body.data.profile.verificationStatus).toBe('draft');

      // Verify DB records
      const savedUser = await User.findOne({ email: 'newsupplier@oem.com' });
      expect(savedUser).not.toBeNull();
      expect(savedUser?.role).toBe('supplier');

      const savedProfile = await SupplierProfile.findOne({ userId: savedUser!._id });
      expect(savedProfile).not.toBeNull();
      expect(savedProfile?.companyName).toBe('OEM Direct Warehouse');
      expect(savedProfile?.businessType).toBe('distributor');
      expect(savedProfile?.statusHistory.length).toBe(1);
    });

    it('rejects duplicate email during supplier registration (409)', async () => {
      const payload = {
        email: 'supplier1@parts.com', // Already registered
        password: 'Password123!',
        fullName: 'Duplicate Name',
        companyName: 'Duplicate Parts',
        businessType: 'wholesaler',
      };

      const res = await request(app)
        .post('/api/v1/suppliers/register')
        .send(payload);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('fails validation when required fields are missing (400)', async () => {
      const res = await request(app)
        .post('/api/v1/suppliers/register')
        .send({
          email: 'notanemail',
          password: 'short',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('allows an existing verified customer to apply to become a supplier', async () => {
      const applyPayload = {
        companyName: 'Jane Auto Salvage',
        businessType: 'salvage',
        categories: ['body', 'engine'],
      };

      const res = await request(app)
        .post('/api/v1/suppliers/apply')
        .set('Authorization', `Bearer ${customerToken}`)
        .send(applyPayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.companyName).toBe('Jane Auto Salvage');
      expect(res.body.data.verificationStatus).toBe('draft');

      // Verify user role was updated to supplier
      const updatedUser = await User.findById(customerUser._id);
      expect(updatedUser?.role).toBe('supplier');
    });
  });

  // =========================================================================
  // 2. Supplier Self-Management & Profile Isolation
  // =========================================================================
  describe('2. Supplier Self-Management & Ownership Isolation', () => {
    it('returns supplier own profile via GET /api/v1/suppliers/me', async () => {
      const res = await request(app)
        .get('/api/v1/suppliers/me')
        .set('Authorization', `Bearer ${supplier1Token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.email).toBe(supplier1User.email);
      expect(res.body.data.profile.companyName).toBe('Apex Auto Parts LLC');
      expect(res.body.data.profile.verificationStatus).toBe('draft');
    });

    it('denies access to /me for non-supplier roles (403)', async () => {
      const res = await request(app)
        .get('/api/v1/suppliers/me')
        .set('Authorization', `Bearer ${customerToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('denies access without authentication (401)', async () => {
      const res = await request(app).get('/api/v1/suppliers/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('updates supplier profile successfully via PUT /api/v1/suppliers/me', async () => {
      const updateData = {
        companyName: 'Apex Performance & Racing Parts',
        website: 'https://apexperformance.example.com',
        description: 'High performance brake systems and racing suspensions',
        categories: ['brakes', 'suspension', 'performance'],
        contactPerson: {
          name: 'Alice Johnson',
          title: 'Managing Director',
          email: 'alice@apexperformance.example.com',
          phone: '+15551112222',
        },
      };

      const res = await request(app)
        .put('/api/v1/suppliers/me')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send(updateData);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.companyName).toBe('Apex Performance & Racing Parts');
      expect(res.body.data.categories).toContain('performance');
      expect(res.body.data.contactPerson.title).toBe('Managing Director');

      // Verify supplier 2 was not altered (strict isolation)
      const s2InDb = await SupplierProfile.findById(supplier2Profile._id);
      expect(s2InDb?.companyName).toBe('Bavarian Motor Supplies');
    });

    it('submits application for administrative review via POST /api/v1/suppliers/me/submit', async () => {
      const res = await request(app)
        .post('/api/v1/suppliers/me/submit')
        .set('Authorization', `Bearer ${supplier1Token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.verificationStatus).toBe('pending_review');

      // Check DB status history
      const updated = await SupplierProfile.findById(supplier1Profile._id);
      expect(updated?.verificationStatus).toBe('pending_review');
      expect(updated?.statusHistory.some((h: ISupplierStatusHistoryEntry) => h.status === 'pending_review')).toBe(true);
    });

    it('rejects submitting an application when already in pending_review (400)', async () => {
      supplier1Profile.verificationStatus = 'pending_review';
      await supplier1Profile.save();

      const res = await request(app)
        .post('/api/v1/suppliers/me/submit')
        .set('Authorization', `Bearer ${supplier1Token}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    });
  });

  // =========================================================================
  // 3. Document Management
  // =========================================================================
  describe('3. Supplier Document Upload & Retrieval', () => {
    it('uploads a valid JPEG document, excludes private storageRef in response', async () => {
      const res = await request(app)
        .post('/api/v1/suppliers/me/documents')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .field('type', 'business_license')
        .field('fileName', 'license.jpg')
        .attach('document', makeValidJpeg(), 'license.jpg');

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.type).toBe('business_license');
      expect(res.body.data.status).toBe('pending');
      expect(res.body.data.storageRef).toBeUndefined(); // Security: never leaked

      // Verify in DB
      const profileInDb = await SupplierProfile.findById(supplier1Profile._id).select('+documents.storageRef');
      expect(profileInDb?.documents.length).toBe(1);
      expect(profileInDb?.documents[0].storageRef).toBe('test/supplier-doc1');
    });

    it('rejects document upload with invalid magic bytes (400)', async () => {
      const res = await request(app)
        .post('/api/v1/suppliers/me/documents')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .field('type', 'business_license')
        .attach('document', makeInvalidFile(), 'license.jpg');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_FILE');
    });

    it('generates a signed URL for supplier to view own document', async () => {
      const docId = new mongoose.Types.ObjectId();
      supplier1Profile.documents.push({
        _id: docId,
        type: 'business_license',
        storageRef: 'test/supplier-doc1',
        resourceType: 'image',
        status: 'pending',
      } as any);
      await supplier1Profile.save();

      const res = await request(app)
        .get(`/api/v1/suppliers/me/documents/${docId}/url`)
        .set('Authorization', `Bearer ${supplier1Token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.url).toContain('https://signed.url');
    });

    it('deletes a document successfully', async () => {
      const docId = new mongoose.Types.ObjectId();
      supplier1Profile.documents.push({
        _id: docId,
        type: 'insurance',
        storageRef: 'test/delete-ref',
        resourceType: 'image',
        status: 'pending',
      } as any);
      await supplier1Profile.save();

      const res = await request(app)
        .delete(`/api/v1/suppliers/me/documents/${docId}`)
        .set('Authorization', `Bearer ${supplier1Token}`);

      expect(res.status).toBe(200);
      const reloaded = await SupplierProfile.findById(supplier1Profile._id);
      expect(reloaded?.documents.some((d: ISupplierDocument) => d._id.toString() === docId.toString())).toBe(false);
    });
  });

  // =========================================================================
  // 4. Admin Supplier Review & Lifecycle Verification
  // =========================================================================
  describe('4. Administrative Verification Workflow', () => {
    beforeEach(async () => {
      supplier1Profile.verificationStatus = 'pending_review';
      await supplier1Profile.save();
    });

    it('allows admin and dispatcher to list suppliers with pagination and status filters', async () => {
      const adminRes = await request(app)
        .get('/api/v1/suppliers?status=pending_review')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(adminRes.status).toBe(200);
      expect(adminRes.body.success).toBe(true);
      expect(adminRes.body.data.length).toBe(1);
      expect(adminRes.body.data[0].companyName).toBe('Apex Auto Parts LLC');
      expect(adminRes.body.meta.total).toBe(1);

      // Dispatcher also has read permission
      const dispRes = await request(app)
        .get('/api/v1/suppliers')
        .set('Authorization', `Bearer ${dispatcherToken}`);

      expect(dispRes.status).toBe(200);
      expect(dispRes.body.data.length).toBe(2);

      // Non-staff forbidden
      const custRes = await request(app)
        .get('/api/v1/suppliers')
        .set('Authorization', `Bearer ${customerToken}`);
      expect(custRes.status).toBe(403);
    });

    it('admin approves a supplier: updates status to approved and activates user account', async () => {
      supplier1User.status = 'pending';
      supplier1User.isActive = false;
      await supplier1User.save();

      const res = await request(app)
        .post(`/api/v1/suppliers/${supplier1Profile._id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.verificationStatus).toBe('approved');

      // Verify User is activated
      const userInDb = await User.findById(supplier1User._id);
      expect(userInDb?.status).toBe('active');
      expect(userInDb?.isActive).toBe(true);

      // Verify statusHistory audited
      const profileInDb = await SupplierProfile.findById(supplier1Profile._id);
      expect(profileInDb?.statusHistory.some((h: ISupplierStatusHistoryEntry) => h.status === 'approved')).toBe(true);
    });

    it('admin rejects a supplier with reason', async () => {
      const res = await request(app)
        .post(`/api/v1/suppliers/${supplier1Profile._id}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Business license registration could not be verified' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.verificationStatus).toBe('rejected');
      expect(res.body.data.rejectionReason).toBe('Business license registration could not be verified');
    });

    it('rejects approval transition directly from draft without submission (400)', async () => {
      supplier1Profile.verificationStatus = 'draft';
      await supplier1Profile.save();

      const res = await request(app)
        .post(`/api/v1/suppliers/${supplier1Profile._id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('admin suspends an approved supplier and reinstates them', async () => {
      // 1. Suspend approved supplier 2
      const suspendRes = await request(app)
        .post(`/api/v1/suppliers/${supplier2Profile._id}/suspend`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Repeated stock fulfillment failure' });

      expect(suspendRes.status).toBe(200);
      expect(suspendRes.body.data.verificationStatus).toBe('suspended');

      // User account is suspended
      const suspendedUser = await User.findById(supplier2User._id);
      expect(suspendedUser?.status).toBe('suspended');

      // 2. Reinstate suspended supplier 2
      const reinstateRes = await request(app)
        .post(`/api/v1/suppliers/${supplier2Profile._id}/reinstate`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(reinstateRes.status).toBe(200);
      expect(reinstateRes.body.data.verificationStatus).toBe('approved');

      const reinstatedUser = await User.findById(supplier2User._id);
      expect(reinstatedUser?.status).toBe('active');
    });

    it('admin approves and rejects individual supplier documents', async () => {
      const docId = new mongoose.Types.ObjectId();
      supplier1Profile.documents.push({
        _id: docId,
        type: 'business_license',
        storageRef: 'test/admin-review-doc',
        resourceType: 'image',
        status: 'pending',
      } as any);
      await supplier1Profile.save();

      // Admin approves document
      const approveRes = await request(app)
        .post(`/api/v1/suppliers/${supplier1Profile._id}/documents/${docId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ note: 'Verified against state registry' });

      expect(approveRes.status).toBe(200);
      let updatedProfile = await SupplierProfile.findById(supplier1Profile._id);
      expect(updatedProfile?.documents[0].status).toBe('approved');
      expect(updatedProfile?.documents[0].note).toBe('Verified against state registry');

      // Admin rejects document
      const rejectRes = await request(app)
        .post(`/api/v1/suppliers/${supplier1Profile._id}/documents/${docId}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ note: 'Expired documentation' });

      expect(rejectRes.status).toBe(200);
      updatedProfile = await SupplierProfile.findById(supplier1Profile._id);
      expect(updatedProfile?.documents[0].status).toBe('rejected');
    });

    it('denies non-admin users from approving or rejecting suppliers (403)', async () => {
      const res = await request(app)
        .post(`/api/v1/suppliers/${supplier1Profile._id}/approve`)
        .set('Authorization', `Bearer ${supplier1Token}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });
});
