import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../app';
import { ServiceCategory } from '../models/ServiceCategory';
import { Service } from '../models/Service';
import { ServicePrice } from '../models/ServicePrice';
import { Addon } from '../models/Addon';
import { CommissionRule } from '../models/CommissionRule';
import { Coupon } from '../models/Coupon';
import { Appointment } from '../models/Appointment';
import { BookingSettings } from '../models/BookingSettings';
import { generateAccessToken } from '../utils/jwt';
import { PricingService } from '../modules/pricing/service';
import { seedCatalog, SEED_DATA } from '../scripts/seedCatalog';

// Reference copy of values from src/data/pricing.ts for parity verification
const PRICING_DATA = [
  // Interior Only
  { serviceType: 'Interior Only', vehicleCategory: 'Sedan', price: 228.99 },
  { serviceType: 'Interior Only', vehicleCategory: 'CrossOver', price: 238.99 },
  { serviceType: 'Interior Only', vehicleCategory: 'SUV', price: 248.99 },
  { serviceType: 'Interior Only', vehicleCategory: 'Truck', price: 268.99 },
  { serviceType: 'Interior Only', vehicleCategory: 'RV/Boat/Semi', price: 468.99 },

  // Exterior Only
  { serviceType: 'Exterior Only', vehicleCategory: 'Sedan', price: 228.99 },
  { serviceType: 'Exterior Only', vehicleCategory: 'CrossOver', price: 238.99 },
  { serviceType: 'Exterior Only', vehicleCategory: 'SUV', price: 248.99 },
  { serviceType: 'Exterior Only', vehicleCategory: 'Truck', price: 268.99 },
  { serviceType: 'Exterior Only', vehicleCategory: 'RV/Boat/Semi', price: 468.99 },

  // Interior and Exterior Both
  { serviceType: 'Interior and Exterior Both', vehicleCategory: 'Sedan', price: 248.99 },
  { serviceType: 'Interior and Exterior Both', vehicleCategory: 'CrossOver', price: 268.99 },
  { serviceType: 'Interior and Exterior Both', vehicleCategory: 'SUV', price: 288.99 },
  { serviceType: 'Interior and Exterior Both', vehicleCategory: 'Truck', price: 298.99 },
  { serviceType: 'Interior and Exterior Both', vehicleCategory: 'RV/Boat/Semi', price: 628.99 },

  // Super Wax Detail
  { serviceType: 'Super Wax Detail', vehicleCategory: 'Sedan', price: 278.99 },
  { serviceType: 'Super Wax Detail', vehicleCategory: 'CrossOver', price: 298.99 },
  { serviceType: 'Super Wax Detail', vehicleCategory: 'SUV', price: 318.99 },
  { serviceType: 'Super Wax Detail', vehicleCategory: 'Truck', price: 328.99 },
  { serviceType: 'Super Wax Detail', vehicleCategory: 'RV/Boat/Semi', price: 658.99 },
];

const ADDONS_DATA = [
  { id: 'pethair', name: 'Pet Hair / Sand Removal', price: 49.99 },
  { id: 'premiumwax', name: 'Premium Ceramic Wax', price: 69.99 },
  { id: 'bioclean', name: 'Bio-Clean Sanitization', price: 89.99 },
  { id: 'claybar', name: '2-Step Claybar Treatment', price: 79.99 },
  { id: 'babyseat', name: 'Baby Car Seat Detail', price: 39.99 },
  { id: 'engine', name: 'Engine Bay Detail', price: 59.99 },
  { id: 'headlight', name: 'Headlight Restoration', price: 64.99 },
  { id: 'leather', name: 'Leather Conditioning', price: 54.99 },
];

// Mock DB connection
vi.mock('../config/database', () => ({
  connectDB: vi.fn().mockResolvedValue(true),
}));

function mockChainableQuery(data: any = []) {
  const query: any = {
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    populate: vi.fn().mockReturnThis(),
    lean: vi.fn().mockImplementation(() => Promise.resolve(data)),
    limit: vi.fn().mockImplementation(() => Promise.resolve(data)),
    then(onFulfilled: any, onRejected?: any) {
      return Promise.resolve(data).then(onFulfilled, onRejected);
    },
  };
  return query;
}

describe('Catalog & Pricing Feature Modules (v1)', () => {
  const adminToken = generateAccessToken({
    userId: '507f1f77bcf86cd799439006',
    email: 'admin@test.com',
    role: 'admin',
    status: 'active',
    emailVerified: true,
  });

  const customerToken = generateAccessToken({
    userId: '507f1f77bcf86cd799439001',
    email: 'customer@test.com',
    role: 'customer',
    status: 'active',
    emailVerified: true,
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 1. Pricing Parity Verification Test (Item 1)
  // ---------------------------------------------------------------------------
  describe('Pricing Parity with src/data/pricing.ts', () => {
    it('seed produces exactly the same 20 vehicle prices and 8 add-on prices in cents', () => {
      const mismatches: string[] = [];

      // Map service name from pricing.ts to slug
      const serviceNameToSlug: Record<string, string> = {
        'Interior Only': 'interior-only',
        'Exterior Only': 'exterior-only',
        'Interior and Exterior Both': 'interior-and-exterior-both',
        'Super Wax Detail': 'super-wax-detail',
      };

      // Map vehicle category to lowercase slug
      const vehicleCategoryMap: Record<string, string> = {
        'Sedan': 'sedan',
        'CrossOver': 'crossover',
        'SUV': 'suv',
        'Truck': 'truck',
        'RV/Boat/Semi': 'rv-boat-semi',
      };

      // 1. Assert exactly 20 vehicle prices in seed
      expect(SEED_DATA.prices).toHaveLength(20);
      expect(PRICING_DATA).toHaveLength(20);

      for (const item of PRICING_DATA) {
        const expectedSlug = serviceNameToSlug[item.serviceType];
        const expectedCategory = vehicleCategoryMap[item.vehicleCategory];
        const expectedPriceCents = Math.round(item.price * 100);

        const seedPrice = SEED_DATA.prices.find(
          (p) => p.serviceSlug === expectedSlug && p.vehicleCategory === expectedCategory
        );

        if (!seedPrice) {
          mismatches.push(`Missing seed price for ${item.serviceType} / ${item.vehicleCategory}`);
        } else if (seedPrice.priceCents !== expectedPriceCents) {
          mismatches.push(
            `Mismatch for ${item.serviceType} / ${item.vehicleCategory}: expected ${expectedPriceCents}¢, found ${seedPrice.priceCents}¢`
          );
        }
      }

      // 2. Assert exactly 8 add-ons in seed
      expect(SEED_DATA.addons).toHaveLength(8);
      expect(ADDONS_DATA).toHaveLength(8);

      for (const addon of ADDONS_DATA) {
        const expectedPriceCents = Math.round(addon.price * 100);
        const seedAddon = SEED_DATA.addons.find((a) => a.name === addon.name);

        if (!seedAddon) {
          mismatches.push(`Missing seed addon for ${addon.name}`);
        } else if (seedAddon.priceCents !== expectedPriceCents) {
          mismatches.push(
            `Mismatch for addon ${addon.name}: expected ${expectedPriceCents}¢, found ${seedAddon.priceCents}¢`
          );
        }
      }

      if (mismatches.length > 0) {
        console.error('Pricing mismatches detected:', mismatches);
      }
      expect(mismatches).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Seed Script: Insert-only, --force, --dry-run (Item 2)
  // ---------------------------------------------------------------------------
  describe('Seed Catalog Script Flags & Idempotency', () => {
    const validCatId = new mongoose.Types.ObjectId();
    const validSrvId = new mongoose.Types.ObjectId();

    it('--dry-run prints what would change and performs 0 database writes', async () => {
      // Mock existing categories and services
      vi.spyOn(ServiceCategory, 'findOne').mockResolvedValue({ _id: validCatId, slug: 'mobile-detailing' } as any);
      vi.spyOn(Service, 'findOne').mockResolvedValue({ _id: validSrvId, slug: 'interior-only' } as any);
      vi.spyOn(ServicePrice, 'findOne').mockResolvedValue({ _id: new mongoose.Types.ObjectId() } as any);
      vi.spyOn(Addon, 'findOne').mockResolvedValue({ _id: new mongoose.Types.ObjectId() } as any);
      vi.spyOn(CommissionRule, 'findOne').mockResolvedValue({ _id: new mongoose.Types.ObjectId() } as any);
      vi.spyOn(BookingSettings, 'findOne').mockResolvedValue({ _id: new mongoose.Types.ObjectId() } as any);
      vi.spyOn(BookingSettings, 'create').mockResolvedValue({} as any);
      vi.spyOn(BookingSettings, 'updateOne').mockResolvedValue({} as any);

      const createCategorySpy = vi.spyOn(ServiceCategory, 'create');
      const updateCategorySpy = vi.spyOn(ServiceCategory, 'updateOne');
      const upsertCategorySpy = vi.spyOn(ServiceCategory, 'findOneAndUpdate');

      const report = await seedCatalog({ dryRun: true });

      expect(report.dryRun).toBe(true);
      expect(report.force).toBe(false);
      expect(report.inserted).toBe(0);
      expect(report.updated).toBe(0);
      expect(report.skipped).toBeGreaterThan(0);

      // Verify no DB mutations occurred
      expect(createCategorySpy).not.toHaveBeenCalled();
      expect(updateCategorySpy).not.toHaveBeenCalled();
      expect(upsertCategorySpy).not.toHaveBeenCalled();
    });

    it('default run is insert-only (uses $setOnInsert) and never overwrites existing records', async () => {
      vi.spyOn(ServiceCategory, 'findOne').mockResolvedValue({ _id: validCatId, slug: 'mobile-detailing' } as any);
      vi.spyOn(Service, 'findOne').mockResolvedValue({ _id: validSrvId, slug: 'interior-only' } as any);
      vi.spyOn(ServicePrice, 'findOne').mockResolvedValue({ _id: new mongoose.Types.ObjectId() } as any);
      vi.spyOn(Addon, 'findOne').mockResolvedValue({ _id: new mongoose.Types.ObjectId() } as any);
      vi.spyOn(CommissionRule, 'findOne').mockResolvedValue({ _id: new mongoose.Types.ObjectId() } as any);
      vi.spyOn(BookingSettings, 'findOne').mockResolvedValue({ _id: new mongoose.Types.ObjectId() } as any);
      vi.spyOn(BookingSettings, 'create').mockResolvedValue({} as any);
      vi.spyOn(BookingSettings, 'updateOne').mockResolvedValue({} as any);

      const updateCategorySpy = vi.spyOn(ServiceCategory, 'updateOne').mockResolvedValue({} as any);
      const upsertCategorySpy = vi.spyOn(ServiceCategory, 'findOneAndUpdate').mockResolvedValue({} as any);
      const upsertServiceSpy = vi.spyOn(Service, 'findOneAndUpdate').mockResolvedValue({} as any);
      const upsertPriceSpy = vi.spyOn(ServicePrice, 'findOneAndUpdate').mockResolvedValue({} as any);
      const upsertAddonSpy = vi.spyOn(Addon, 'findOneAndUpdate').mockResolvedValue({} as any);
      const upsertRuleSpy = vi.spyOn(CommissionRule, 'findOneAndUpdate').mockResolvedValue({} as any);

      const report = await seedCatalog();

      expect(report.dryRun).toBe(false);
      expect(report.force).toBe(false);
      expect(report.updated).toBe(0);
      expect(report.skipped).toBeGreaterThan(0);

      // Never called updateOne in default insert-only mode
      expect(updateCategorySpy).not.toHaveBeenCalled();

      // Called findOneAndUpdate with $setOnInsert
      expect(upsertCategorySpy).toHaveBeenCalledWith(
        { slug: 'mobile-detailing' },
        expect.objectContaining({ $setOnInsert: expect.any(Object) }),
        { upsert: true }
      );
      expect(upsertServiceSpy).toHaveBeenCalled();
      expect(upsertPriceSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ $setOnInsert: expect.any(Object) }),
        { upsert: true }
      );
      expect(upsertAddonSpy).toHaveBeenCalled();
      expect(upsertRuleSpy).toHaveBeenCalled();
    });

    it('--force updates existing records deliberately with updateOne', async () => {
      vi.spyOn(ServiceCategory, 'findOne').mockResolvedValue({ _id: validCatId, slug: 'mobile-detailing' } as any);
      vi.spyOn(Service, 'findOne').mockResolvedValue({ _id: validSrvId, slug: 'interior-only' } as any);
      vi.spyOn(ServicePrice, 'findOne').mockResolvedValue({ _id: new mongoose.Types.ObjectId() } as any);
      vi.spyOn(Addon, 'findOne').mockResolvedValue({ _id: new mongoose.Types.ObjectId() } as any);
      vi.spyOn(CommissionRule, 'findOne').mockResolvedValue({ _id: new mongoose.Types.ObjectId() } as any);
      vi.spyOn(BookingSettings, 'findOne').mockResolvedValue({ _id: new mongoose.Types.ObjectId() } as any);
      vi.spyOn(BookingSettings, 'create').mockResolvedValue({} as any);
      vi.spyOn(BookingSettings, 'updateOne').mockResolvedValue({} as any);

      const updateCategorySpy = vi.spyOn(ServiceCategory, 'updateOne').mockResolvedValue({} as any);
      const updateServiceSpy = vi.spyOn(Service, 'updateOne').mockResolvedValue({} as any);
      const updatePriceSpy = vi.spyOn(ServicePrice, 'updateOne').mockResolvedValue({} as any);
      const updateAddonSpy = vi.spyOn(Addon, 'updateOne').mockResolvedValue({} as any);
      const updateRuleSpy = vi.spyOn(CommissionRule, 'updateOne').mockResolvedValue({} as any);

      const report = await seedCatalog({ force: true });

      expect(report.force).toBe(true);
      expect(report.updated).toBeGreaterThan(0);
      expect(updateCategorySpy).toHaveBeenCalled();
      expect(updateServiceSpy).toHaveBeenCalled();
      expect(updatePriceSpy).toHaveBeenCalled();
      expect(updateAddonSpy).toHaveBeenCalled();
      expect(updateRuleSpy).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Public Read Endpoints: Active-only & Clean Projections (Item 3)
  // ---------------------------------------------------------------------------
  describe('Public Catalog Endpoints: Active-Only & No Internal Fields', () => {
    it('GET /api/v1/catalog/categories returns only active categories and excludes internal fields', async () => {
      const mockCategories = [
        { _id: 'cat1', slug: 'mobile-detailing', name: 'Mobile Detailing', isActive: true, sortOrder: 1 },
      ];

      const findSpy = vi.spyOn(ServiceCategory, 'find').mockReturnValue(mockChainableQuery(mockCategories) as any);

      const res = await request(app).get('/api/v1/catalog/categories');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].slug).toBe('mobile-detailing');
      // Assert find called with isActive: true
      expect(findSpy).toHaveBeenCalledWith({ isActive: true });
      // Assert no internal __v exposed
      expect(res.body.data[0].__v).toBeUndefined();
    });

    it('GET /api/v1/catalog/services returns only active services with active categories and excludes internal fields', async () => {
      const mockServices = [
        {
          _id: 'srv1',
          name: 'Interior Only',
          slug: 'interior-only',
          description: 'Vacuum and steam',
          durationMinutes: 90,
          images: [],
          pricingModel: 'by-vehicle-category',
          categoryId: { _id: 'cat1', name: 'Mobile Detailing', slug: 'mobile-detailing', icon: 'Sparkles' },
          __v: 0,
        },
        // Inactive category service (should be filtered out because categoryId is null when unpopulated)
        {
          _id: 'srv2',
          name: 'Brake Repair',
          slug: 'brake-repair',
          categoryId: null,
          __v: 0,
        },
      ];

      vi.spyOn(Service, 'find').mockReturnValue(mockChainableQuery(mockServices) as any);

      const res = await request(app).get('/api/v1/catalog/services');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].slug).toBe('interior-only');
      expect(res.body.data[0].category.slug).toBe('mobile-detailing');
      // Assert internal fields excluded
      expect(res.body.data[0].__v).toBeUndefined();
    });

    it('GET /api/v1/catalog/addons returns only active addons and excludes internal fields', async () => {
      const mockAddons = [
        {
          _id: 'add1',
          name: 'Pet Hair / Sand Removal',
          price: 4999,
          isActive: true,
          __v: 0,
        },
      ];

      const findSpy = vi.spyOn(Addon, 'find').mockReturnValue(mockChainableQuery(mockAddons) as any);

      const res = await request(app).get('/api/v1/catalog/addons');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data[0].price).toBe(4999);
      expect(res.body.data[0].priceUsd).toBe(49.99);
      expect(findSpy).toHaveBeenCalledWith(expect.objectContaining({ isActive: true }));
      expect(res.body.data[0].__v).toBeUndefined();
    });

    it('GET /api/v1/catalog/price-lookup returns price in cents and returns 404 for inactive service', async () => {
      // 1. Active service
      const mockActiveService = {
        _id: '507f1f77bcf86cd799439001',
        name: 'Super Wax Detail',
        slug: 'super-wax-detail',
        isActive: true,
        categoryId: '507f1f77bcf86cd799439002',
      };
      const mockActiveCat = {
        _id: '507f1f77bcf86cd799439002',
        isActive: true,
      };
      const mockPrice = {
        _id: 'price1',
        serviceId: '507f1f77bcf86cd799439001',
        vehicleCategory: 'sedan',
        price: 27899,
      };

      vi.spyOn(Service, 'findOne').mockResolvedValue(mockActiveService as any);
      vi.spyOn(ServiceCategory, 'findById').mockResolvedValue(mockActiveCat as any);
      vi.spyOn(ServicePrice, 'findOne').mockResolvedValue(mockPrice as any);

      const res = await request(app)
        .get('/api/v1/catalog/price-lookup')
        .query({ serviceSlug: 'super-wax-detail', vehicleCategory: 'sedan' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.price).toBe(27899);
      expect(res.body.data.priceUsd).toBe(278.99);

      // 2. Inactive service returns 404
      vi.spyOn(Service, 'findOne').mockResolvedValue({ ...mockActiveService, isActive: false } as any);

      const inactiveRes = await request(app)
        .get('/api/v1/catalog/price-lookup')
        .query({ serviceSlug: 'super-wax-detail', vehicleCategory: 'sedan' });

      expect(inactiveRes.status).toBe(404);
      expect(inactiveRes.body.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Coupon Validation & Legacy Support (Item 4)
  // ---------------------------------------------------------------------------
  describe('Coupon Validation & Legacy Endpoints', () => {
    it('POST /api/v1/catalog/coupons/validate returns { valid, discountPercent, discountCents } only', async () => {
      // Valid coupon
      const futureDate = new Date(Date.now() + 1000000);
      vi.spyOn(Coupon, 'findOne').mockResolvedValue({
        code: 'SUMMER20',
        discountPercentage: 20,
        isActive: true,
        expiryDate: futureDate,
      } as any);

      const res = await request(app)
        .post('/api/v1/catalog/coupons/validate')
        .send({ code: 'SUMMER20', subtotalCents: 25000 }); // $250.00

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({
        valid: true,
        discountPercent: 20,
        discountCents: 5000, // $50.00
      });
      // Ensure no internal fields like expiryDate or _id are leaked
      expect(res.body.data._id).toBeUndefined();
      expect(res.body.data.expiryDate).toBeUndefined();
    });

    it('POST /api/v1/catalog/coupons/validate handles invalid/expired code gracefully', async () => {
      vi.spyOn(Coupon, 'findOne').mockResolvedValue(null);

      const res = await request(app)
        .post('/api/v1/catalog/coupons/validate')
        .send({ code: 'INVALID_CODE', subtotalCents: 20000 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({
        valid: false,
        discountPercent: 0,
        discountCents: 0,
      });
    });

    it('legacy GET /api/coupons?active=true remains accessible without auth', async () => {
      const mockCoupons = [
        { code: 'FIRST10', discountPercentage: 10, isActive: true },
      ];
      vi.spyOn(Coupon, 'find').mockReturnValue(mockChainableQuery(mockCoupons) as any);

      const res = await request(app).get('/api/coupons?active=true');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Validation Rules & Deletion Protections (Item 5)
  // ---------------------------------------------------------------------------
  describe('Validation & Deletion Protections', () => {
    it('rejects commission rules where commissionPercent + processingPercent > 100 with 400', async () => {
      const res = await request(app)
        .post('/api/v1/pricing/admin/commission-rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          scope: 'global',
          commissionPercent: 95,
          processingPercent: 10, // 95 + 10 = 105 > 100
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects negative or zero prices with 400', async () => {
      const resZero = await request(app)
        .post('/api/v1/pricing/admin/prices')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          serviceId: '507f1f77bcf86cd799439001',
          vehicleCategory: 'truck',
          price: 0,
        });

      expect(resZero.status).toBe(400);

      const resNegative = await request(app)
        .post('/api/v1/pricing/admin/prices')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          serviceId: '507f1f77bcf86cd799439001',
          vehicleCategory: 'truck',
          price: -5000,
        });

      expect(resNegative.status).toBe(400);
    });

    it('blocks deleting a category that has services with 409 Conflict', async () => {
      vi.spyOn(Service, 'countDocuments').mockResolvedValue(3);

      const res = await request(app)
        .delete('/api/v1/catalog/admin/categories/507f1f77bcf86cd799439011')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('contains 3 existing service(s)');
    });

    it('blocks deleting a service that has associated prices with 409 Conflict', async () => {
      vi.spyOn(Service, 'findById').mockResolvedValue({ _id: 'srv1', name: 'Interior Only' } as any);
      vi.spyOn(ServicePrice, 'countDocuments').mockResolvedValue(5);

      const res = await request(app)
        .delete('/api/v1/catalog/admin/services/srv1')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('associated price record(s)');
    });

    it('blocks deleting a service that is referenced in existing appointments with 409 Conflict', async () => {
      vi.spyOn(Service, 'findById').mockResolvedValue({ _id: 'srv1', name: 'Interior Only' } as any);
      vi.spyOn(ServicePrice, 'countDocuments').mockResolvedValue(0);
      vi.spyOn(Appointment, 'countDocuments').mockResolvedValue(2);

      const res = await request(app)
        .delete('/api/v1/catalog/admin/services/srv1')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('appointment(s)');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Admin CRUD & Role Enforcement
  // ---------------------------------------------------------------------------
  describe('Admin CRUD & Role Enforcement', () => {
    it('rejects unauthenticated requests to admin endpoints with 401', async () => {
      const res = await request(app).get('/api/v1/catalog/admin/categories');
      expect(res.status).toBe(401);
    });

    it('rejects customer requests to admin endpoints with 403', async () => {
      const res = await request(app)
        .get('/api/v1/catalog/admin/categories')
        .set('Authorization', `Bearer ${customerToken}`);
      expect(res.status).toBe(403);
    });

    it('allows admin to create, update, and delete service categories when no services exist', async () => {
      // 1. Create
      const createdCat = {
        _id: '507f1f77bcf86cd799439011',
        slug: 'custom-cat',
        name: 'Custom Category',
        icon: 'Wrench',
        save: vi.fn().mockResolvedValue(true),
      };
      vi.spyOn(ServiceCategory, 'findOne').mockResolvedValue(null);
      vi.spyOn(ServiceCategory.prototype, 'save').mockResolvedValue(createdCat as any);

      const createRes = await request(app)
        .post('/api/v1/catalog/admin/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          slug: 'custom-cat',
          name: 'Custom Category',
          description: 'A test category',
        });

      expect(createRes.status).toBe(201);
      expect(createRes.body.success).toBe(true);

      // 2. Update
      vi.spyOn(ServiceCategory, 'findByIdAndUpdate').mockResolvedValue({
        _id: '507f1f77bcf86cd799439011',
        name: 'Updated Category Name',
      } as any);

      const updateRes = await request(app)
        .put('/api/v1/catalog/admin/categories/507f1f77bcf86cd799439011')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Updated Category Name' });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.name).toBe('Updated Category Name');

      // 3. Delete (with 0 services)
      vi.spyOn(Service, 'countDocuments').mockResolvedValue(0);
      vi.spyOn(ServiceCategory, 'findByIdAndDelete').mockResolvedValue({ _id: '507f1f77bcf86cd799439011' } as any);

      const deleteRes = await request(app)
        .delete('/api/v1/catalog/admin/categories/507f1f77bcf86cd799439011')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.success).toBe(true);
    });

    it('allows admin to manage service prices in integer cents', async () => {
      const upsertedPrice = {
        _id: '507f1f77bcf86cd799439022',
        serviceId: '507f1f77bcf86cd799439001',
        vehicleCategory: 'truck',
        price: 32899,
      };

      vi.spyOn(ServicePrice, 'findOneAndUpdate').mockResolvedValue(upsertedPrice as any);

      const res = await request(app)
        .post('/api/v1/pricing/admin/prices')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          serviceId: '507f1f77bcf86cd799439001',
          vehicleCategory: 'truck',
          price: 32899,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.price).toBe(32899);
    });

    it('allows admin to manage addons in integer cents', async () => {
      const createdAddon = {
        _id: '507f1f77bcf86cd799439033',
        name: 'Headlight Restoration',
        price: 6499,
        isActive: true,
        save: vi.fn().mockResolvedValue(true),
      };

      vi.spyOn(Addon.prototype, 'save').mockResolvedValue(createdAddon as any);

      const res = await request(app)
        .post('/api/v1/catalog/admin/addons')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Headlight Restoration',
          price: 6499,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it('allows admin to manage commission rules with default 15% and 3%', async () => {
      const createdRule = {
        _id: '507f1f77bcf86cd799439044',
        scope: 'global',
        commissionPercent: 15,
        processingPercent: 3,
        isActive: true,
        save: vi.fn().mockResolvedValue(true),
      };

      vi.spyOn(CommissionRule.prototype, 'save').mockResolvedValue(createdRule as any);

      const res = await request(app)
        .post('/api/v1/pricing/admin/commission-rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          scope: 'global',
          commissionPercent: 15,
          processingPercent: 3,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.commissionPercent).toBe(15);
      expect(res.body.data.processingPercent).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Commission Calculation Logic
  // ---------------------------------------------------------------------------
  describe('Commission Calculation', () => {
    it('accurately computes 15% commission, 3% processing, and net payout for $200 (20000 cents)', async () => {
      vi.spyOn(CommissionRule, 'findOne').mockResolvedValue({
        scope: 'global',
        commissionPercent: 15,
        processingPercent: 3,
        isActive: true,
      } as any);

      const result = await PricingService.calculateCommission({ amountCents: 20000 });

      expect(result.amountCents).toBe(20000);
      expect(result.amountUsd).toBe(200.0);
      expect(result.commissionPercent).toBe(15);
      expect(result.commissionAmountCents).toBe(3000); // $30.00
      expect(result.processingPercent).toBe(3);
      expect(result.processingAmountCents).toBe(600); // $6.00
      expect(result.payoutAmountCents).toBe(16400); // $164.00
    });
  });
});
