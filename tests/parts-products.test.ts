import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import app from '../app';
import { User, IUser } from '../models/User';
import { SupplierProfile, ISupplierProfile } from '../models/SupplierProfile';
import { PartCategory } from '../models/PartCategory';
import { PartProduct } from '../models/PartProduct';
import { InventoryLog } from '../models/InventoryLog';
import { generateAccessToken } from '../utils/jwt';

// ---------------------------------------------------------------------------
// Mock Cloudinary (product image upload uses upload_stream)
// ---------------------------------------------------------------------------
vi.mock('cloudinary', () => ({
  v2: {
    config: vi.fn(),
    uploader: {
      upload: vi.fn().mockResolvedValue({ secure_url: 'https://res.cloudinary.com/test/image/parts/product1.jpg' }),
      upload_stream: vi.fn().mockImplementation((_opts: unknown, cb: (err: null, res: { secure_url: string }) => void) => {
        const fakeStream = {
          end: (buffer: Buffer) => {
            // Simulate PNG check: if buffer starts with PNG signature treat as success, else error
            if (buffer && buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50) {
              cb(null, { secure_url: 'https://res.cloudinary.com/test/image/parts/uploaded.png' });
            } else if (buffer && buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
              cb(null, { secure_url: 'https://res.cloudinary.com/test/image/parts/uploaded.jpg' });
            } else {
              cb(null, { secure_url: 'https://res.cloudinary.com/test/image/parts/uploaded.jpg' });
            }
          },
        };
        return fakeStream;
      }),
      destroy: vi.fn().mockResolvedValue({ result: 'ok' }),
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock storageService (supplier document uploads, not needed here but suppress import errors)
// ---------------------------------------------------------------------------
vi.mock('../services/storageService', () => ({
  uploadDocument: vi.fn().mockResolvedValue({ publicId: 'test/doc', resourceType: 'image' }),
  deleteDocument: vi.fn().mockResolvedValue(undefined),
  generateSignedUrl: vi.fn().mockReturnValue('https://signed.url/doc'),
  validateFileBuffer: vi.fn().mockResolvedValue(undefined),
  ALLOWED_MIME_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
  MAX_SIZE_BYTES: 5 * 1024 * 1024,
}));

// ---------------------------------------------------------------------------
// Mock emailService
// ---------------------------------------------------------------------------
vi.mock('../services/emailService', () => ({
  sendEmail: vi.fn().mockResolvedValue({ messageId: 'test-id' }),
  getEmailVerificationEmail: vi.fn().mockReturnValue('<p>Verify</p>'),
  getSupplierApplicationReceivedEmail: vi.fn().mockReturnValue('<p>Received</p>'),
  getSupplierNewApplicationAdminEmail: vi.fn().mockReturnValue('<p>Admin</p>'),
  getSupplierApprovedEmail: vi.fn().mockReturnValue('<p>Approved</p>'),
  getSupplierRejectedEmail: vi.fn().mockReturnValue('<p>Rejected</p>'),
  getSupplierSuspendedEmail: vi.fn().mockReturnValue('<p>Suspended</p>'),
  getSupplierReinstatedEmail: vi.fn().mockReturnValue('<p>Reinstated</p>'),
  getSupplierDocumentRejectedEmail: vi.fn().mockReturnValue('<p>Doc Rejected</p>'),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeJpeg() { return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]); }
function makePng() { return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); }
function makeExe() { return Buffer.from([0x4d, 0x5a, 0x90, 0x00]); }

const VALID_PRODUCT = {
  name: 'Premium Brake Pad Set',
  sku: 'BRK-001',
  brand: 'BrakeMaster',
  description: 'High-performance ceramic brake pads for most sedans',
  category: 'brakes',
  priceCents: 4999,
  stockQuantity: 50,
  condition: 'new' as const,
};

describe('Parts Product Catalogue & Inventory Backend Test Suite', () => {
  let mongoServer: MongoMemoryServer;

  let adminUser: IUser;
  let adminToken: string;
  let customerUser: IUser;
  let customerToken: string;

  // Supplier 1 — approved
  let supplier1User: IUser;
  let supplier1Profile: ISupplierProfile;
  let supplier1Token: string;

  // Supplier 2 — approved (for isolation tests)
  let supplier2User: IUser;
  let supplier2Profile: ISupplierProfile;
  let supplier2Token: string;

  // Supplier 3 — pending (unapproved)
  let supplier3User: IUser;
  let supplier3Token: string;

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
    await PartProduct.deleteMany({});
    await InventoryLog.deleteMany({});
    await PartCategory.deleteMany({});

    await PartCategory.create([
      { slug: 'brakes', name: 'Brakes', isActive: true, sortOrder: 1 },
      { slug: 'engine-parts', name: 'Engine Parts', isActive: true, sortOrder: 2 },
      { slug: 'batteries', name: 'Batteries', isActive: true, sortOrder: 3 },
    ]);

    // Admin
    adminUser = await User.create({
      email: 'admin@parts.test',
      password: 'password123',
      fullName: 'Parts Admin',
      role: 'admin',
      status: 'active',
      isActive: true,
      emailVerified: true,
    });
    adminToken = generateAccessToken({ userId: adminUser._id.toString(), email: adminUser.email, role: 'admin', status: 'active', emailVerified: true });

    // Customer
    customerUser = await User.create({
      email: 'customer@parts.test',
      password: 'password123',
      fullName: 'Test Customer',
      role: 'customer',
      status: 'active',
      isActive: true,
      emailVerified: true,
    });
    customerToken = generateAccessToken({ userId: customerUser._id.toString(), email: customerUser.email, role: 'customer', status: 'active', emailVerified: true });

    // Supplier 1 — approved
    supplier1User = await User.create({
      email: 'supplier1@parts.test',
      password: 'password123',
      fullName: 'Supplier One',
      role: 'supplier',
      status: 'active',
      isActive: true,
      emailVerified: true,
    });
    supplier1Profile = await SupplierProfile.create({
      userId: supplier1User._id,
      companyName: 'Detroit Parts Co',
      businessType: 'manufacturer',
      contactName: 'John Smith',
      contactEmail: 'john@detroit.test',
      businessAddress: { street: '123 Main St', city: 'Detroit', state: 'MI', postalCode: '48201', country: 'US' },
      partsCategories: ['brakes', 'engine-parts'],
      verificationStatus: 'approved',
      submissionStatus: 'submitted',
    });
    supplier1Token = generateAccessToken({ userId: supplier1User._id.toString(), email: supplier1User.email, role: 'supplier', status: 'active', emailVerified: true });

    // Supplier 2 — approved
    supplier2User = await User.create({
      email: 'supplier2@parts.test',
      password: 'password123',
      fullName: 'Supplier Two',
      role: 'supplier',
      status: 'active',
      isActive: true,
      emailVerified: true,
    });
    supplier2Profile = await SupplierProfile.create({
      userId: supplier2User._id,
      companyName: 'Chicago Auto Parts',
      businessType: 'distributor',
      contactName: 'Jane Doe',
      contactEmail: 'jane@chicago.test',
      businessAddress: { street: '456 Oak Ave', city: 'Chicago', state: 'IL', postalCode: '60601', country: 'US' },
      partsCategories: ['batteries'],
      verificationStatus: 'approved',
      submissionStatus: 'submitted',
    });
    supplier2Token = generateAccessToken({ userId: supplier2User._id.toString(), email: supplier2User.email, role: 'supplier', status: 'active', emailVerified: true });

    // Supplier 3 — pending (not approved)
    supplier3User = await User.create({
      email: 'supplier3@parts.test',
      password: 'password123',
      fullName: 'Supplier Three',
      role: 'supplier',
      status: 'active',
      isActive: true,
      emailVerified: true,
    });
    await SupplierProfile.create({
      userId: supplier3User._id,
      companyName: 'New Startup Parts',
      businessType: 'retailer',
      contactName: 'Bob New',
      contactEmail: 'bob@startup.test',
      businessAddress: { street: '789 Pine Rd', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
      partsCategories: ['filters'],
      verificationStatus: 'pending_review',
      submissionStatus: 'submitted',
    });
    supplier3Token = generateAccessToken({ userId: supplier3User._id.toString(), email: supplier3User.email, role: 'supplier', status: 'active', emailVerified: true });
  });

  // ===========================================================================
  // 1. Category: Seeding & Public Listing
  // ===========================================================================
  describe('Part Categories', () => {
    it('GET /api/v1/parts/categories — public, returns active categories', async () => {
      const res = await request(app).get('/api/v1/parts/categories').expect(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(3);
      expect(res.body.data[0]).toHaveProperty('slug');
      expect(res.body.data[0]).toHaveProperty('name');
    });

    it('GET /api/v1/parts/admin/categories — admin sees all (including inactive)', async () => {
      // Make one inactive
      await PartCategory.findOneAndUpdate({ slug: 'batteries' }, { isActive: false });
      const res = await request(app)
        .get('/api/v1/parts/admin/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.success).toBe(true);
      // Should include batteries (inactive)
      const slugs = res.body.data.map((c: { slug: string }) => c.slug);
      expect(slugs).toContain('batteries');
    });

    it('GET /api/v1/parts/admin/categories — requires admin role', async () => {
      await request(app)
        .get('/api/v1/parts/admin/categories')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .expect(403);
    });

    it('POST /api/v1/parts/admin/categories — admin creates a category', async () => {
      const res = await request(app)
        .post('/api/v1/parts/admin/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ slug: 'test-cat', name: 'Test Category', sortOrder: 99 })
        .expect(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.slug).toBe('test-cat');
    });

    it('POST /api/v1/parts/admin/categories — rejects duplicate slug', async () => {
      await request(app)
        .post('/api/v1/parts/admin/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ slug: 'brakes', name: 'Duplicate Brakes' })
        .expect(409);
    });

    it('PUT /api/v1/parts/admin/categories/:slug — admin updates category', async () => {
      const res = await request(app)
        .put('/api/v1/parts/admin/categories/brakes')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Brake Systems', description: 'Updated description' })
        .expect(200);
      expect(res.body.data.name).toBe('Brake Systems');
    });

    it('PUT /api/v1/parts/admin/categories/:slug — 404 for unknown slug', async () => {
      await request(app)
        .put('/api/v1/parts/admin/categories/does-not-exist')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Ghost' })
        .expect(404);
    });
  });

  // ===========================================================================
  // 2. Supplier: Product CRUD
  // ===========================================================================
  describe('Supplier Product CRUD', () => {
    it('POST /api/v1/parts/products — supplier creates a draft product', async () => {
      const res = await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send(VALID_PRODUCT)
        .expect(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe(VALID_PRODUCT.name);
      expect(res.body.data.sku).toBe('BRK-001');
      expect(res.body.data.status).toBe('draft');
      // adminNotes must NOT be exposed
      expect(res.body.data).not.toHaveProperty('adminNotes');
    });

    it('POST /api/v1/parts/products — creates initial inventory log when stock > 0', async () => {
      const res = await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send({ ...VALID_PRODUCT, stockQuantity: 25 })
        .expect(201);
      const productId = res.body.data._id;
      const log = await InventoryLog.findOne({ productId });
      expect(log).not.toBeNull();
      expect(log!.newQuantity).toBe(25);
      expect(log!.reason).toBe('initial_stock');
    });

    it('POST /api/v1/parts/products — no inventory log when stock = 0', async () => {
      const res = await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send({ ...VALID_PRODUCT, sku: 'BRK-ZERO', stockQuantity: 0 })
        .expect(201);
      const productId = res.body.data._id;
      const log = await InventoryLog.findOne({ productId });
      expect(log).toBeNull();
    });

    it('POST /api/v1/parts/products — rejects invalid category', async () => {
      const res = await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send({ ...VALID_PRODUCT, sku: 'BRK-002', category: 'nonexistent-cat' })
        .expect(400);
      expect(res.body.success).toBe(false);
    });

    it('POST /api/v1/parts/products — requires supplier role', async () => {
      await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${customerToken}`)
        .send(VALID_PRODUCT)
        .expect(403);
    });

    it('POST /api/v1/parts/products — requires auth', async () => {
      await request(app)
        .post('/api/v1/parts/products')
        .send(VALID_PRODUCT)
        .expect(401);
    });

    it('GET /api/v1/parts/products — supplier lists own products only', async () => {
      // Supplier 1 creates product
      await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send(VALID_PRODUCT)
        .expect(201);
      // Supplier 2 creates product
      await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier2Token}`)
        .send({ ...VALID_PRODUCT, sku: 'BAT-001', name: 'Car Battery', category: 'batteries' })
        .expect(201);

      const res1 = await request(app)
        .get('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .expect(200);
      expect(res1.body.products.length).toBe(1);
      expect(res1.body.products[0].name).toBe(VALID_PRODUCT.name);

      const res2 = await request(app)
        .get('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier2Token}`)
        .expect(200);
      expect(res2.body.products.length).toBe(1);
      expect(res2.body.products[0].name).toBe('Car Battery');
    });

    it('GET /api/v1/parts/products/:id — supplier gets own product', async () => {
      const createRes = await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send(VALID_PRODUCT)
        .expect(201);
      const productId = createRes.body.data._id;

      const res = await request(app)
        .get(`/api/v1/parts/products/${productId}`)
        .set('Authorization', `Bearer ${supplier1Token}`)
        .expect(200);
      expect(res.body.data._id).toBe(productId);
    });

    it('GET /api/v1/parts/products/:id — supplier cannot get another supplier product (ownership isolation)', async () => {
      const createRes = await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send(VALID_PRODUCT)
        .expect(201);
      const productId = createRes.body.data._id;

      await request(app)
        .get(`/api/v1/parts/products/${productId}`)
        .set('Authorization', `Bearer ${supplier2Token}`)
        .expect(404);
    });

    it('PUT /api/v1/parts/products/:id — supplier updates own product', async () => {
      const createRes = await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send(VALID_PRODUCT)
        .expect(201);
      const productId = createRes.body.data._id;

      const res = await request(app)
        .put(`/api/v1/parts/products/${productId}`)
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send({ name: 'Updated Brake Pad Set', priceCents: 5999 })
        .expect(200);
      expect(res.body.data.name).toBe('Updated Brake Pad Set');
      expect(res.body.data.priceCents).toBe(5999);
    });

    it('PUT /api/v1/parts/products/:id — supplier cannot update another supplier product', async () => {
      const createRes = await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send(VALID_PRODUCT)
        .expect(201);
      const productId = createRes.body.data._id;

      await request(app)
        .put(`/api/v1/parts/products/${productId}`)
        .set('Authorization', `Bearer ${supplier2Token}`)
        .send({ name: 'Hijacked Name' })
        .expect(404);
    });

    it('DELETE /api/v1/parts/products/:id — archives own product (status → archived)', async () => {
      const createRes = await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send(VALID_PRODUCT)
        .expect(201);
      const productId = createRes.body.data._id;

      const res = await request(app)
        .delete(`/api/v1/parts/products/${productId}`)
        .set('Authorization', `Bearer ${supplier1Token}`)
        .expect(200);
      expect(res.body.data.status).toBe('archived');
    });
  });

  // ===========================================================================
  // 3. SKU Uniqueness
  // ===========================================================================
  describe('SKU Uniqueness', () => {
    it('different suppliers can use the same SKU', async () => {
      await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send({ ...VALID_PRODUCT, sku: 'SHARED-SKU-001', category: 'brakes' })
        .expect(201);

      await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier2Token}`)
        .send({ ...VALID_PRODUCT, sku: 'SHARED-SKU-001', category: 'batteries' })
        .expect(201);
    });

    it('same supplier cannot use duplicate SKU', async () => {
      await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send(VALID_PRODUCT)
        .expect(201);

      const res = await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send({ ...VALID_PRODUCT, name: 'Another Product Same SKU' })
        .expect(409);
      expect(res.body.error.code).toBe('DUPLICATE_SKU');
    });
  });

  // ===========================================================================
  // 4. Status Transitions
  // ===========================================================================
  describe('Product Status Transitions', () => {
    it('supplier can submit draft to pending_review', async () => {
      const createRes = await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send(VALID_PRODUCT)
        .expect(201);
      const productId = createRes.body.data._id;

      const res = await request(app)
        .put(`/api/v1/parts/products/${productId}`)
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send({ status: 'pending_review' })
        .expect(200);
      expect(res.body.data.status).toBe('pending_review');
    });

    it('supplier cannot directly activate a product', async () => {
      const createRes = await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send(VALID_PRODUCT)
        .expect(201);
      const productId = createRes.body.data._id;

      await request(app)
        .put(`/api/v1/parts/products/${productId}`)
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send({ status: 'active' })
        .expect(400);
    });

    it('unapproved supplier (pending_review) can create draft products but cannot get active status', async () => {
      const createRes = await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier3Token}`)
        .send({ ...VALID_PRODUCT, sku: 'S3-001' })
        .expect(201);
      expect(createRes.body.data.status).toBe('draft');

      // Try to set active directly — should fail (supplier cannot set active)
      await request(app)
        .put(`/api/v1/parts/products/${createRes.body.data._id}`)
        .set('Authorization', `Bearer ${supplier3Token}`)
        .send({ status: 'active' })
        .expect(400);
    });
  });

  // ===========================================================================
  // 5. Admin Product Management
  // ===========================================================================
  describe('Admin Product Management', () => {
    let product1Id: string;

    beforeEach(async () => {
      // Create and submit a product from supplier 1
      const createRes = await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send(VALID_PRODUCT)
        .expect(201);
      product1Id = createRes.body.data._id;

      // Submit to pending_review
      await request(app)
        .put(`/api/v1/parts/products/${product1Id}`)
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send({ status: 'pending_review' })
        .expect(200);
    });

    it('GET /api/v1/parts/admin/products — admin lists all products', async () => {
      const res = await request(app)
        .get('/api/v1/parts/admin/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.meta.total).toBeGreaterThanOrEqual(1);
    });

    it('GET /api/v1/parts/admin/products — requires admin role', async () => {
      await request(app)
        .get('/api/v1/parts/admin/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .expect(403);
    });

    it('GET /api/v1/parts/admin/products/:id — admin gets product (includes adminNotes)', async () => {
      const res = await request(app)
        .get(`/api/v1/parts/admin/products/${product1Id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.data._id).toBe(product1Id);
    });

    it('POST /api/v1/parts/admin/products/:id/approve — admin approves product from approved supplier', async () => {
      const res = await request(app)
        .post(`/api/v1/parts/admin/products/${product1Id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ note: 'Looks good' })
        .expect(200);
      expect(res.body.data.status).toBe('active');
    });

    it('POST /api/v1/parts/admin/products/:id/approve — cannot approve if supplier not approved', async () => {
      // Create product for unapproved supplier 3
      const createRes = await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier3Token}`)
        .send({ ...VALID_PRODUCT, sku: 'S3-PEND-001' })
        .expect(201);
      const pendingProductId = createRes.body.data._id;
      // Manually set to pending_review via DB
      await PartProduct.findByIdAndUpdate(pendingProductId, { status: 'pending_review' });

      const res = await request(app)
        .post(`/api/v1/parts/admin/products/${pendingProductId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
      expect(res.body.error.code).toBe('SUPPLIER_NOT_APPROVED');
    });

    it('POST /api/v1/parts/admin/products/:id/reject — admin rejects product with reason', async () => {
      const res = await request(app)
        .post(`/api/v1/parts/admin/products/${product1Id}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Images are too low quality' })
        .expect(200);
      expect(res.body.data.status).toBe('rejected');
      expect(res.body.data.rejectionReason).toBe('Images are too low quality');
    });

    it('POST /api/v1/parts/admin/products/:id/reject — requires reason', async () => {
      await request(app)
        .post(`/api/v1/parts/admin/products/${product1Id}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})
        .expect(400);
    });

    it('POST /api/v1/parts/admin/products/:id/archive — admin archives any product', async () => {
      const res = await request(app)
        .post(`/api/v1/parts/admin/products/${product1Id}/archive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Policy violation' })
        .expect(200);
      expect(res.body.data.status).toBe('archived');
    });
  });

  // ===========================================================================
  // 6. Inventory: Stock Adjustment
  // ===========================================================================
  describe('Inventory & Stock Management', () => {
    let productId: string;

    beforeEach(async () => {
      const createRes = await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send({ ...VALID_PRODUCT, stockQuantity: 100 })
        .expect(201);
      productId = createRes.body.data._id;
    });

    it('PATCH /api/v1/parts/products/:id/stock — adjusts stock by change value', async () => {
      const res = await request(app)
        .patch(`/api/v1/parts/products/${productId}/stock`)
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send({ change: -10, reason: 'manual_adjustment', notes: 'Test decrement' })
        .expect(200);
      expect(res.body.data.stockQuantity).toBe(90);
    });

    it('PATCH /api/v1/parts/products/:id/stock — adjusts stock to exact newQuantity', async () => {
      const res = await request(app)
        .patch(`/api/v1/parts/products/${productId}/stock`)
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send({ newQuantity: 200, reason: 'restock' })
        .expect(200);
      expect(res.body.data.stockQuantity).toBe(200);
    });

    it('PATCH /api/v1/parts/products/:id/stock — prevents negative stock', async () => {
      const res = await request(app)
        .patch(`/api/v1/parts/products/${productId}/stock`)
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send({ change: -200, reason: 'damaged' })
        .expect(400);
      expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    });

    it('PATCH /api/v1/parts/products/:id/stock — creates inventory log entry', async () => {
      await InventoryLog.deleteMany({ productId });
      await request(app)
        .patch(`/api/v1/parts/products/${productId}/stock`)
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send({ change: 50, reason: 'restock', notes: 'Restocked from warehouse' })
        .expect(200);

      const log = await InventoryLog.findOne({ productId, reason: 'restock' });
      expect(log).not.toBeNull();
      expect(log!.change).toBe(50);
      expect(log!.notes).toBe('Restocked from warehouse');
    });

    it('PATCH /api/v1/parts/products/:id/stock — requires either change or newQuantity', async () => {
      await request(app)
        .patch(`/api/v1/parts/products/${productId}/stock`)
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send({ reason: 'audit' })
        .expect(400);
    });

    it('GET /api/v1/parts/products/:id/inventory — supplier gets own inventory history', async () => {
      await request(app)
        .patch(`/api/v1/parts/products/${productId}/stock`)
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send({ change: 10, reason: 'restock' })
        .expect(200);

      const res = await request(app)
        .get(`/api/v1/parts/products/${productId}/inventory`)
        .set('Authorization', `Bearer ${supplier1Token}`)
        .expect(200);
      expect(res.body.logs.length).toBeGreaterThanOrEqual(1);
      expect(res.body.meta).toHaveProperty('total');
    });

    it('GET /api/v1/parts/products/:id/inventory — supplier cannot get another supplier inventory history', async () => {
      await request(app)
        .get(`/api/v1/parts/products/${productId}/inventory`)
        .set('Authorization', `Bearer ${supplier2Token}`)
        .expect(404);
    });

    it('GET /api/v1/parts/admin/products/:id/inventory — admin gets inventory history for any product', async () => {
      const res = await request(app)
        .get(`/api/v1/parts/admin/products/${productId}/inventory`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.meta).toHaveProperty('total');
    });
  });

  // ===========================================================================
  // 7. Image Upload
  // ===========================================================================
  describe('Product Image Upload', () => {
    let productId: string;

    beforeEach(async () => {
      const createRes = await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send(VALID_PRODUCT)
        .expect(201);
      productId = createRes.body.data._id;
    });

    it('POST /api/v1/parts/products/:id/images — uploads a JPEG image', async () => {
      const jpegBuffer = makeJpeg();
      const res = await request(app)
        .post(`/api/v1/parts/products/${productId}/images`)
        .set('Authorization', `Bearer ${supplier1Token}`)
        .attach('image', jpegBuffer, { filename: 'test.jpg', contentType: 'image/jpeg' })
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.images.length).toBe(1);
      expect(res.body.data.images[0].url).toContain('cloudinary.com');
    });

    it('POST /api/v1/parts/products/:id/images — rejects non-image files', async () => {
      const exeBuffer = makeExe();
      const res = await request(app)
        .post(`/api/v1/parts/products/${productId}/images`)
        .set('Authorization', `Bearer ${supplier1Token}`)
        .attach('image', exeBuffer, { filename: 'malware.exe', contentType: 'application/octet-stream' })
        .expect(400);
      expect(res.body.success).toBe(false);
    });

    it('POST /api/v1/parts/products/:id/images — rejects if no file provided', async () => {
      await request(app)
        .post(`/api/v1/parts/products/${productId}/images`)
        .set('Authorization', `Bearer ${supplier1Token}`)
        .expect(400);
    });

    it('DELETE /api/v1/parts/products/:id/images/:index — removes image by index', async () => {
      // First upload an image
      const jpegBuffer = makeJpeg();
      await request(app)
        .post(`/api/v1/parts/products/${productId}/images`)
        .set('Authorization', `Bearer ${supplier1Token}`)
        .attach('image', jpegBuffer, { filename: 'test.jpg', contentType: 'image/jpeg' })
        .expect(200);

      // Now remove it
      const res = await request(app)
        .delete(`/api/v1/parts/products/${productId}/images/0`)
        .set('Authorization', `Bearer ${supplier1Token}`)
        .expect(200);
      expect(res.body.data.images.length).toBe(0);
    });

    it('DELETE /api/v1/parts/products/:id/images/:index — 400 on out-of-range index', async () => {
      await request(app)
        .delete(`/api/v1/parts/products/${productId}/images/99`)
        .set('Authorization', `Bearer ${supplier1Token}`)
        .expect(400);
    });
  });

  // ===========================================================================
  // 8. Marketplace: Public Browsing
  // ===========================================================================
  describe('Public Marketplace', () => {
    beforeEach(async () => {
      // Create and approve a product from supplier 1 (approved)
      const createRes = await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send({ ...VALID_PRODUCT, stockQuantity: 20 })
        .expect(201);
      const productId = createRes.body.data._id;
      // Set to pending_review
      await PartProduct.findByIdAndUpdate(productId, { status: 'pending_review' });
      // Approve via admin
      await request(app)
        .post(`/api/v1/parts/admin/products/${productId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });

    it('GET /api/v1/parts/marketplace — public, returns active products from approved suppliers', async () => {
      const res = await request(app).get('/api/v1/parts/marketplace').expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.products.length).toBe(1);
      expect(res.body.products[0].name).toBe(VALID_PRODUCT.name);
      // adminNotes & statusHistory must NOT be exposed
      expect(res.body.products[0]).not.toHaveProperty('adminNotes');
      expect(res.body.products[0]).not.toHaveProperty('statusHistory');
    });

    it('GET /api/v1/parts/marketplace — does NOT expose unapproved supplier products', async () => {
      // Create product for unapproved supplier 3 and manually set active (bypassing service for test)
      const s3Product = await PartProduct.create({
        supplierId: (await SupplierProfile.findOne({ userId: supplier3User._id }))!._id,
        name: 'Sketchy Filter',
        sku: 'S3-FILT',
        brand: 'Unknown',
        description: 'Not verified supplier product',
        category: 'filters',
        priceCents: 999,
        stockQuantity: 5,
        condition: 'new',
        status: 'active',
        statusHistory: [{ status: 'active', by: 'admin', at: new Date() }],
      });

      const res = await request(app).get('/api/v1/parts/marketplace').expect(200);
      const ids = res.body.products.map((p: { _id: string }) => p._id);
      expect(ids).not.toContain(s3Product._id.toString());
    });

    it('GET /api/v1/parts/marketplace — filter by category', async () => {
      const res = await request(app)
        .get('/api/v1/parts/marketplace?category=brakes')
        .expect(200);
      expect(res.body.products.every((p: { category: string }) => p.category === 'brakes')).toBe(true);
    });

    it('GET /api/v1/parts/marketplace — filter inStockOnly', async () => {
      const res = await request(app)
        .get('/api/v1/parts/marketplace?inStockOnly=true')
        .expect(200);
      expect(res.body.products.every((p: { stockQuantity: number }) => p.stockQuantity > 0)).toBe(true);
    });

    it('GET /api/v1/parts/marketplace/:id — public single product detail', async () => {
      const listRes = await request(app).get('/api/v1/parts/marketplace').expect(200);
      const productId = listRes.body.products[0]._id;

      const res = await request(app).get(`/api/v1/parts/marketplace/${productId}`).expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data._id).toBe(productId);
    });

    it('GET /api/v1/parts/marketplace/:id — 404 for non-active product', async () => {
      const draftProduct = await PartProduct.create({
        supplierId: supplier1Profile._id,
        name: 'Draft Only Product',
        sku: 'DRAFT-ONLY',
        brand: 'TestBrand',
        description: 'This should not be visible in marketplace',
        category: 'brakes',
        priceCents: 1999,
        stockQuantity: 10,
        condition: 'new',
        status: 'draft',
        statusHistory: [{ status: 'draft', by: 'supplier', at: new Date() }],
      });

      await request(app)
        .get(`/api/v1/parts/marketplace/${draftProduct._id}`)
        .expect(404);
    });
  });

  // ===========================================================================
  // 9. Vehicle Compatibility Filtering
  // ===========================================================================
  describe('Vehicle Compatibility', () => {
    it('marketplace filters by vehicle make/model', async () => {
      // Create & approve a product with compatibility
      const createRes = await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send({
          ...VALID_PRODUCT,
          sku: 'COMPAT-001',
          compatibility: [{ make: 'Toyota', model: 'Camry', yearStart: 2015, yearEnd: 2023 }],
        })
        .expect(201);
      const productId = createRes.body.data._id;
      await PartProduct.findByIdAndUpdate(productId, { status: 'pending_review' });
      await request(app)
        .post(`/api/v1/parts/admin/products/${productId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      // Filter by make
      const res = await request(app)
        .get('/api/v1/parts/marketplace?make=Toyota')
        .expect(200);
      const ids = res.body.products.map((p: { _id: string }) => p._id);
      expect(ids).toContain(productId);

      // Filter by model — should not return product for Honda
      const res2 = await request(app)
        .get('/api/v1/parts/marketplace?make=Honda&model=Accord')
        .expect(200);
      const ids2 = res2.body.products.map((p: { _id: string }) => p._id);
      expect(ids2).not.toContain(productId);
    });
  });

  // ===========================================================================
  // 10. Input Validation
  // ===========================================================================
  describe('Input Validation', () => {
    it('POST /api/v1/parts/products — missing required fields returns 400', async () => {
      await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send({ name: 'Incomplete Product' })
        .expect(400);
    });

    it('POST /api/v1/parts/products — negative price returns 400', async () => {
      await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send({ ...VALID_PRODUCT, priceCents: -100 })
        .expect(400);
    });

    it('PATCH /api/v1/parts/products/:id/stock — negative newQuantity returns 400', async () => {
      const createRes = await request(app)
        .post('/api/v1/parts/products')
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send(VALID_PRODUCT)
        .expect(201);

      await request(app)
        .patch(`/api/v1/parts/products/${createRes.body.data._id}/stock`)
        .set('Authorization', `Bearer ${supplier1Token}`)
        .send({ newQuantity: -5, reason: 'audit' })
        .expect(400);
    });
  });
});
