import dotenv from 'dotenv';
import path from 'path';
import mongoose from 'mongoose';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { connectDB } from '../config/database';
import logger from '../config/logger';
import { ServiceCategory } from '../models/ServiceCategory';
import { Service } from '../models/Service';
import { ServicePrice, VehicleCategory } from '../models/ServicePrice';
import { Addon } from '../models/Addon';
import { CommissionRule } from '../models/CommissionRule';
import { BookingSettings } from '../models/BookingSettings';

export interface SeedOptions {
  force?: boolean;
  dryRun?: boolean;
}

export interface SeedReport {
  dryRun: boolean;
  force: boolean;
  inserted: number;
  updated: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// Seed Data Definitions (Preserving exact prices from src/data/pricing.ts)
// ---------------------------------------------------------------------------
export const SEED_DATA = {
  categories: [
    {
      slug: 'mobile-detailing',
      name: 'Mobile Detailing',
      description: 'Professional mobile auto detailing at your door with premium equipment and chemicals.',
      icon: 'Sparkles',
      isActive: true,
      sortOrder: 1,
      requiresLocation: true,
      allowsScheduling: true,
    },
    {
      slug: 'mobile-mechanics',
      name: 'Mobile Mechanics',
      description: 'Certified mobile mechanics performing on-site repairs, brakes, batteries, and starters.',
      icon: 'Wrench',
      isActive: true,
      sortOrder: 2,
      requiresLocation: true,
      allowsScheduling: true,
    },
    {
      slug: 'diagnostics',
      name: 'Diagnostics',
      description: 'Advanced OBD-II computer diagnostics, engine light troubleshooting, and electrical tracing.',
      icon: 'Activity',
      isActive: true,
      sortOrder: 3,
      requiresLocation: true,
      allowsScheduling: true,
    },
    {
      slug: 'roadside-assistance',
      name: 'Roadside Assistance',
      description: '24/7 on-demand roadside assistance: jump starts, lockout assistance, flat tire changes, and fuel delivery.',
      icon: 'ShieldAlert',
      isActive: true,
      sortOrder: 4,
      requiresLocation: true,
      allowsScheduling: true,
    },
    {
      slug: 'towing',
      name: 'Towing',
      description: 'Reliable flatbed and wheel-lift towing for standard, luxury, and heavy-duty vehicles.',
      icon: 'Truck',
      isActive: true,
      sortOrder: 5,
      requiresLocation: true,
      allowsScheduling: true,
    },
    {
      slug: 'inspections',
      name: 'Inspections',
      description: 'Thorough multi-point pre-purchase and annual safety inspections by certified technicians.',
      icon: 'ClipboardCheck',
      isActive: true,
      sortOrder: 6,
      requiresLocation: true,
      allowsScheduling: true,
    },
    {
      slug: 'maintenance',
      name: 'Maintenance',
      description: 'Scheduled preventive maintenance, synthetic oil changes, brake pads, and fluid exchanges.',
      icon: 'Settings',
      isActive: true,
      sortOrder: 7,
      requiresLocation: true,
      allowsScheduling: true,
    },
  ],

  detailingServices: [
    {
      slug: 'interior-only',
      name: 'Interior Only',
      description: 'Full vacuum, steam clean, leather conditioning, dashboard & console detail, odor elimination, air vent cleaning.',
      durationMinutes: 90,
      images: ['/assets/detail-interior.jpg'],
      isActive: true,
      pricingModel: 'by-vehicle-category' as const,
    },
    {
      slug: 'exterior-only',
      name: 'Exterior Only',
      description: 'Hand wash & dry, clay bar treatment, machine polish, sealant application, tire & rim detail, trim restoration.',
      durationMinutes: 90,
      images: ['/assets/detail-exterior.jpg'],
      isActive: true,
      pricingModel: 'by-vehicle-category' as const,
    },
    {
      slug: 'interior-and-exterior-both',
      name: 'Interior and Exterior Both',
      description: 'Complete interior vacuum & shampoo, dashboard/console detail, hand wash & exterior decontamination, wheel cleaning, streak-free windows.',
      durationMinutes: 150,
      images: ['/assets/intandext.png'],
      isActive: true,
      pricingModel: 'by-vehicle-category' as const,
    },
    {
      slug: 'super-wax-detail',
      name: 'Super Wax Detail',
      description: 'Complete interior detail, full exterior detail, premium ceramic wax protection, single-stage paint correction, engine bay deep cleaning, headlight restoration.',
      durationMinutes: 210,
      images: ['/assets/detail-wax.jpg'],
      isActive: true,
      pricingModel: 'by-vehicle-category' as const,
    },
  ],

  // 20 vehicle prices in integer cents matching Core Detailing Packages table
  prices: [
    // Interior Only ($198.99, $208.99, $218.99, $238.99, $438.99)
    { serviceSlug: 'interior-only', vehicleCategory: 'sedan' as VehicleCategory, priceCents: 19899 },
    { serviceSlug: 'interior-only', vehicleCategory: 'crossover' as VehicleCategory, priceCents: 20899 },
    { serviceSlug: 'interior-only', vehicleCategory: 'suv' as VehicleCategory, priceCents: 21899 },
    { serviceSlug: 'interior-only', vehicleCategory: 'truck' as VehicleCategory, priceCents: 23899 },
    { serviceSlug: 'interior-only', vehicleCategory: 'rv-boat-semi' as VehicleCategory, priceCents: 43899 },

    // Exterior Only ($198.99, $208.99, $218.99, $238.99, $438.99)
    { serviceSlug: 'exterior-only', vehicleCategory: 'sedan' as VehicleCategory, priceCents: 19899 },
    { serviceSlug: 'exterior-only', vehicleCategory: 'crossover' as VehicleCategory, priceCents: 20899 },
    { serviceSlug: 'exterior-only', vehicleCategory: 'suv' as VehicleCategory, priceCents: 21899 },
    { serviceSlug: 'exterior-only', vehicleCategory: 'truck' as VehicleCategory, priceCents: 23899 },
    { serviceSlug: 'exterior-only', vehicleCategory: 'rv-boat-semi' as VehicleCategory, priceCents: 43899 },

    // Interior and Exterior Both ($218.99, $238.99, $258.99, $268.99, $598.99)
    { serviceSlug: 'interior-and-exterior-both', vehicleCategory: 'sedan' as VehicleCategory, priceCents: 21899 },
    { serviceSlug: 'interior-and-exterior-both', vehicleCategory: 'crossover' as VehicleCategory, priceCents: 23899 },
    { serviceSlug: 'interior-and-exterior-both', vehicleCategory: 'suv' as VehicleCategory, priceCents: 25899 },
    { serviceSlug: 'interior-and-exterior-both', vehicleCategory: 'truck' as VehicleCategory, priceCents: 26899 },
    { serviceSlug: 'interior-and-exterior-both', vehicleCategory: 'rv-boat-semi' as VehicleCategory, priceCents: 59899 },

    // Super Wax Detail ($248.99, $268.99, $288.99, $298.99, $628.99)
    { serviceSlug: 'super-wax-detail', vehicleCategory: 'sedan' as VehicleCategory, priceCents: 24899 },
    { serviceSlug: 'super-wax-detail', vehicleCategory: 'crossover' as VehicleCategory, priceCents: 26899 },
    { serviceSlug: 'super-wax-detail', vehicleCategory: 'suv' as VehicleCategory, priceCents: 28899 },
    { serviceSlug: 'super-wax-detail', vehicleCategory: 'truck' as VehicleCategory, priceCents: 29899 },
    { serviceSlug: 'super-wax-detail', vehicleCategory: 'rv-boat-semi' as VehicleCategory, priceCents: 62899 },
  ],

  // 8 add-on prices in integer cents matching Add-On Services table
  addons: [
    { name: 'Baby Car Seat Detail', priceCents: 2499, isActive: true },
    { name: 'Pet Hair / Sand Removal', priceCents: 3499, isActive: true },
    { name: 'Leather Conditioning', priceCents: 3999, isActive: true },
    { name: 'Engine Bay Detail', priceCents: 4499, isActive: true },
    { name: 'Headlight Restoration', priceCents: 4999, isActive: true },
    { name: 'Premium Ceramic Wax', priceCents: 5499, isActive: true },
    { name: '2-Step Claybar Treatment', priceCents: 6499, isActive: true },
    { name: 'Bio-Clean Sanitization', priceCents: 7499, isActive: true },
  ],

  // Inactive placeholder services for the other 6 categories
  placeholderServices: [
    // mobile-mechanics
    {
      categorySlug: 'mobile-mechanics',
      slug: 'brake-pad-rotor-replacement',
      name: 'Brake Pad & Rotor Replacement',
      description: 'Complete brake service including premium ceramic pads, rotor resurfacing/replacement, and brake fluid inspection.',
      durationMinutes: 120,
      isActive: false,
      pricingModel: 'quote' as const,
    },
    {
      categorySlug: 'mobile-mechanics',
      slug: 'starter-alternator-repair',
      name: 'Starter & Alternator Repair',
      description: 'On-site diagnosis and replacement of faulty starters, alternators, and charging systems.',
      durationMinutes: 120,
      isActive: false,
      pricingModel: 'quote' as const,
    },

    // diagnostics
    {
      categorySlug: 'diagnostics',
      slug: 'obd-ii-diagnostic',
      name: 'OBD-II Computer Diagnostic',
      description: 'Full-system computer scan to read and analyze engine, transmission, ABS, and airbag trouble codes.',
      durationMinutes: 45,
      isActive: false,
      pricingModel: 'fixed' as const,
    },
    {
      categorySlug: 'diagnostics',
      slug: 'electrical-system-scan',
      name: 'Electrical Circuit & Battery Scan',
      description: 'Comprehensive electrical testing including parasitic battery drain, alternator output, and wire continuity.',
      durationMinutes: 60,
      isActive: false,
      pricingModel: 'fixed' as const,
    },

    // roadside-assistance
    {
      categorySlug: 'roadside-assistance',
      slug: 'emergency-battery-jump-start',
      name: 'Emergency Battery Jump-Start',
      description: 'Rapid on-demand jump-start service using heavy-duty industrial boosters.',
      durationMinutes: 30,
      isActive: false,
      pricingModel: 'fixed' as const,
    },
    {
      categorySlug: 'roadside-assistance',
      slug: 'emergency-fuel-delivery',
      name: 'Emergency Fuel Delivery',
      description: 'Delivery of 2-3 gallons of regular or premium gasoline to get you safely to the nearest filling station.',
      durationMinutes: 30,
      isActive: false,
      pricingModel: 'distance' as const,
    },

    // towing
    {
      categorySlug: 'towing',
      slug: 'flatbed-towing',
      name: 'Standard Flatbed Towing',
      description: 'Safe damage-free flatbed towing for passenger cars, AWD crossovers, and light trucks.',
      durationMinutes: 60,
      isActive: false,
      pricingModel: 'distance' as const,
    },
    {
      categorySlug: 'towing',
      slug: 'heavy-duty-towing',
      name: 'Heavy Duty Towing',
      description: 'Specialized towing solutions for commercial vans, RVs, and heavy-duty utility vehicles.',
      durationMinutes: 90,
      isActive: false,
      pricingModel: 'distance' as const,
    },

    // inspections
    {
      categorySlug: 'inspections',
      slug: 'pre-purchase-inspection',
      name: '150-Point Pre-Purchase Inspection',
      description: 'Detailed inspection of mechanical condition, frame integrity, electronics, fluid condition, and road test before you buy.',
      durationMinutes: 90,
      isActive: false,
      pricingModel: 'fixed' as const,
    },
    {
      categorySlug: 'inspections',
      slug: 'annual-safety-inspection',
      name: 'Annual Safety Inspection',
      description: 'Thorough assessment of brakes, tires, suspension, steering, lighting, and safety equipment.',
      durationMinutes: 60,
      isActive: false,
      pricingModel: 'fixed' as const,
    },

    // maintenance
    {
      categorySlug: 'maintenance',
      slug: 'synthetic-oil-change',
      name: 'Full Synthetic Oil & Filter Service',
      description: 'Premium synthetic motor oil change with OEM filter replacement and 10-point fluid check.',
      durationMinutes: 45,
      isActive: false,
      pricingModel: 'by-vehicle-category' as const,
    },
    {
      categorySlug: 'maintenance',
      slug: 'coolant-system-flush',
      name: 'Coolant & Radiator Flush',
      description: 'Complete cooling system drain, chemical flush, and refill with high-grade anti-freeze.',
      durationMinutes: 60,
      isActive: false,
      pricingModel: 'fixed' as const,
    },
  ],
};

export async function seedCatalog(options: SeedOptions = {}): Promise<SeedReport> {
  await connectDB();

  const force = options.force ?? process.argv.includes('--force');
  const dryRun = options.dryRun ?? process.argv.includes('--dry-run');

  logger.info({ force, dryRun }, 'Starting catalog seed...');

  const report: SeedReport = {
    dryRun,
    force,
    inserted: 0,
    updated: 0,
    skipped: 0,
  };

  const categoryMap = new Map<string, mongoose.Types.ObjectId>();
  const serviceMap = new Map<string, mongoose.Types.ObjectId>();

  // 1. Categories
  for (const cat of SEED_DATA.categories) {
    const existing = await ServiceCategory.findOne({ slug: cat.slug });
    if (existing) {
      categoryMap.set(cat.slug, existing._id);
      if (dryRun) {
        if (force) {
          report.updated++;
          logger.info(`[DRY-RUN] Would update category: ${cat.slug}`);
        } else {
          report.skipped++;
          logger.info(`[DRY-RUN] Existing category skipped (no change): ${cat.slug}`);
        }
      } else {
        if (force) {
          await ServiceCategory.updateOne({ slug: cat.slug }, { $set: cat });
          report.updated++;
        } else {
          // Insert-only: $setOnInsert leaves existing document untouched
          await ServiceCategory.findOneAndUpdate(
            { slug: cat.slug },
            { $setOnInsert: cat },
            { upsert: true }
          );
          report.skipped++;
        }
      }
    } else {
      if (dryRun) {
        report.inserted++;
        logger.info(`[DRY-RUN] Would insert category: ${cat.slug}`);
        categoryMap.set(cat.slug, new mongoose.Types.ObjectId());
      } else {
        const created = await ServiceCategory.create(cat);
        categoryMap.set(cat.slug, created._id);
        report.inserted++;
      }
    }
  }

  const detailingCatId = categoryMap.get('mobile-detailing')!;

  // 2. Detailing Services
  for (const serv of SEED_DATA.detailingServices) {
    const existing = await Service.findOne({ slug: serv.slug });
    const fullServiceDoc = { ...serv, categoryId: detailingCatId };

    if (existing) {
      serviceMap.set(serv.slug, existing._id);
      if (dryRun) {
        if (force) {
          report.updated++;
          logger.info(`[DRY-RUN] Would update detailing service: ${serv.slug}`);
        } else {
          report.skipped++;
          logger.info(`[DRY-RUN] Existing detailing service skipped (no change): ${serv.slug}`);
        }
      } else {
        if (force) {
          await Service.updateOne({ slug: serv.slug }, { $set: fullServiceDoc });
          report.updated++;
        } else {
          await Service.findOneAndUpdate(
            { slug: serv.slug },
            { $setOnInsert: fullServiceDoc },
            { upsert: true }
          );
          report.skipped++;
        }
      }
    } else {
      if (dryRun) {
        report.inserted++;
        logger.info(`[DRY-RUN] Would insert detailing service: ${serv.slug}`);
        serviceMap.set(serv.slug, new mongoose.Types.ObjectId());
      } else {
        const created = await Service.create(fullServiceDoc);
        serviceMap.set(serv.slug, created._id);
        report.inserted++;
      }
    }
  }

  // 3. Service Prices
  for (const p of SEED_DATA.prices) {
    const serviceId = serviceMap.get(p.serviceSlug);
    if (!serviceId) continue;

    const existing = await ServicePrice.findOne({ serviceId, vehicleCategory: p.vehicleCategory });
    const priceDoc = { serviceId, vehicleCategory: p.vehicleCategory, price: p.priceCents };

    if (existing) {
      if (dryRun) {
        if (force) {
          report.updated++;
          logger.info(`[DRY-RUN] Would update price: ${p.serviceSlug} + ${p.vehicleCategory} -> ${p.priceCents}¢`);
        } else {
          report.skipped++;
          logger.info(`[DRY-RUN] Existing price skipped (no change): ${p.serviceSlug} + ${p.vehicleCategory}`);
        }
      } else {
        if (force) {
          await ServicePrice.updateOne({ serviceId, vehicleCategory: p.vehicleCategory }, { $set: priceDoc });
          report.updated++;
        } else {
          await ServicePrice.findOneAndUpdate(
            { serviceId, vehicleCategory: p.vehicleCategory },
            { $setOnInsert: priceDoc },
            { upsert: true }
          );
          report.skipped++;
        }
      }
    } else {
      if (dryRun) {
        report.inserted++;
        logger.info(`[DRY-RUN] Would insert price: ${p.serviceSlug} + ${p.vehicleCategory} -> ${p.priceCents}¢`);
      } else {
        await ServicePrice.create(priceDoc);
        report.inserted++;
      }
    }
  }

  // 4. Addons
  const detailingServiceIds = Array.from(serviceMap.values());
  for (const a of SEED_DATA.addons) {
    const existing = await Addon.findOne({ name: a.name });
    const addonDoc = {
      name: a.name,
      price: a.priceCents,
      categoryId: detailingCatId,
      serviceIds: detailingServiceIds,
      isActive: a.isActive,
    };

    if (existing) {
      if (dryRun) {
        if (force) {
          report.updated++;
          logger.info(`[DRY-RUN] Would update addon: ${a.name}`);
        } else {
          report.skipped++;
          logger.info(`[DRY-RUN] Existing addon skipped (no change): ${a.name}`);
        }
      } else {
        if (force) {
          await Addon.updateOne({ name: a.name }, { $set: addonDoc });
          report.updated++;
        } else {
          await Addon.findOneAndUpdate(
            { name: a.name },
            { $setOnInsert: addonDoc },
            { upsert: true }
          );
          report.skipped++;
        }
      }
    } else {
      if (dryRun) {
        report.inserted++;
        logger.info(`[DRY-RUN] Would insert addon: ${a.name}`);
      } else {
        await Addon.create(addonDoc);
        report.inserted++;
      }
    }
  }

  // 5. Placeholder Services
  for (const s of SEED_DATA.placeholderServices) {
    const catId = categoryMap.get(s.categorySlug);
    if (!catId) continue;

    const existing = await Service.findOne({ slug: s.slug });
    const placeholderDoc = {
      categoryId: catId,
      slug: s.slug,
      name: s.name,
      description: s.description,
      durationMinutes: s.durationMinutes,
      isActive: s.isActive,
      pricingModel: s.pricingModel,
    };

    if (existing) {
      if (dryRun) {
        if (force) {
          report.updated++;
          logger.info(`[DRY-RUN] Would update placeholder service: ${s.slug}`);
        } else {
          report.skipped++;
          logger.info(`[DRY-RUN] Existing placeholder service skipped (no change): ${s.slug}`);
        }
      } else {
        if (force) {
          await Service.updateOne({ slug: s.slug }, { $set: placeholderDoc });
          report.updated++;
        } else {
          await Service.findOneAndUpdate(
            { slug: s.slug },
            { $setOnInsert: placeholderDoc },
            { upsert: true }
          );
          report.skipped++;
        }
      }
    } else {
      if (dryRun) {
        report.inserted++;
        logger.info(`[DRY-RUN] Would insert placeholder service: ${s.slug}`);
      } else {
        await Service.create(placeholderDoc);
        report.inserted++;
      }
    }
  }

  // 6. Default Global Commission Rule (15% commission, 3% processing)
  const ruleDoc = {
    scope: 'global' as const,
    scopeId: null,
    commissionPercent: 15,
    processingPercent: 3,
    isActive: true,
  };

  const existingRule = await CommissionRule.findOne({ scope: 'global' });
  if (existingRule) {
    if (dryRun) {
      if (force) {
        report.updated++;
        logger.info('[DRY-RUN] Would update global commission rule');
      } else {
        report.skipped++;
        logger.info('[DRY-RUN] Existing global commission rule skipped (no change)');
      }
    } else {
      if (force) {
        await CommissionRule.updateOne({ scope: 'global' }, { $set: ruleDoc });
        report.updated++;
      } else {
        await CommissionRule.findOneAndUpdate(
          { scope: 'global' },
          { $setOnInsert: ruleDoc },
          { upsert: true }
        );
        report.skipped++;
      }
    }
  } else {
    if (dryRun) {
      report.inserted++;
      logger.info('[DRY-RUN] Would insert global commission rule');
    } else {
      await CommissionRule.create(ruleDoc);
      report.inserted++;
    }
  }

  // 7. Booking Settings (insert-only)
  const defaultSettingsDoc = {
    businessTimezone: process.env.BUSINESS_TIMEZONE || 'America/New_York',
    slots: [
      '08:00',
      '09:00',
      '10:00',
      '11:00',
      '12:00',
      '13:00',
      '14:00',
      '15:00',
      '16:00',
      '17:00',
    ],
    slotCapacity: 2,
    minLeadHours: 2,
    maxAdvanceDays: 60,
    cancellation: { freeCancelHours: 24, lateFeePercent: 20 },
    closedDates: [],
  };

  const existingSettings = await BookingSettings.findOne();
  if (existingSettings) {
    if (dryRun) {
      if (force) {
        report.updated++;
        logger.info('[DRY-RUN] Would update booking settings');
      } else {
        report.skipped++;
        logger.info('[DRY-RUN] Existing booking settings skipped (no change)');
      }
    } else {
      if (force) {
        await BookingSettings.updateOne({}, { $set: defaultSettingsDoc });
        report.updated++;
      } else {
        report.skipped++;
      }
    }
  } else {
    if (dryRun) {
      report.inserted++;
      logger.info('[DRY-RUN] Would insert booking settings');
    } else {
      await BookingSettings.create(defaultSettingsDoc);
      report.inserted++;
    }
  }

  logger.info({ report }, 'Catalog and pricing seed finished');
  return report;
}

// If executed directly from CLI
if (require.main === module) {
  seedCatalog()
    .then((report) => {
      console.log('Seed summary:', report);
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, 'Error during catalog seed');
      process.exit(1);
    });
}
