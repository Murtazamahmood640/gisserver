import mongoose, { Document, Schema } from 'mongoose';

export interface IPartCategory extends Document {
  slug: string;
  name: string;
  description?: string;
  icon?: string;
  subcategories: string[];
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export const DEFAULT_PART_CATEGORIES = [
  {
    slug: 'brakes',
    name: 'Brakes',
    description: 'Brake pads, rotors, calipers, shoes, and brake fluid',
    icon: 'Disc',
    subcategories: ['Brake Pads', 'Rotors & Discs', 'Calipers', 'Brake Lines & Hoses', 'Brake Fluid'],
    sortOrder: 1,
  },
  {
    slug: 'engine-parts',
    name: 'Engine Parts',
    description: 'Pistons, camshafts, timing belts, gaskets, and spark plugs',
    icon: 'Cpu',
    subcategories: ['Timing Belts & Chains', 'Spark Plugs & Ignition', 'Gaskets & Seals', 'Pistons & Rings', 'Valves & Camshafts'],
    sortOrder: 2,
  },
  {
    slug: 'batteries',
    name: 'Batteries',
    description: 'Automotive starter batteries, AGM, and EV hybrid battery packs',
    icon: 'BatteryCharging',
    subcategories: ['Standard 12V', 'AGM Batteries', 'Deep Cycle', 'Hybrid / EV Batteries', 'Jump Starters & Cables'],
    sortOrder: 3,
  },
  {
    slug: 'tyres',
    name: 'Tyres',
    description: 'All-season, performance, winter, and off-road tyres and rims',
    icon: 'CircleDot',
    subcategories: ['All-Season', 'Summer Performance', 'Winter / Snow', 'All-Terrain / Off-Road', 'Wheels & Rims'],
    sortOrder: 4,
  },
  {
    slug: 'suspension',
    name: 'Suspension',
    description: 'Shock absorbers, struts, springs, and control arms',
    icon: 'Activity',
    subcategories: ['Shocks & Struts', 'Control Arms', 'Sway Bars & Bushings', 'Coil Springs', 'Tie Rods & Ball Joints'],
    sortOrder: 5,
  },
  {
    slug: 'electrical-parts',
    name: 'Electrical Parts',
    description: 'Alternators, starters, wiring harnesses, sensors, and fuses',
    icon: 'Zap',
    subcategories: ['Alternators', 'Starter Motors', 'Sensors (O2, MAF, ABS)', 'Wiring & Relays', 'Lighting & Bulbs'],
    sortOrder: 6,
  },
  {
    slug: 'filters',
    name: 'Filters',
    description: 'Oil, air, cabin, and fuel filters',
    icon: 'Filter',
    subcategories: ['Oil Filters', 'Air Filters', 'Cabin Air Filters', 'Fuel Filters', 'Transmission Filters'],
    sortOrder: 7,
  },
  {
    slug: 'cooling-systems',
    name: 'Cooling Systems',
    description: 'Radiators, water pumps, thermostats, and coolant hoses',
    icon: 'ThermometerSnowflake',
    subcategories: ['Radiators', 'Water Pumps', 'Thermostats', 'Coolant Hoses', 'Radiator Fans'],
    sortOrder: 8,
  },
  {
    slug: 'body-parts',
    name: 'Body Parts',
    description: 'Bumpers, fenders, mirrors, grilles, hoods, and door panels',
    icon: 'Shield',
    subcategories: ['Bumpers & Trim', 'Mirrors & Glass', 'Fenders & Quarter Panels', 'Grilles & Hoods', 'Door Handles & Latches'],
    sortOrder: 9,
  },
  {
    slug: 'other-parts',
    name: 'Other Parts',
    description: 'Exhaust, transmission, fluids, and accessories',
    icon: 'Package',
    subcategories: ['Exhaust Systems', 'Transmission Fluids', 'Accessories', 'Hardware & Fasteners'],
    sortOrder: 10,
  },
];

const PartCategorySchema = new Schema<IPartCategory>(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    icon: {
      type: String,
      default: 'Package',
      trim: true,
    },
    subcategories: {
      type: [String],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
      index: true,
    },
  },
  { timestamps: true }
);

export const PartCategory =
  mongoose.models.PartCategory ||
  mongoose.model<IPartCategory>('PartCategory', PartCategorySchema, 'partCategories');
