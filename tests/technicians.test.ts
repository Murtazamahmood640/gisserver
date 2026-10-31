import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import app from '../app';
import { User, IUser } from '../models/User';
import { TechnicianProfile, ITechnicianProfile } from '../models/TechnicianProfile';
import { RefreshToken } from '../models/RefreshToken';
import { Booking } from '../models/Booking';
import { generateAccessToken, generateRefreshToken, hashToken, generateToken } from '../utils/jwt';
import { TechnicianService } from '../modules/technicians/service';

// ---------------------------------------------------------------------------
// Mock storageService
// ---------------------------------------------------------------------------
vi.mock('../services/storageService', () => ({
  uploadDocument: vi.fn().mockResolvedValue({ publicId: 'test/doc1', resourceType: 'image' }),
  deleteDocument: vi.fn().mockResolvedValue(undefined),
  generateSignedUrl: vi.fn().mockReturnValue('https://signed.url/doc?expires=300'),
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
const mockSendEmail = vi.fn().mockResolvedValue({ messageId: 'test-id' });
vi.mock('../services/emailService', () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
  getEmailVerificationEmail: vi.fn().mockReturnValue('<p>Verify</p>'),
  getTechApplicationReceivedEmail: vi.fn().mockReturnValue('<p>Received</p>'),
  getTechNewApplicationAdminEmail: vi.fn().mockReturnValue('<p>Admin notif</p>'),
  getTechApprovedEmail: vi.fn().mockReturnValue('<p>Approved</p>'),
  getTechRejectedEmail: vi.fn().mockReturnValue('<p>Rejected</p>'),
  getTechSuspendedEmail: vi.fn().mockReturnValue('<p>Suspended</p>'),
  getTechReinstatedEmail: vi.fn().mockReturnValue('<p>Reinstated</p>'),
  getTechDocumentRejectedEmail: vi.fn().mockReturnValue('<p>Doc Rejected</p>'),
  getTechDocumentExpiringEmail: vi.fn().mockReturnValue('<p>Doc Expiring</p>'),
  getTechDocumentExpiredEmail: vi.fn().mockReturnValue('<p>Doc Expired</p>'),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const makeValidJpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const makeExeRenamedAsPdf = () => Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // MZ magic (EXE)

describe('Technician Onboarding & Management Suite', () => {
  let mongoServer: MongoMemoryServer;

  let customerUser: IUser, customerToken: string;
  let tech1User: IUser, tech1Profile: ITechnicianProfile, tech1Token: string;
  let tech2User: IUser, tech2Profile: ITechnicianProfile, tech2Token: string;
  let dispatcherUser: IUser, dispatcherToken: string;
  let adminUser: IUser, adminToken: string;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.disconnect();
    await mongoose.connect(mongoServer.getUri());
    await User.syncIndexes();
    await TechnicianProfile.syncIndexes();
    await RefreshToken.syncIndexes();
    await Booking.syncIndexes();
  }, 240000);

  afterAll(async () => {
    if (mongoServer) { await mongoose.disconnect(); await mongoServer.stop(); }
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await User.deleteMany({});
    await TechnicianProfile.deleteMany({});
    await RefreshToken.deleteMany({});
    await Booking.deleteMany({});

    customerUser = await User.create({ email: 'customer@test.com', password: 'P@ssword1!', fullName: 'Customer One', role: 'customer', status: 'active', isActive: true, emailVerified: true });
    customerToken = generateAccessToken({ userId: customerUser._id.toString(), email: customerUser.email, role: 'customer', status: 'active', emailVerified: true });

    tech1User = await User.create({ email: 'tech1@test.com', password: 'P@ssword1!', fullName: 'Tech One', role: 'technician', status: 'pending', isActive: true, emailVerified: true });
    tech1Profile = await TechnicianProfile.create({ userId: tech1User._id, displayName: 'Tech One', skills: { categoryIds: [new mongoose.Types.ObjectId()], serviceIds: [] }, serviceArea: { zipCodes: ['10001'] }, documents: [], verificationStatus: 'draft', availability: { isOnline: false, weeklySchedule: [], timeOff: [] } });
    tech1Token = generateAccessToken({ userId: tech1User._id.toString(), email: tech1User.email, role: 'technician', status: 'pending', emailVerified: true });

    tech2User = await User.create({ email: 'tech2@test.com', password: 'P@ssword1!', fullName: 'Tech Two', role: 'technician', status: 'pending', isActive: true, emailVerified: true });
    tech2Profile = await TechnicianProfile.create({ userId: tech2User._id, displayName: 'Tech Two', skills: { categoryIds: [new mongoose.Types.ObjectId()], serviceIds: [] }, serviceArea: { zipCodes: ['10002'] }, documents: [], verificationStatus: 'draft', availability: { isOnline: false, weeklySchedule: [], timeOff: [] } });
    tech2Token = generateAccessToken({ userId: tech2User._id.toString(), email: tech2User.email, role: 'technician', status: 'pending', emailVerified: true });

    dispatcherUser = await User.create({ email: 'dispatcher@test.com', password: 'P@ssword1!', fullName: 'Dispatcher', role: 'dispatcher', status: 'active', isActive: true, emailVerified: true });
    dispatcherToken = generateAccessToken({ userId: dispatcherUser._id.toString(), email: dispatcherUser.email, role: 'dispatcher', status: 'active', emailVerified: true });

    adminUser = await User.create({ email: 'admin@test.com', password: 'P@ssword1!', fullName: 'Admin', role: 'admin', status: 'active', isActive: true, emailVerified: true });
    adminToken = generateAccessToken({ userId: adminUser._id.toString(), email: adminUser.email, role: 'admin', status: 'active', emailVerified: true });
  }, 30000);

  // =========================================================================
  // 1. ROLE BOUNDARIES
  // =========================================================================
  describe('1. Role Boundaries & Access Control', () => {
    it('customer cannot GET /api/v1/technicians/me (403)', async () => {
      const res = await request(app).get('/api/v1/technicians/me').set('Authorization', `Bearer ${customerToken}`);
      expect(res.status).toBe(403);
    });

    it('customer cannot list technicians (403)', async () => {
      const res = await request(app).get('/api/v1/technicians').set('Authorization', `Bearer ${customerToken}`);
      expect(res.status).toBe(403);
    });

    it('technician cannot GET another technician via admin route (403)', async () => {
      const res = await request(app).get(`/api/v1/technicians/${tech2Profile._id}`).set('Authorization', `Bearer ${tech1Token}`);
      expect(res.status).toBe(403);
    });

    it("technician cannot get another technician's doc URL via /me (404)", async () => {
      const docId2 = new mongoose.Types.ObjectId();
      tech2Profile.documents.push({ _id: docId2, type: 'id', storageRef: 'tech2/doc', status: 'pending' });
      await tech2Profile.save();
      const res = await request(app).get(`/api/v1/technicians/me/documents/${docId2}/url`).set('Authorization', `Bearer ${tech1Token}`);
      expect(res.status).toBe(404);
    });

    it('dispatcher cannot call approve (403)', async () => {
      const res = await request(app).post(`/api/v1/technicians/${tech1Profile._id}/approve`).set('Authorization', `Bearer ${dispatcherToken}`);
      expect(res.status).toBe(403);
    });

    it('dispatcher cannot call reject (403)', async () => {
      const res = await request(app).post(`/api/v1/technicians/${tech1Profile._id}/reject`).set('Authorization', `Bearer ${dispatcherToken}`).send({ reason: 'test' });
      expect(res.status).toBe(403);
    });

    it('dispatcher cannot call suspend (403)', async () => {
      const res = await request(app).post(`/api/v1/technicians/${tech1Profile._id}/suspend`).set('Authorization', `Bearer ${dispatcherToken}`).send({ reason: 'test' });
      expect(res.status).toBe(403);
    });

    it('dispatcher cannot call reinstate (403)', async () => {
      const res = await request(app).post(`/api/v1/technicians/${tech1Profile._id}/reinstate`).set('Authorization', `Bearer ${dispatcherToken}`);
      expect(res.status).toBe(403);
    });

    it('dispatcher CAN list technicians (200)', async () => {
      const res = await request(app).get('/api/v1/technicians').set('Authorization', `Bearer ${dispatcherToken}`);
      expect(res.status).toBe(200);
    });

    it('dispatcher CAN view a technician (200)', async () => {
      const res = await request(app).get(`/api/v1/technicians/${tech1Profile._id}`).set('Authorization', `Bearer ${dispatcherToken}`);
      expect(res.status).toBe(200);
    });

    it('customer cannot access admin doc URL route (403)', async () => {
      const docId = new mongoose.Types.ObjectId();
      tech1Profile.documents.push({ _id: docId, type: 'id', storageRef: 'tech1/doc', status: 'pending' });
      await tech1Profile.save();
      const res = await request(app).get(`/api/v1/technicians/${tech1Profile._id}/documents/${docId}/url`).set('Authorization', `Bearer ${customerToken}`);
      expect(res.status).toBe(403);
    });
  });

  // =========================================================================
  // 2. MASS ASSIGNMENT PROTECTION
  // =========================================================================
  describe('2. Mass Assignment Protection', () => {
    it('POST /register with role=admin rejected (400)', async () => {
      const res = await request(app).post('/api/v1/technicians/register').send({ email: 'x@test.com', password: 'P@ssword1!', fullName: 'X', role: 'admin' });
      expect(res.status).toBe(400);
    });

    it('POST /register with status=active rejected (400)', async () => {
      const res = await request(app).post('/api/v1/technicians/register').send({ email: 'y@test.com', password: 'P@ssword1!', fullName: 'Y', status: 'active' });
      expect(res.status).toBe(400);
    });

    it('POST /register with verificationStatus=approved rejected (400)', async () => {
      const res = await request(app).post('/api/v1/technicians/register').send({ email: 'z@test.com', password: 'P@ssword1!', fullName: 'Z', verificationStatus: 'approved' });
      expect(res.status).toBe(400);
    });

    it('POST /register with userId injected rejected (400)', async () => {
      const res = await request(app).post('/api/v1/technicians/register').send({ email: 'w@test.com', password: 'P@ssword1!', fullName: 'W', userId: new mongoose.Types.ObjectId().toString() });
      expect(res.status).toBe(400);
    });

    it('PUT /me with verificationStatus in body rejected by strict schema (400)', async () => {
      const res = await request(app).put('/api/v1/technicians/me').set('Authorization', `Bearer ${tech1Token}`).send({ displayName: 'OK', verificationStatus: 'approved' });
      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // 3. STATE MACHINE — ALL VALID AND INVALID TRANSITIONS
  // =========================================================================
  describe('3. Application State Machine — All Transitions', () => {
    async function addRequiredDoc(profile: ITechnicianProfile) {
      profile.documents.push({ _id: new mongoose.Types.ObjectId(), type: 'id', storageRef: 'test/ref', status: 'pending' });
      await profile.save();
    }

    it('submit without required doc (id) → 400 MISSING_REQUIRED_DOCUMENT', async () => {
      const res = await request(app).post('/api/v1/technicians/me/submit').set('Authorization', `Bearer ${tech1Token}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_REQUIRED_DOCUMENT');
    });

    it('submit without skills → 400 MISSING_SKILLS', async () => {
      await addRequiredDoc(tech1Profile);
      tech1Profile.skills.categoryIds = [];
      await tech1Profile.save();
      const res = await request(app).post('/api/v1/technicians/me/submit').set('Authorization', `Bearer ${tech1Token}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_SKILLS');
    });

    it('submit without service area → 400 MISSING_SERVICE_AREA', async () => {
      await addRequiredDoc(tech1Profile);
      tech1Profile.serviceArea.zipCodes = [];
      await tech1Profile.save();
      const res = await request(app).post('/api/v1/technicians/me/submit').set('Authorization', `Bearer ${tech1Token}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_SERVICE_AREA');
    });

    it('draft → approved (skip submit) is INVALID (400)', async () => {
      const res = await request(app).post(`/api/v1/technicians/${tech1Profile._id}/approve`).set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('draft → suspended directly is INVALID (400)', async () => {
      const res = await request(app).post(`/api/v1/technicians/${tech1Profile._id}/suspend`).set('Authorization', `Bearer ${adminToken}`).send({ reason: 'test' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('draft → pending_review (valid submit)', async () => {
      await addRequiredDoc(tech1Profile);
      const res = await request(app).post('/api/v1/technicians/me/submit').set('Authorization', `Bearer ${tech1Token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.verificationStatus).toBe('pending_review');
    });

    it('pending_review → approved (valid); user.status = active', async () => {
      await addRequiredDoc(tech1Profile);
      tech1Profile.verificationStatus = 'pending_review';
      await tech1Profile.save();
      const res = await request(app).post(`/api/v1/technicians/${tech1Profile._id}/approve`).set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.verificationStatus).toBe('approved');
      const user = await User.findById(tech1User._id);
      expect(user?.status).toBe('active');
    });

    it('approved → approved (duplicate) is INVALID (400)', async () => {
      tech1Profile.verificationStatus = 'approved';
      await tech1Profile.save();
      const res = await request(app).post(`/api/v1/technicians/${tech1Profile._id}/approve`).set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('pending_review → rejected (valid)', async () => {
      tech1Profile.verificationStatus = 'pending_review';
      await tech1Profile.save();
      const res = await request(app).post(`/api/v1/technicians/${tech1Profile._id}/reject`).set('Authorization', `Bearer ${adminToken}`).send({ reason: 'Expired license' });
      expect(res.status).toBe(200);
      expect(res.body.data.verificationStatus).toBe('rejected');
    });

    it('rejected → pending_review (resubmit — valid)', async () => {
      await addRequiredDoc(tech1Profile);
      tech1Profile.verificationStatus = 'rejected';
      await tech1Profile.save();
      const res = await request(app).post('/api/v1/technicians/me/submit').set('Authorization', `Bearer ${tech1Token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.verificationStatus).toBe('pending_review');
    });

    it('approved → suspended (valid); user.status=suspended, tokens revoked', async () => {
      tech1Profile.verificationStatus = 'approved';
      await tech1Profile.save();
      await User.updateOne({ _id: tech1User._id }, { status: 'active', isActive: true });
      const raw = generateRefreshToken();
      await RefreshToken.create({ userId: tech1User._id, tokenHash: hashToken(raw), deviceInfo: 'test', expiresAt: new Date(Date.now() + 86400000), revoked: false });

      const res = await request(app).post(`/api/v1/technicians/${tech1Profile._id}/suspend`).set('Authorization', `Bearer ${adminToken}`).send({ reason: 'Policy violation' });
      expect(res.status).toBe(200);
      expect(res.body.data.verificationStatus).toBe('suspended');
      const user = await User.findById(tech1User._id);
      expect(user?.status).toBe('suspended');
      const token = await RefreshToken.findOne({ tokenHash: hashToken(raw) });
      expect(token?.revoked).toBe(true);
    });

    it('suspended → approved (reinstate — valid); user.status=active', async () => {
      tech1Profile.verificationStatus = 'suspended';
      await tech1Profile.save();
      await User.updateOne({ _id: tech1User._id }, { status: 'suspended', isActive: false });
      const res = await request(app).post(`/api/v1/technicians/${tech1Profile._id}/reinstate`).set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.verificationStatus).toBe('approved');
      const user = await User.findById(tech1User._id);
      expect(user?.status).toBe('active');
    });

    it('pending technician can view and edit profile but cannot go online (403)', async () => {
      const profileRes = await request(app).get('/api/v1/technicians/me').set('Authorization', `Bearer ${tech1Token}`);
      expect(profileRes.status).toBe(200);

      const skillsRes = await request(app).put('/api/v1/technicians/me/skills').set('Authorization', `Bearer ${tech1Token}`).send({ categoryIds: [new mongoose.Types.ObjectId().toString()] });
      expect(skillsRes.status).toBe(200);

      const onlineRes = await request(app).post('/api/v1/technicians/me/online').set('Authorization', `Bearer ${tech1Token}`).send({ isOnline: true });
      expect(onlineRes.status).toBe(403);
    });

    it('reinstated technician can refresh (auth works)', async () => {
      tech1Profile.verificationStatus = 'approved';
      await tech1Profile.save();
      await User.updateOne({ _id: tech1User._id }, { status: 'active', isActive: true });
      const raw = generateRefreshToken();
      await RefreshToken.create({ userId: tech1User._id, tokenHash: hashToken(raw), deviceInfo: 'test', expiresAt: new Date(Date.now() + 86400000), revoked: false });
      const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: raw });
      expect(res.status).toBe(200);
      expect(res.body.data?.accessToken).toBeDefined();
    });
  });

  // =========================================================================
  // 4. UPLOAD VALIDATION
  // =========================================================================
  describe('4. Document Upload Validation', () => {
    it('rejects text/plain (400)', async () => {
      const res = await request(app).post('/api/v1/technicians/me/documents').set('Authorization', `Bearer ${tech1Token}`).field('type', 'id').attach('document', Buffer.from('text'), { filename: 'f.txt', contentType: 'text/plain' });
      expect(res.status).toBe(400);
    });

    it('rejects SVG (image/svg+xml) not in allow-list (400)', async () => {
      const res = await request(app).post('/api/v1/technicians/me/documents').set('Authorization', `Bearer ${tech1Token}`).field('type', 'id').attach('document', Buffer.from('<svg/>'), { filename: 'f.svg', contentType: 'image/svg+xml' });
      expect(res.status).toBe(400);
    });

    it('rejects HTML (text/html) (400)', async () => {
      const res = await request(app).post('/api/v1/technicians/me/documents').set('Authorization', `Bearer ${tech1Token}`).field('type', 'id').attach('document', Buffer.from('<html/>'), { filename: 'f.html', contentType: 'text/html' });
      expect(res.status).toBe(400);
    });

    it('rejects file > 5 MB (400)', async () => {
      const res = await request(app).post('/api/v1/technicians/me/documents').set('Authorization', `Bearer ${tech1Token}`).field('type', 'id').attach('document', Buffer.alloc(5 * 1024 * 1024 + 1024, 0xff), { filename: 'big.jpg', contentType: 'image/jpeg' });
      expect(res.status).toBe(400);
    });

    it('rejects .exe renamed to .pdf (magic bytes mismatch) (400)', async () => {
      const res = await request(app).post('/api/v1/technicians/me/documents').set('Authorization', `Bearer ${tech1Token}`).field('type', 'id').attach('document', makeExeRenamedAsPdf(), { filename: 'evil.pdf', contentType: 'application/pdf' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/does not match declared type/i);
    });

    it('rejects random bytes declared as image/jpeg (magic bytes mismatch) (400)', async () => {
      const res = await request(app).post('/api/v1/technicians/me/documents').set('Authorization', `Bearer ${tech1Token}`).field('type', 'id').attach('document', Buffer.from([0x00, 0x01, 0x02, 0x03]), { filename: 'fake.jpg', contentType: 'image/jpeg' });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('File content does not match declared type');
    });

    it('accepts valid JPEG with correct magic bytes (201)', async () => {
      const res = await request(app).post('/api/v1/technicians/me/documents').set('Authorization', `Bearer ${tech1Token}`).field('type', 'id').attach('document', makeValidJpeg(), { filename: 'real.jpg', contentType: 'image/jpeg' });
      expect(res.status).toBe(201);
    });

    it('enforces maximum 10 documents (400 DOCUMENT_LIMIT_REACHED)', async () => {
      tech1Profile.documents = Array.from({ length: 10 }).map((_, i) => ({ _id: new mongoose.Types.ObjectId(), type: 'other', storageRef: `test/doc_${i}`, status: 'pending' }));
      await tech1Profile.save();
      const res = await request(app).post('/api/v1/technicians/me/documents').set('Authorization', `Bearer ${tech1Token}`).field('type', 'license').attach('document', makeValidJpeg(), { filename: 'doc11.jpg', contentType: 'image/jpeg' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DOCUMENT_LIMIT_REACHED');
    });
  });

  // =========================================================================
  // 5. DOCUMENT SECURITY — storageRef never in API response
  // =========================================================================
  describe('5. Document Security — storageRef never exposed in responses', () => {
    it('GET /me response never contains storageRef or secret ref value', async () => {
      tech1Profile.documents.push({ _id: new mongoose.Types.ObjectId(), type: 'id', storageRef: 'SECRET_STORAGE_REF_VALUE', status: 'pending' });
      await tech1Profile.save();
      const res = await request(app).get('/api/v1/technicians/me').set('Authorization', `Bearer ${tech1Token}`);
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('SECRET_STORAGE_REF_VALUE');
      expect(body).not.toContain('storageRef');
    });

    it('Admin GET /technicians/:id never contains storageRef', async () => {
      tech1Profile.documents.push({ _id: new mongoose.Types.ObjectId(), type: 'license', storageRef: 'ADMIN_SECRET_REF', status: 'approved' });
      await tech1Profile.save();
      const res = await request(app).get(`/api/v1/technicians/${tech1Profile._id}`).set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('ADMIN_SECRET_REF');
      expect(body).not.toContain('storageRef');
    });
  });

  // =========================================================================
  // 6. SIGNED URL ACCESS CONTROL
  // =========================================================================
  describe('6. Signed URL Access Control', () => {
    it('owner can get own doc URL (200)', async () => {
      const docId = new mongoose.Types.ObjectId();
      tech1Profile.documents.push({ _id: docId, type: 'id', storageRef: 'tech1/doc', status: 'pending' });
      await tech1Profile.save();
      const res = await request(app).get(`/api/v1/technicians/me/documents/${docId}/url`).set('Authorization', `Bearer ${tech1Token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.url).toBe('https://signed.url/doc?expires=300');
    });

    it("tech cannot get another tech's doc via /me (404)", async () => {
      const docId2 = new mongoose.Types.ObjectId();
      tech2Profile.documents.push({ _id: docId2, type: 'id', storageRef: 'tech2/doc', status: 'pending' });
      await tech2Profile.save();
      const res = await request(app).get(`/api/v1/technicians/me/documents/${docId2}/url`).set('Authorization', `Bearer ${tech1Token}`);
      expect(res.status).toBe(404);
    });

    it('admin can get any doc URL via admin route (200)', async () => {
      const docId2 = new mongoose.Types.ObjectId();
      tech2Profile.documents.push({ _id: docId2, type: 'license', storageRef: 'tech2/doc2', status: 'pending' });
      await tech2Profile.save();
      const res = await request(app).get(`/api/v1/technicians/${tech2Profile._id}/documents/${docId2}/url`).set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.url).toBe('https://signed.url/doc?expires=300');
    });

    it('dispatcher cannot access admin doc URL route (403)', async () => {
      const docId = new mongoose.Types.ObjectId();
      tech1Profile.documents.push({ _id: docId, type: 'id', storageRef: 'tech1/doc4', status: 'pending' });
      await tech1Profile.save();
      const res = await request(app).get(`/api/v1/technicians/${tech1Profile._id}/documents/${docId}/url`).set('Authorization', `Bearer ${dispatcherToken}`);
      expect(res.status).toBe(403);
    });

    it('legacy user cannot access admin doc URL route (403)', async () => {
      const docId = new mongoose.Types.ObjectId();
      tech1Profile.documents.push({ _id: docId, type: 'id', storageRef: 'tech1/doc5', status: 'pending' });
      await tech1Profile.save();
      const legacyUser = await User.create({
        email: 'legacy-doc-access@gis.com',
        password: 'password123',
        fullName: 'Legacy User',
        role: 'user',
        status: 'active',
      });
      const legacyToken = generateToken({ userId: legacyUser._id.toString(), email: legacyUser.email, role: 'user' });
      const res = await request(app).get(`/api/v1/technicians/${tech1Profile._id}/documents/${docId}/url`).set('Authorization', `Bearer ${legacyToken}`);
      expect(res.status).toBe(403);
    });

    it('customer cannot access admin doc URL route (403)', async () => {
      const docId = new mongoose.Types.ObjectId();
      tech1Profile.documents.push({ _id: docId, type: 'id', storageRef: 'tech1/doc3', status: 'pending' });
      await tech1Profile.save();
      const res = await request(app).get(`/api/v1/technicians/${tech1Profile._id}/documents/${docId}/url`).set('Authorization', `Bearer ${customerToken}`);
      expect(res.status).toBe(403);
    });

    it('other technician cannot access admin doc URL route (403)', async () => {
      const docId = new mongoose.Types.ObjectId();
      tech1Profile.documents.push({ _id: docId, type: 'id', storageRef: 'tech1/doc6', status: 'pending' });
      await tech1Profile.save();
      const res = await request(app).get(`/api/v1/technicians/${tech1Profile._id}/documents/${docId}/url`).set('Authorization', `Bearer ${tech2Token}`);
      expect(res.status).toBe(403);
    });
  });

  // =========================================================================
  // 7. SUSPENDED USER — ACCESS & REFRESH
  // =========================================================================
  describe('7. Suspended Users — Authentication Revocation', () => {
    it('suspended status in JWT is rejected by authenticateToken (403 ACCOUNT_SUSPENDED)', async () => {
      // The live-status cache will look up the real DB user. We need the DB user to actually be suspended.
      await User.updateOne({ _id: tech1User._id }, { status: 'suspended', isActive: false });
      // Clear any in-memory cache so the fresh DB value is read
      const { clearUserStatusCache } = await import('../middleware/auth');
      clearUserStatusCache();

      // Token carries active status, but DB is suspended — live check must win
      const activeTokenForSuspendedUser = generateAccessToken({ userId: tech1User._id.toString(), email: tech1User.email, role: 'technician', status: 'active', emailVerified: true });
      const res = await request(app).get('/api/v1/technicians/me').set('Authorization', `Bearer ${activeTokenForSuspendedUser}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');

      // Restore so other tests are unaffected
      await User.updateOne({ _id: tech1User._id }, { status: 'pending', isActive: true });
    });

    it('after suspend, refresh token revoked; /auth/refresh → 401', async () => {
      tech1Profile.verificationStatus = 'approved';
      await tech1Profile.save();
      await User.updateOne({ _id: tech1User._id }, { status: 'active', isActive: true });
      const raw = generateRefreshToken();
      await RefreshToken.create({ userId: tech1User._id, tokenHash: hashToken(raw), deviceInfo: 'test', expiresAt: new Date(Date.now() + 86400000), revoked: false });

      await request(app).post(`/api/v1/technicians/${tech1Profile._id}/suspend`).set('Authorization', `Bearer ${adminToken}`).send({ reason: 'Violation' });

      const stored = await RefreshToken.findOne({ tokenHash: hashToken(raw) });
      expect(stored?.revoked).toBe(true);

      const refreshRes = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: raw });
      expect(refreshRes.status).toBe(401);
    });

    it('reinstated technician can refresh tokens again', async () => {
      tech1Profile.verificationStatus = 'approved';
      await tech1Profile.save();
      await User.updateOne({ _id: tech1User._id }, { status: 'active', isActive: true });
      const raw = generateRefreshToken();
      await RefreshToken.create({ userId: tech1User._id, tokenHash: hashToken(raw), deviceInfo: 'test', expiresAt: new Date(Date.now() + 86400000), revoked: false });
      const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: raw });
      expect(res.status).toBe(200);
      expect(res.body.data?.accessToken).toBeDefined();
    });
  });

  // =========================================================================
  // 8. DOCUMENT EXPIRY CHECK IDEMPOTENCY
  // =========================================================================
  describe('8. Document Expiry Check Idempotency', () => {
    it('sends expiry-warning email once; second run sends 0 (expiryNotifiedAt guard)', async () => {
      tech1Profile.documents.push({ _id: new mongoose.Types.ObjectId(), type: 'insurance', storageRef: 'test/ins', status: 'approved', expiresAt: new Date(Date.now() + 15 * 86400000) });
      await tech1Profile.save();

      const r1 = await TechnicianService.runDocumentExpiryCheck();
      expect(r1.notifiedExpiring).toBe(1);
      const emailCount1 = mockSendEmail.mock.calls.length;
      expect(emailCount1).toBeGreaterThanOrEqual(1);

      const r2 = await TechnicianService.runDocumentExpiryCheck();
      expect(r2.notifiedExpiring).toBe(0);
      expect(mockSendEmail.mock.calls.length).toBe(emailCount1);

      const reloaded = await TechnicianProfile.findById(tech1Profile._id);
      expect(reloaded?.documents[0].expiryNotifiedAt).toBeDefined();
    });

    it('sends expired email once; second run sends 0 (idempotent)', async () => {
      tech1Profile.documents.push({ _id: new mongoose.Types.ObjectId(), type: 'license', storageRef: 'test/lic', status: 'approved', expiresAt: new Date(Date.now() - 2 * 86400000) });
      await tech1Profile.save();

      const r1 = await TechnicianService.runDocumentExpiryCheck();
      expect(r1.notifiedExpired).toBeGreaterThanOrEqual(1);
      const c1 = mockSendEmail.mock.calls.length;

      const r2 = await TechnicianService.runDocumentExpiryCheck();
      expect(r2.notifiedExpired).toBe(0);
      expect(mockSendEmail.mock.calls.length).toBe(c1);
    });
  });

  // =========================================================================
  // 9. EMAIL NOTIFICATIONS
  // =========================================================================
  describe('9. Email Notifications on Status Events', () => {
    it('approve sends email with "Approved" in subject; sets user.status=active', async () => {
      tech1Profile.verificationStatus = 'pending_review';
      await tech1Profile.save();
      await request(app).post(`/api/v1/technicians/${tech1Profile._id}/approve`).set('Authorization', `Bearer ${adminToken}`);
      expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: tech1User.email, subject: expect.stringContaining('Approved') }));
      const u = await User.findById(tech1User._id);
      expect(u?.status).toBe('active');
    });

    it('reject sends email with "Status Update" in subject', async () => {
      tech1Profile.verificationStatus = 'pending_review';
      await tech1Profile.save();
      await request(app).post(`/api/v1/technicians/${tech1Profile._id}/reject`).set('Authorization', `Bearer ${adminToken}`).send({ reason: 'Background check failed' });
      expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: tech1User.email, subject: expect.stringContaining('Status Update') }));
    });

    it('suspend sends email with "Suspended" in subject', async () => {
      tech1Profile.verificationStatus = 'approved';
      await tech1Profile.save();
      await User.updateOne({ _id: tech1User._id }, { status: 'active', isActive: true });
      await request(app).post(`/api/v1/technicians/${tech1Profile._id}/suspend`).set('Authorization', `Bearer ${adminToken}`).send({ reason: 'Violation' });
      expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: tech1User.email, subject: expect.stringContaining('Suspended') }));
    });
  });

  // =========================================================================
  // 10. CRON ENDPOINT SECURITY
  // =========================================================================
  describe('10. Cron Endpoint Security', () => {
    const origSecret = process.env.CRON_SECRET;
    afterAll(() => { process.env.CRON_SECRET = origSecret; });

    it('rejects when CRON_SECRET is unset (401)', async () => {
      delete process.env.CRON_SECRET;
      const res = await request(app).post('/api/v1/technicians/cron/document-expiry-check').set('Authorization', 'Bearer anything');
      expect(res.status).toBe(401);
    });

    it('rejects wrong token (401)', async () => {
      process.env.CRON_SECRET = 'correct-secret';
      const res = await request(app).post('/api/v1/technicians/cron/document-expiry-check').set('Authorization', 'Bearer wrong');
      expect(res.status).toBe(401);
    });

    it('accepts correct cron secret (200)', async () => {
      process.env.CRON_SECRET = 'correct-secret';
      const res = await request(app).post('/api/v1/technicians/cron/document-expiry-check').set('Authorization', 'Bearer correct-secret');
      expect(res.status).toBe(200);
    });

    it('admin JWT alone is NOT a valid cron secret (401)', async () => {
      process.env.CRON_SECRET = 'correct-secret';
      const res = await request(app).post('/api/v1/technicians/cron/document-expiry-check').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // 11. DOCUMENT DELETE — storage asset removed; blocked when approved
  // =========================================================================
  describe('11. Document Delete & Storage Lifecycle', () => {
    it('delete calls storage deleteDocument and removes record', async () => {
      const { deleteDocument } = await import('../services/storageService');
      const docId = new mongoose.Types.ObjectId();
      tech1Profile.documents.push({ _id: docId, type: 'id', storageRef: 'test/to-delete', status: 'pending', resourceType: 'image' });
      await tech1Profile.save();
      const res = await request(app).delete(`/api/v1/technicians/me/documents/${docId}`).set('Authorization', `Bearer ${tech1Token}`);
      expect(res.status).toBe(200);
      expect(deleteDocument).toHaveBeenCalledTimes(1);
    });

    it('cannot delete doc when verificationStatus is approved (403)', async () => {
      tech1Profile.verificationStatus = 'approved';
      const docId = new mongoose.Types.ObjectId();
      tech1Profile.documents.push({ _id: docId, type: 'id', storageRef: 'test/approved-doc', status: 'approved' });
      await tech1Profile.save();
      const res = await request(app).delete(`/api/v1/technicians/me/documents/${docId}`).set('Authorization', `Bearer ${tech1Token}`);
      expect(res.status).toBe(403);
    });

    it('storage failure leaves no orphan document in DB', async () => {
      const { uploadDocument: mockUpload } = await import('../services/storageService');
      vi.mocked(mockUpload).mockRejectedValueOnce(new Error('Cloudinary timeout'));

      const countBefore = tech1Profile.documents.length;
      const res = await request(app)
        .post('/api/v1/technicians/me/documents')
        .set('Authorization', `Bearer ${tech1Token}`)
        .field('type', 'license')
        .attach('document', makeValidJpeg(), { filename: 'fail.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(500);

      // Verify no document was saved in database
      const reloaded = await TechnicianProfile.findById(tech1Profile._id);
      expect(reloaded?.documents.length).toBe(countBefore);
    });

    it('admin document view triggers audit logging without exposing URL', async () => {
      const docId = new mongoose.Types.ObjectId();
      tech1Profile.documents.push({ _id: docId, type: 'id', storageRef: 'test/audit-ref', status: 'pending' });
      await tech1Profile.save();

      const res = await request(app)
        .get(`/api/v1/technicians/${tech1Profile._id}/documents/${docId}/url`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.url).toBeDefined();
    });
  });

  // =========================================================================
  // 12. /apply — role change analysis
  // =========================================================================
  describe('12. POST /technicians/apply — role change', () => {
    it('converts customer role to technician; creates draft profile', async () => {
      const res = await request(app).post('/api/v1/technicians/apply').set('Authorization', `Bearer ${customerToken}`);
      expect(res.status).toBe(200);
      const u = await User.findById(customerUser._id);
      expect(u?.role).toBe('technician');
      expect(u?.status).toBe('pending');
      const profile = await TechnicianProfile.findOne({ userId: customerUser._id });
      expect(profile).toBeTruthy();
      expect(profile?.verificationStatus).toBe('draft');
    });

    it('returns 409 ACTIVE_BOOKINGS when customer has pending/confirmed upcoming bookings', async () => {
      // Seed an active upcoming booking for the customer
      const fakeCatId = new mongoose.Types.ObjectId();
      const fakeSvcId = new mongoose.Types.ObjectId();
      await Booking.create({
        bookingNumber: 'GIS-TEST-001',
        guest: { fullName: customerUser.fullName, email: customerUser.email, phone: '555-0000' },
        customerId: customerUser._id,
        categoryId: fakeCatId,
        serviceId: fakeSvcId,
        status: 'confirmed',
        scheduledAt: new Date(Date.now() + 86400000), // tomorrow
        scheduledLocal: { date: '2099-01-01', slot: '10:00' },
        bookingTimezone: 'America/New_York',
        vehicleSnapshot: { category: 'sedan', make: 'Toyota', model: 'Camry', year: 2023 },
        serviceSnapshot: { name: 'Test Service', slug: 'test-service' },
        address: { freeText: '123 Main St' },
        pricing: {
          baseCents: 10000, addonsCents: 0, discountCents: 0,
          couponCode: null, couponPercent: 0, taxCents: 0, totalCents: 10000,
          commissionPercent: 15, processingPercent: 3,
          commissionCents: 1500, processingCents: 300, providerPayoutCents: 8200,
        },
        source: 'web',
        statusHistory: [{ status: 'confirmed', by: 'system', at: new Date() }],
      });

      const res = await request(app).post('/api/v1/technicians/apply').set('Authorization', `Bearer ${customerToken}`);
      expect(res.status).toBe(409);
      expect(res.body.error?.code).toBe('ACTIVE_BOOKINGS');
      expect(res.body.message).toMatch(/active upcoming bookings/i);
    });

    it('succeeds when customer has only past or cancelled bookings', async () => {
      const pastCustomer = await User.create({
        fullName: 'Past Customer',
        email: `pastcustomer_${Date.now()}@example.com`,
        password: 'Password123!',
        role: 'customer',
        status: 'active',
        isActive: true,
        emailVerified: true,
      });
      const pastToken = generateAccessToken({
        userId: pastCustomer._id.toString(),
        email: pastCustomer.email,
        role: 'customer',
        status: 'active',
        emailVerified: true,
      });

      // 1 past booking (scheduled in past)
      await Booking.create({
        bookingNumber: `GIS-PAST-${Date.now()}`,
        guest: { fullName: pastCustomer.fullName, email: pastCustomer.email, phone: '555-1111' },
        customerId: pastCustomer._id,
        categoryId: new mongoose.Types.ObjectId(),
        serviceId: new mongoose.Types.ObjectId(),
        status: 'confirmed',
        scheduledAt: new Date(Date.now() - 86400000), // yesterday
        scheduledLocal: { date: '2020-01-01', slot: '10:00' },
        bookingTimezone: 'America/New_York',
        vehicleSnapshot: { category: 'sedan', make: 'Toyota', model: 'Camry', year: 2020 },
        serviceSnapshot: { name: 'Past Service', slug: 'past-service' },
        address: { freeText: '123 Past St' },
        pricing: {
          baseCents: 10000, addonsCents: 0, discountCents: 0,
          couponCode: null, couponPercent: 0, taxCents: 0, totalCents: 10000,
          commissionPercent: 15, processingPercent: 3,
          commissionCents: 1500, processingCents: 300, providerPayoutCents: 8200,
        },
        source: 'web',
        statusHistory: [{ status: 'confirmed', by: 'system', at: new Date() }],
      });

      // 1 cancelled booking in future
      await Booking.create({
        bookingNumber: `GIS-CANCELLED-${Date.now()}`,
        guest: { fullName: pastCustomer.fullName, email: pastCustomer.email, phone: '555-1111' },
        customerId: pastCustomer._id,
        categoryId: new mongoose.Types.ObjectId(),
        serviceId: new mongoose.Types.ObjectId(),
        status: 'cancelled',
        scheduledAt: new Date(Date.now() + 86400000), // tomorrow but cancelled
        scheduledLocal: { date: '2099-01-01', slot: '10:00' },
        bookingTimezone: 'America/New_York',
        vehicleSnapshot: { category: 'sedan', make: 'Toyota', model: 'Camry', year: 2020 },
        serviceSnapshot: { name: 'Cancelled Service', slug: 'cancelled-service' },
        address: { freeText: '123 Past St' },
        pricing: {
          baseCents: 10000, addonsCents: 0, discountCents: 0,
          couponCode: null, couponPercent: 0, taxCents: 0, totalCents: 10000,
          commissionPercent: 15, processingPercent: 3,
          commissionCents: 1500, processingCents: 300, providerPayoutCents: 8200,
        },
        source: 'web',
        statusHistory: [{ status: 'cancelled', by: 'system', at: new Date() }],
      });

      const res = await request(app).post('/api/v1/technicians/apply').set('Authorization', `Bearer ${pastToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const updated = await User.findById(pastCustomer._id);
      expect(updated?.role).toBe('technician');
    });
  });
});
