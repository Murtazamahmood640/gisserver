import mongoose from 'mongoose';
import { Service } from '../../models/Service';
import { ServiceCategory } from '../../models/ServiceCategory';
import { ServicePrice, VehicleCategory } from '../../models/ServicePrice';
import { Addon } from '../../models/Addon';
import { CommissionRule } from '../../models/CommissionRule';
import { CatalogService } from '../catalog/service';
import { IPricingSnapshot, IServiceSnapshot, IAddonSnapshot } from '../../models/Booking';
import { VehicleCategorySlug } from '../../models/Vehicle';

export interface CalculatePricingInput {
  serviceId: string | mongoose.Types.ObjectId;
  vehicleCategory: string;
  addonIds?: (string | mongoose.Types.ObjectId)[];
  couponCode?: string | null;
}

export interface CalculatePricingResult {
  pricing: IPricingSnapshot;
  service: IServiceSnapshot & {
    _id: mongoose.Types.ObjectId;
    categoryId: mongoose.Types.ObjectId;
    durationMinutes?: number;
  };
  category: { _id: mongoose.Types.ObjectId; name: string; slug: string };
  vehicleCategory: VehicleCategorySlug;
  addons: IAddonSnapshot[];
}

/**
 * Normalizes input vehicle category string to supported slug enum.
 */
export function normalizeVehicleCategory(category: string): VehicleCategorySlug {
  const clean = category.toLowerCase().trim();
  if (clean === 'sedan' || clean === 'car') return 'sedan';
  if (clean === 'crossover') return 'crossover';
  if (clean === 'suv') return 'suv';
  if (clean === 'truck') return 'truck';
  if (
    clean === 'rv-boat-semi' ||
    clean === 'rv/boat/semi' ||
    clean.includes('boat') ||
    clean.includes('semi') ||
    clean.includes('rv')
  ) {
    return 'rv-boat-semi';
  }
  return clean as VehicleCategorySlug;
}

/**
 * Calculates complete booking pricing snapshot server-side in integer cents.
 *
 * ROUNDING RULE:
 * - All monetary values are maintained strictly in integer cents (USD).
 * - Per-line calculations (discounts, commissions, processing fees) use standard
 *   half-up integer rounding: Math.round((base * percentage) / 100).
 * - Client-submitted prices are NEVER trusted.
 * - Inactive services, categories, or add-ons are strictly rejected with 400.
 *
 * COMMISSION RULES PRECEDENCE:
 * 1. Service-specific: scope = 'service', scopeId = serviceId
 * 2. Category-specific: scope = 'category', scopeId = categoryId
 * 3. Global default: scope = 'global'
 * 4. Fallback defaults: 15% commission, 3% processing
 */
export async function calculateBookingPricing(
  input: CalculatePricingInput
): Promise<CalculatePricingResult> {
  const { serviceId, vehicleCategory: rawVehicleCat, addonIds = [], couponCode } = input;

  // 1. Resolve and validate service
  let service = null;
  if (mongoose.isValidObjectId(serviceId)) {
    service = await Service.findById(serviceId);
  }
  if (!service && typeof serviceId === 'string') {
    service = await Service.findOne({ slug: serviceId.toLowerCase().trim() });
  }

  if (!service || !service.isActive) {
    const err = new Error(
      `Service '${serviceId}' is unavailable or inactive and cannot be booked`
    ) as any;
    err.statusCode = 400;
    err.code = 'SERVICE_UNAVAILABLE';
    throw err;
  }

  // 2. Resolve and validate parent category
  const category = await ServiceCategory.findById(service.categoryId);
  if (!category || !category.isActive) {
    const err = new Error(
      `Category '${category?.name || service.categoryId}' is unavailable or inactive`
    ) as any;
    err.statusCode = 400;
    err.code = 'CATEGORY_UNAVAILABLE';
    throw err;
  }

  // 3. Resolve vehicle category and base price
  const vehicleCategory = normalizeVehicleCategory(rawVehicleCat);
  const priceRecord = await ServicePrice.findOne({
    serviceId: service._id,
    vehicleCategory,
  });

  if (!priceRecord) {
    const err = new Error(
      `Pricing for service '${service.name}' and vehicle category '${vehicleCategory}' not found`
    ) as any;
    err.statusCode = 400;
    err.code = 'PRICE_NOT_FOUND';
    throw err;
  }

  const baseCents = priceRecord.price;

  // 4. Resolve and validate add-ons
  const addonSnapshots: IAddonSnapshot[] = [];
  let addonsCents = 0;

  if (addonIds && addonIds.length > 0) {
    for (const addonIdentifier of addonIds) {
      let addonDoc = null;
      if (mongoose.isValidObjectId(addonIdentifier)) {
        addonDoc = await Addon.findById(addonIdentifier);
      }
      if (!addonDoc && typeof addonIdentifier === 'string') {
        addonDoc = await Addon.findOne({ name: addonIdentifier });
      }

      if (!addonDoc || !addonDoc.isActive) {
        const err = new Error(
          `Addon '${addonIdentifier}' is inactive or invalid`
        ) as any;
        err.statusCode = 400;
        err.code = 'ADDON_UNAVAILABLE';
        throw err;
      }

      addonSnapshots.push({
        addonId: addonDoc._id,
        name: addonDoc.name,
        priceCents: addonDoc.price,
      });
      addonsCents += addonDoc.price;
    }
  }

  const subtotalCents = baseCents + addonsCents;

  // 5. Coupon validation
  let discountCents = 0;
  let couponPercent = 0;
  let validatedCode: string | null = null;

  if (couponCode && couponCode.trim()) {
    const couponResult = await CatalogService.validateCoupon(couponCode, subtotalCents);
    if (couponResult.valid) {
      discountCents = couponResult.discountCents;
      couponPercent = couponResult.discountPercent;
      validatedCode = couponCode.toUpperCase().trim();
    }
  }

  const totalCents = Math.max(0, subtotalCents - discountCents);
  const taxCents = 0; // Tax calculation placeholder

  // 6. Commission rule resolution (Precedence: service > category > global)
  let commissionRule = await CommissionRule.findOne({
    scope: 'service',
    scopeId: service._id,
    isActive: true,
  });

  if (!commissionRule) {
    commissionRule = await CommissionRule.findOne({
      scope: 'category',
      scopeId: category._id,
      isActive: true,
    });
  }

  if (!commissionRule) {
    commissionRule = await CommissionRule.findOne({
      scope: 'global',
      isActive: true,
    });
  }

  const commissionPercent = commissionRule ? commissionRule.commissionPercent : 15;
  const processingPercent = commissionRule ? commissionRule.processingPercent : 3;

  // Round half up per line in integer cents
  const commissionCents = Math.round((totalCents * commissionPercent) / 100);
  const processingCents = Math.round((totalCents * processingPercent) / 100);
  const providerPayoutCents = Math.max(0, totalCents - commissionCents - processingCents);

  const pricing: IPricingSnapshot = {
    baseCents,
    addonsCents,
    discountCents,
    couponCode: validatedCode,
    couponPercent,
    taxCents,
    totalCents,
    commissionPercent,
    processingPercent,
    commissionCents,
    processingCents,
    providerPayoutCents,
  };

  return {
    pricing,
    service: {
      _id: service._id,
      categoryId: category._id,
      name: service.name,
      slug: service.slug,
      durationMinutes: service.durationMinutes,
    },
    category: {
      _id: category._id,
      name: category.name,
      slug: category.slug,
    },
    vehicleCategory,
    addons: addonSnapshots,
  };
}
