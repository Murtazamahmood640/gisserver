import dotenv from 'dotenv';
import path from 'path';
import mongoose from 'mongoose';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { connectDB } from '../config/database';
import { assertScriptSafety } from './_scriptGuard';
import { User } from '../models/User';
import { SupplierProfile } from '../models/SupplierProfile';
import { PartCategory, DEFAULT_PART_CATEGORIES } from '../models/PartCategory';
import { PartProduct } from '../models/PartProduct';

interface DemoProductDefinition {
  sku: string;
  name: string;
  brand: string;
  manufacturer?: string;
  description: string;
  category: string; // slug
  subcategory?: string;
  images: Array<{ url: string; alt?: string; isPrimary?: boolean }>;
  priceCents: number;
  currency: string;
  stockQuantity: number;
  lowStockThreshold: number;
  condition: 'new' | 'used' | 'refurbished';
  compatibility: Array<{
    make: string;
    model: string;
    yearStart?: number;
    yearEnd?: number;
    engine?: string;
    trim?: string;
    notes?: string;
  }>;
}

const DEMO_PRODUCTS: DemoProductDefinition[] = [
  // ── 1. Brakes ──────────────────────────────────────────────────────────────
  {
    sku: 'BRK-BREM-001',
    name: 'Brembo Front Ceramic Performance Brake Pads',
    brand: 'Brembo',
    manufacturer: 'Brembo S.p.A.',
    description: 'High-performance ceramic front brake pad set designed for minimal brake dust, zero squeal, and exceptional stopping power across demanding operating temperatures.',
    category: 'brakes',
    subcategory: 'Brake Pads',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1600705723382-7069176313b3?auto=format&fit=crop&w=800&q=80',
        alt: 'Brembo Brake Pads',
        isPrimary: true,
      },
    ],
    priceCents: 8499,
    currency: 'USD',
    stockQuantity: 24,
    lowStockThreshold: 5,
    condition: 'new',
    compatibility: [
      { make: 'Toyota', model: 'Camry', yearStart: 2018, yearEnd: 2024, engine: '2.5L I4 / 3.5L V6' },
      { make: 'Toyota', model: 'RAV4', yearStart: 2019, yearEnd: 2024, engine: '2.5L I4' },
      { make: 'Lexus', model: 'ES350', yearStart: 2019, yearEnd: 2023, engine: '3.5L V6' },
    ],
  },
  {
    sku: 'BRK-BOSH-002',
    name: 'Bosch QuietCast Premium Vented Front Disc Rotor',
    brand: 'Bosch',
    manufacturer: 'Robert Bosch GmbH',
    description: 'Precision balanced bi-metal vented disc brake rotor featuring heat-dissipating coating to eliminate rust and premature corrosion.',
    category: 'brakes',
    subcategory: 'Rotors & Discs',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?auto=format&fit=crop&w=800&q=80',
        alt: 'Bosch Rotor',
        isPrimary: true,
      },
    ],
    priceCents: 6250,
    currency: 'USD',
    stockQuantity: 18,
    lowStockThreshold: 4,
    condition: 'new',
    compatibility: [
      { make: 'Honda', model: 'Accord', yearStart: 2018, yearEnd: 2023, engine: '1.5T / 2.0T' },
      { make: 'Honda', model: 'Civic', yearStart: 2016, yearEnd: 2022, engine: '2.0L / 1.5T' },
    ],
  },
  {
    sku: 'BRK-AKEB-003',
    name: 'Akebono ProACT Ultra-Premium Rear Brake Pad Set',
    brand: 'Akebono',
    manufacturer: 'Akebono Brake Corporation',
    description: 'OE-grade ceramic formulation delivering consistent pedal feel and smooth deceleration without vibration.',
    category: 'brakes',
    subcategory: 'Brake Pads',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1486006920555-c77dce18193b?auto=format&fit=crop&w=800&q=80',
        alt: 'Akebono Brake Pads',
        isPrimary: true,
      },
    ],
    priceCents: 5800,
    currency: 'USD',
    stockQuantity: 32,
    lowStockThreshold: 6,
    condition: 'new',
    compatibility: [
      { make: 'Subaru', model: 'Outback', yearStart: 2015, yearEnd: 2022, engine: '2.5L / 2.4T' },
      { make: 'Subaru', model: 'Forester', yearStart: 2014, yearEnd: 2023, engine: '2.5L H4' },
    ],
  },

  // ── 2. Engine Parts ────────────────────────────────────────────────────────
  {
    sku: 'ENG-NGK-001',
    name: 'NGK Laser Iridium Long-Life Spark Plug (Set of 4)',
    brand: 'NGK',
    manufacturer: 'Niterra Co., Ltd.',
    description: 'Laser-welded iridium center electrode tip ensures high durability and greater spark efficiency for up to 100,000 miles.',
    category: 'engine-parts',
    subcategory: 'Spark Plugs & Ignition',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1580273916550-e323be2ae537?auto=format&fit=crop&w=800&q=80',
        alt: 'NGK Spark Plugs',
        isPrimary: true,
      },
    ],
    priceCents: 3999,
    currency: 'USD',
    stockQuantity: 45,
    lowStockThreshold: 10,
    condition: 'new',
    compatibility: [
      { make: 'Honda', model: 'Civic', yearStart: 2012, yearEnd: 2023, engine: '1.5T / 1.8L / 2.0L' },
      { make: 'Toyota', model: 'Corolla', yearStart: 2014, yearEnd: 2022, engine: '1.8L / 2.0L' },
      { make: 'Mazda', model: '3', yearStart: 2014, yearEnd: 2023, engine: '2.0L / 2.5L SkyActiv' },
    ],
  },
  {
    sku: 'ENG-GATE-002',
    name: 'Gates PowerGrip Timing Belt Kit with Water Pump',
    brand: 'Gates',
    manufacturer: 'Gates Industrial Corporation',
    description: 'Complete replacement timing kit including HNBR timing belt, hydraulic tensioner, premium bearings, and high-flow OE-spec water pump.',
    category: 'engine-parts',
    subcategory: 'Timing Belts & Chains',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=800&q=80',
        alt: 'Gates Timing Kit',
        isPrimary: true,
      },
    ],
    priceCents: 16950,
    currency: 'USD',
    stockQuantity: 12,
    lowStockThreshold: 3,
    condition: 'new',
    compatibility: [
      { make: 'Subaru', model: 'WRX / STI', yearStart: 2004, yearEnd: 2020, engine: 'EJ255 / EJ257 2.5L Turbo' },
      { make: 'Subaru', model: 'Forester XT', yearStart: 2004, yearEnd: 2013, engine: '2.5L Turbo' },
    ],
  },
  {
    sku: 'ENG-FELP-003',
    name: 'Fel-Pro PermaTorque Multi-Layer Steel Head Gasket Set',
    brand: 'Fel-Pro',
    manufacturer: 'DRiV Automotive Inc.',
    description: 'Engineered for imperfect sealing surfaces, maintaining peak cylinder compression under heavy thermal loads.',
    category: 'engine-parts',
    subcategory: 'Gaskets & Seals',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1486006920555-c77dce18193b?auto=format&fit=crop&w=800&q=80',
        alt: 'Fel-Pro Head Gasket',
        isPrimary: true,
      },
    ],
    priceCents: 8900,
    currency: 'USD',
    stockQuantity: 15,
    lowStockThreshold: 3,
    condition: 'new',
    compatibility: [
      { make: 'Ford', model: 'F-150', yearStart: 2011, yearEnd: 2020, engine: '5.0L Coyote V8' },
      { make: 'Ford', model: 'Mustang GT', yearStart: 2011, yearEnd: 2021, engine: '5.0L V8' },
    ],
  },

  // ── 3. Batteries ───────────────────────────────────────────────────────────
  {
    sku: 'BAT-OPTI-001',
    name: 'Optima RedTop High-Performance AGM Starter Battery (Group 34)',
    brand: 'Optima',
    manufacturer: 'Clarios LLC',
    description: 'SpiralCell design offers 15 times more vibration resistance and up to 3 times longer life than standard lead-acid batteries. 800 Cold Cranking Amps.',
    category: 'batteries',
    subcategory: 'AGM Batteries',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?auto=format&fit=crop&w=800&q=80',
        alt: 'Optima RedTop Battery',
        isPrimary: true,
      },
    ],
    priceCents: 28999,
    currency: 'USD',
    stockQuantity: 10,
    lowStockThreshold: 2,
    condition: 'new',
    compatibility: [
      { make: 'Ford', model: 'F-150', yearStart: 2005, yearEnd: 2023, engine: 'All Engines' },
      { make: 'Chevrolet', model: 'Silverado 1500', yearStart: 2007, yearEnd: 2022, engine: '4.8L / 5.3L / 6.2L' },
      { make: 'Jeep', model: 'Wrangler', yearStart: 2007, yearEnd: 2023, engine: '3.6L V6 / 2.0T' },
    ],
  },
  {
    sku: 'BAT-DIEH-002',
    name: 'DieHard Platinum Advanced AGM Battery (Group 35)',
    brand: 'DieHard',
    manufacturer: 'Advance Auto Parts / Clarios',
    description: 'Engineered for high electrical demand modern vehicles with start-stop technology and advanced driver assist systems.',
    category: 'batteries',
    subcategory: 'AGM Batteries',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1600705723382-7069176313b3?auto=format&fit=crop&w=800&q=80',
        alt: 'DieHard AGM Battery',
        isPrimary: true,
      },
    ],
    priceCents: 23999,
    currency: 'USD',
    stockQuantity: 14,
    lowStockThreshold: 3,
    condition: 'new',
    compatibility: [
      { make: 'Toyota', model: 'RAV4 / Camry', yearStart: 2012, yearEnd: 2023, engine: '2.5L I4' },
      { make: 'Subaru', model: 'Outback / Forester', yearStart: 2015, yearEnd: 2023, engine: '2.5L / 2.4T' },
      { make: 'Nissan', model: 'Rogue', yearStart: 2014, yearEnd: 2022, engine: '2.5L I4' },
    ],
  },
  {
    sku: 'BAT-NOCO-003',
    name: 'NOCO Boost Plus GB40 1000A UltraSafe Lithium Jump Starter',
    brand: 'NOCO',
    manufacturer: 'The NOCO Company',
    description: 'Compact, rugged 12-volt jump starter rated at 1000 amps. Spark-proof technology and reverse polarity protection for up to 20 jump starts per charge.',
    category: 'batteries',
    subcategory: 'Jump Starters & Cables',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1580273916550-e323be2ae537?auto=format&fit=crop&w=800&q=80',
        alt: 'NOCO GB40 Jump Starter',
        isPrimary: true,
      },
    ],
    priceCents: 9995,
    currency: 'USD',
    stockQuantity: 30,
    lowStockThreshold: 5,
    condition: 'new',
    compatibility: [
      { make: 'Universal', model: 'All 12V Vehicles', yearStart: 1990, yearEnd: 2026, notes: 'Gas engines up to 6.0L, diesel up to 3.0L' },
    ],
  },

  // ── 4. Tyres ───────────────────────────────────────────────────────────────
  {
    sku: 'TYR-MICH-001',
    name: 'Michelin Defender 2 All-Season Passenger Tyre 215/55R17 94V',
    brand: 'Michelin',
    manufacturer: 'Michelin Group',
    description: 'Maximized treadlife tyre featuring Evertread compound, offering up to 2 years longer tread life than leading competitors.',
    category: 'tyres',
    subcategory: 'All-Season',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1578844251758-2f71da64c96f?auto=format&fit=crop&w=800&q=80',
        alt: 'Michelin Defender 2 Tyre',
        isPrimary: true,
      },
    ],
    priceCents: 18500,
    currency: 'USD',
    stockQuantity: 20,
    lowStockThreshold: 4,
    condition: 'new',
    compatibility: [
      { make: 'Toyota', model: 'Camry', yearStart: 2015, yearEnd: 2024, trim: 'LE / SE / XLE' },
      { make: 'Honda', model: 'Accord', yearStart: 2013, yearEnd: 2022, trim: 'EX / EX-L' },
      { make: 'Nissan', model: 'Altima', yearStart: 2016, yearEnd: 2023, trim: 'SV / SL' },
    ],
  },
  {
    sku: 'TYR-BDG-002',
    name: 'Bridgestone Blizzak WS90 Studless Winter Tyre 205/55R16 91H',
    brand: 'Bridgestone',
    manufacturer: 'Bridgestone Corporation',
    description: 'Leader in snow and ice control utilizing NanoPro-Tech multicell compound that draws water away from road ice.',
    category: 'tyres',
    subcategory: 'Winter / Snow',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1549399542-7e3f8b79c341?auto=format&fit=crop&w=800&q=80',
        alt: 'Bridgestone Blizzak Winter Tyre',
        isPrimary: true,
      },
    ],
    priceCents: 16200,
    currency: 'USD',
    stockQuantity: 16,
    lowStockThreshold: 4,
    condition: 'new',
    compatibility: [
      { make: 'Volkswagen', model: 'Golf / Jetta', yearStart: 2010, yearEnd: 2023, trim: '16-inch Wheels' },
      { make: 'Subaru', model: 'Impreza', yearStart: 2012, yearEnd: 2023, trim: 'Base / Premium' },
      { make: 'Toyota', model: 'Corolla', yearStart: 2014, yearEnd: 2023, trim: 'LE / SE' },
    ],
  },
  {
    sku: 'TYR-BFG-003',
    name: 'BFGoodrich All-Terrain T/A KO2 Rugged Tyre LT265/70R17',
    brand: 'BFGoodrich',
    manufacturer: 'Michelin / BFGoodrich',
    description: 'CoreGard technology derived from championship desert racing provides split and bruise resistant sidewalls for serious off-road capability.',
    category: 'tyres',
    subcategory: 'All-Terrain / Off-Road',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1578844251758-2f71da64c96f?auto=format&fit=crop&w=800&q=80',
        alt: 'BFGoodrich All-Terrain KO2',
        isPrimary: true,
      },
    ],
    priceCents: 26500,
    currency: 'USD',
    stockQuantity: 12,
    lowStockThreshold: 4,
    condition: 'new',
    compatibility: [
      { make: 'Jeep', model: 'Wrangler Rubicon / Gladiator', yearStart: 2007, yearEnd: 2024, trim: '17-inch Wheels' },
      { make: 'Toyota', model: '4Runner / Tacoma', yearStart: 2005, yearEnd: 2024, trim: 'TRD Off-Road / Trail' },
      { make: 'Ford', model: 'F-150', yearStart: 2010, yearEnd: 2023, trim: 'XLT / FX4' },
    ],
  },

  // ── 5. Suspension ──────────────────────────────────────────────────────────
  {
    sku: 'SUS-BILS-001',
    name: 'Bilstein B6 Performance Front Monotube Strut Assembly',
    brand: 'Bilstein',
    manufacturer: 'Thyssenkrupp Bilstein GmbH',
    description: 'High gas pressure monotube dampers providing heightened vehicle stability and precision handling without compromising ride comfort.',
    category: 'suspension',
    subcategory: 'Shocks & Struts',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1486006920555-c77dce18193b?auto=format&fit=crop&w=800&q=80',
        alt: 'Bilstein B6 Strut',
        isPrimary: true,
      },
    ],
    priceCents: 17500,
    currency: 'USD',
    stockQuantity: 8,
    lowStockThreshold: 2,
    condition: 'new',
    compatibility: [
      { make: 'BMW', model: '3-Series (F30/F31)', yearStart: 2012, yearEnd: 2018, trim: '320i / 328i / 330i / 335i' },
      { make: 'BMW', model: '4-Series (F32/F36)', yearStart: 2014, yearEnd: 2020, trim: '428i / 430i / 435i' },
    ],
  },
  {
    sku: 'SUS-MOOG-002',
    name: 'Moog Problem Solver Front Lower Control Arm with Ball Joint',
    brand: 'Moog',
    manufacturer: 'DRiV Automotive Inc.',
    description: 'Pre-assembled structural arm with greasable sintered-metal bearings and Belleville washer preload for extended service life.',
    category: 'suspension',
    subcategory: 'Control Arms',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1600705723382-7069176313b3?auto=format&fit=crop&w=800&q=80',
        alt: 'Moog Control Arm',
        isPrimary: true,
      },
    ],
    priceCents: 11500,
    currency: 'USD',
    stockQuantity: 14,
    lowStockThreshold: 3,
    condition: 'new',
    compatibility: [
      { make: 'Ford', model: 'Explorer', yearStart: 2011, yearEnd: 2019, engine: '3.5L V6 / 2.3T' },
      { make: 'Ford', model: 'Flex', yearStart: 2010, yearEnd: 2019, engine: '3.5L V6' },
      { make: 'Lincoln', model: 'MKT', yearStart: 2010, yearEnd: 2019, engine: '3.5L / 3.7L' },
    ],
  },
  {
    sku: 'SUS-KYB-003',
    name: 'KYB Excel-G Twin-Tube Gas Shock Absorber Rear',
    brand: 'KYB',
    manufacturer: 'KYB Americas Corporation',
    description: 'Calibrated to restore original designed handling and performance, with multi-lip seal and teflon coated piston band.',
    category: 'suspension',
    subcategory: 'Shocks & Struts',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?auto=format&fit=crop&w=800&q=80',
        alt: 'KYB Excel-G Shock',
        isPrimary: true,
      },
    ],
    priceCents: 4999,
    currency: 'USD',
    stockQuantity: 22,
    lowStockThreshold: 4,
    condition: 'new',
    compatibility: [
      { make: 'Toyota', model: 'RAV4', yearStart: 2013, yearEnd: 2018, engine: '2.5L I4' },
      { make: 'Lexus', model: 'NX200t / NX300', yearStart: 2015, yearEnd: 2021, engine: '2.0T' },
    ],
  },

  // ── 6. Electrical Parts ───────────────────────────────────────────────────
  {
    sku: 'ELE-DENS-001',
    name: 'Denso First Time Fit High-Output Alternator 130A (Remanufactured)',
    brand: 'Denso',
    manufacturer: 'Denso Corporation',
    description: 'Precision remanufactured OE alternator with 100% tested voltage regulators and heat-resistant internal rectifiers.',
    category: 'electrical-parts',
    subcategory: 'Alternators',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1580273916550-e323be2ae537?auto=format&fit=crop&w=800&q=80',
        alt: 'Denso Alternator',
        isPrimary: true,
      },
    ],
    priceCents: 19500,
    currency: 'USD',
    stockQuantity: 7,
    lowStockThreshold: 2,
    condition: 'refurbished',
    compatibility: [
      { make: 'Toyota', model: 'Highlander', yearStart: 2008, yearEnd: 2016, engine: '3.5L 2GR-FE V6' },
      { make: 'Toyota', model: 'Sienna', yearStart: 2007, yearEnd: 2016, engine: '3.5L V6' },
      { make: 'Lexus', model: 'RX350', yearStart: 2007, yearEnd: 2015, engine: '3.5L V6' },
    ],
  },
  {
    sku: 'ELE-BOSH-002',
    name: 'Bosch Professional Starter Motor (Remanufactured)',
    brand: 'Bosch',
    manufacturer: 'Robert Bosch GmbH',
    description: 'Re-engineered to exceed strict OE tolerances. Factory rebuilt with brand new solenoid brushes and bearings.',
    category: 'electrical-parts',
    subcategory: 'Starter Motors',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=800&q=80',
        alt: 'Bosch Starter Motor',
        isPrimary: true,
      },
    ],
    priceCents: 16500,
    currency: 'USD',
    stockQuantity: 9,
    lowStockThreshold: 2,
    condition: 'refurbished',
    compatibility: [
      { make: 'BMW', model: '328i / 328xi (E90)', yearStart: 2007, yearEnd: 2013, engine: '3.0L N52 I6' },
      { make: 'BMW', model: '528i (E60/F10)', yearStart: 2008, yearEnd: 2011, engine: '3.0L N52 I6' },
      { make: 'BMW', model: 'X3 3.0si (E83)', yearStart: 2007, yearEnd: 2010, engine: '3.0L I6' },
    ],
  },
  {
    sku: 'ELE-PHIL-003',
    name: 'Philips CrystalVision Ultra H11 Halogen Headlight Bulb Pair',
    brand: 'Philips',
    manufacturer: 'Lumileds Holding B.V.',
    description: 'Crisp 4000K bright white beam simulates HID xenon styling and maximizes nighttime roadway peripheral visibility.',
    category: 'electrical-parts',
    subcategory: 'Lighting & Bulbs',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?auto=format&fit=crop&w=800&q=80',
        alt: 'Philips H11 Bulbs',
        isPrimary: true,
      },
    ],
    priceCents: 3499,
    currency: 'USD',
    stockQuantity: 40,
    lowStockThreshold: 8,
    condition: 'new',
    compatibility: [
      { make: 'Universal', model: 'H11 Socket Vehicles', yearStart: 2000, yearEnd: 2025, notes: 'Low beam or fog light application' },
    ],
  },

  // ── 7. Filters ────────────────────────────────────────────────────────────
  {
    sku: 'FLT-MOB1-001',
    name: 'Mobil 1 Extended Performance Full Synthetic Oil Filter M1-113A',
    brand: 'Mobil 1',
    manufacturer: 'ExxonMobil / Champion Labs',
    description: 'Synthetic blend media holds up to 28 grams of contaminants, providing up to 20,000 miles of guaranteed engine protection.',
    category: 'filters',
    subcategory: 'Oil Filters',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1600705723382-7069176313b3?auto=format&fit=crop&w=800&q=80',
        alt: 'Mobil 1 Oil Filter',
        isPrimary: true,
      },
    ],
    priceCents: 1499,
    currency: 'USD',
    stockQuantity: 60,
    lowStockThreshold: 12,
    condition: 'new',
    compatibility: [
      { make: 'Chevrolet', model: 'Silverado 1500 / Tahoe', yearStart: 2014, yearEnd: 2024, engine: '5.3L / 6.2L EcoTec3 V8' },
      { make: 'GMC', model: 'Sierra 1500 / Yukon', yearStart: 2014, yearEnd: 2024, engine: '5.3L / 6.2L V8' },
      { make: 'Cadillac', model: 'Escalade', yearStart: 2015, yearEnd: 2023, engine: '6.2L V8' },
    ],
  },
  {
    sku: 'FLT-KNN-002',
    name: 'K&N High-Flow Washable Drop-In Performance Engine Air Filter',
    brand: 'K&N',
    manufacturer: 'K&N Engineering, Inc.',
    description: 'Layered oiled cotton media boosts airflow up to 50% for improved acceleration. Washable and reusable for the life of the vehicle.',
    category: 'filters',
    subcategory: 'Air Filters',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1486006920555-c77dce18193b?auto=format&fit=crop&w=800&q=80',
        alt: 'K&N Air Filter',
        isPrimary: true,
      },
    ],
    priceCents: 5999,
    currency: 'USD',
    stockQuantity: 25,
    lowStockThreshold: 5,
    condition: 'new',
    compatibility: [
      { make: 'Ford', model: 'F-150', yearStart: 2015, yearEnd: 2023, engine: '2.7T / 3.5T EcoBoost / 5.0L V8' },
      { make: 'Ford', model: 'Expedition', yearStart: 2018, yearEnd: 2023, engine: '3.5L EcoBoost' },
    ],
  },
  {
    sku: 'FLT-BOSH-003',
    name: 'Bosch HEPA Premium Anti-Allergen Cabin Air Filter',
    brand: 'Bosch',
    manufacturer: 'Robert Bosch GmbH',
    description: 'Captures 99.97% of airborne particles at 0.3 microns including pollen, dust, soot, and mold spores without chemical odors.',
    category: 'filters',
    subcategory: 'Cabin Air Filters',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1580273916550-e323be2ae537?auto=format&fit=crop&w=800&q=80',
        alt: 'Bosch HEPA Cabin Filter',
        isPrimary: true,
      },
    ],
    priceCents: 1999,
    currency: 'USD',
    stockQuantity: 50,
    lowStockThreshold: 10,
    condition: 'new',
    compatibility: [
      { make: 'Toyota', model: 'Camry / RAV4 / Highlander', yearStart: 2018, yearEnd: 2024, engine: 'All Trims' },
      { make: 'Lexus', model: 'ES300h / ES350 / RX350', yearStart: 2016, yearEnd: 2023, engine: 'All Trims' },
    ],
  },
  {
    sku: 'FLT-MANN-004',
    name: 'Mann-Filter Spin-On High-Efficiency Fuel Filter',
    brand: 'Mann-Filter',
    manufacturer: 'MANn+HUMMEL Group',
    description: 'OEM European fuel filter trapping microscopic water droplets and particulates before reaching delicate high-pressure injectors.',
    category: 'filters',
    subcategory: 'Fuel Filters',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=800&q=80',
        alt: 'Mann Fuel Filter',
        isPrimary: true,
      },
    ],
    priceCents: 2850,
    currency: 'USD',
    stockQuantity: 35,
    lowStockThreshold: 6,
    condition: 'new',
    compatibility: [
      { make: 'Volkswagen', model: 'Golf TDI / Jetta TDI', yearStart: 2009, yearEnd: 2015, engine: '2.0L TDI Diesel' },
      { make: 'Audi', model: 'A3 TDI', yearStart: 2010, yearEnd: 2015, engine: '2.0L TDI' },
    ],
  },

  // ── 8. Cooling Systems ────────────────────────────────────────────────────
  {
    sku: 'COL-MISH-001',
    name: 'Mishimoto Performance Dual Core All-Aluminum Radiator',
    brand: 'Mishimoto',
    manufacturer: 'Mishimoto Automotive',
    description: '100% brazed aluminum core with TIG-welded end tanks, increasing coolant capacity and thermal dissipation by over 30%.',
    category: 'cooling-systems',
    subcategory: 'Radiators',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?auto=format&fit=crop&w=800&q=80',
        alt: 'Mishimoto Aluminum Radiator',
        isPrimary: true,
      },
    ],
    priceCents: 31500,
    currency: 'USD',
    stockQuantity: 6,
    lowStockThreshold: 2,
    condition: 'new',
    compatibility: [
      { make: 'Subaru', model: 'WRX / STI', yearStart: 2008, yearEnd: 2021, engine: '2.0T FA20 / 2.5T EJ257' },
    ],
  },
  {
    sku: 'COL-GATE-002',
    name: 'Gates Heavy Duty Water Pump with Premium Gasket',
    brand: 'Gates',
    manufacturer: 'Gates Industrial Corporation',
    description: 'Cast-iron impeller and unitized carbon-graphite seals deliver leak-proof cooling reliability under heavy towing loads.',
    category: 'cooling-systems',
    subcategory: 'Water Pumps',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1600705723382-7069176313b3?auto=format&fit=crop&w=800&q=80',
        alt: 'Gates Water Pump',
        isPrimary: true,
      },
    ],
    priceCents: 6800,
    currency: 'USD',
    stockQuantity: 19,
    lowStockThreshold: 4,
    condition: 'new',
    compatibility: [
      { make: 'Chevrolet', model: 'Silverado 1500 / Tahoe / Suburban', yearStart: 2007, yearEnd: 2014, engine: '4.8L / 5.3L / 6.0L / 6.2L V8' },
      { make: 'GMC', model: 'Sierra / Yukon', yearStart: 2007, yearEnd: 2014, engine: '5.3L / 6.2L V8' },
    ],
  },
  {
    sku: 'COL-STNT-003',
    name: 'Stant OE Exact Engine Coolant Thermostat (180°F)',
    brand: 'Stant',
    manufacturer: 'MotoRad / Stant',
    description: 'Direct replacement thermal element with stainless steel spring and brass body for rapid warming and steady operating temperature.',
    category: 'cooling-systems',
    subcategory: 'Thermostats',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1486006920555-c77dce18193b?auto=format&fit=crop&w=800&q=80',
        alt: 'Stant Thermostat',
        isPrimary: true,
      },
    ],
    priceCents: 1799,
    currency: 'USD',
    stockQuantity: 40,
    lowStockThreshold: 8,
    condition: 'new',
    compatibility: [
      { make: 'Ford', model: 'F-150 / Mustang', yearStart: 2011, yearEnd: 2022, engine: '3.7L / 5.0L V8' },
      { make: 'Ford', model: 'Explorer', yearStart: 2011, yearEnd: 2019, engine: '3.5L V6' },
    ],
  },

  // ── 9. Body Parts ─────────────────────────────────────────────────────────
  {
    sku: 'BDY-TYC-001',
    name: 'TYC Driver Side Heated Power Door Mirror Assembly',
    brand: 'TYC',
    manufacturer: 'TYC Brother Industrial Co.',
    description: 'Direct bolt-on OE replacement featuring heated glass, textured black base, and motorized tilt angle adjustments.',
    category: 'body-parts',
    subcategory: 'Mirrors & Glass',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=800&q=80',
        alt: 'TYC Door Mirror',
        isPrimary: true,
      },
    ],
    priceCents: 8999,
    currency: 'USD',
    stockQuantity: 11,
    lowStockThreshold: 3,
    condition: 'new',
    compatibility: [
      { make: 'Honda', model: 'CR-V', yearStart: 2017, yearEnd: 2022, trim: 'EX / EX-L / Touring' },
    ],
  },
  {
    sku: 'BDY-DEPO-002',
    name: 'Depo Front Bumper Lower Grille Mesh Assembly',
    brand: 'Depo',
    manufacturer: 'DEPO Auto Parts',
    description: 'Precision molded OEM grade ABS plastic grille replacement with UV protective clear coat against road stone chipping.',
    category: 'body-parts',
    subcategory: 'Grilles & Hoods',
    images: [
      {
        url: 'https://images.unsplash.com/photo-1580273916550-e323be2ae537?auto=format&fit=crop&w=800&q=80',
        alt: 'Depo Bumper Grille',
        isPrimary: true,
      },
    ],
    priceCents: 4500,
    currency: 'USD',
    stockQuantity: 15,
    lowStockThreshold: 3,
    condition: 'new',
    compatibility: [
      { make: 'Toyota', model: 'Camry', yearStart: 2018, yearEnd: 2023, trim: 'SE / XSE Sport Models' },
    ],
  },
];

export async function seedDemoProducts(): Promise<{
  supplierEmail: string;
  supplierCompanyName: string;
  totalSeeded: number;
  categoryCounts: Record<string, number>;
}> {
  // 1. Safety check
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run seedDemoProducts in production environment! Aborting.');
  }

  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/gis';
  const allowRemote = process.argv.includes('--allow-remote');
  assertScriptSafety(mongoUri, allowRemote, 'seedDemoProducts');

  console.log('Connecting to database...');
  await connectDB();

  // 2. Ensure categories exist
  console.log('Ensuring default part categories...');
  for (const cat of DEFAULT_PART_CATEGORIES) {
    await PartCategory.findOneAndUpdate(
      { slug: cat.slug },
      { $setOnInsert: cat },
      { upsert: true, returnDocument: 'after' }
    );
  }

  // 3. Find or ensure demo approved supplier
  const supplierEmail = 'supplier@gis.com';
  let supplierUser = await User.findOne({ email: supplierEmail });
  if (!supplierUser) {
    supplierUser = await User.create({
      email: supplierEmail,
      password: 'Password123!',
      fullName: 'Demo Supplier Rep',
      phone: '+15554567890',
      role: 'supplier',
      status: 'active',
      isActive: true,
      emailVerified: true,
      phoneVerified: true,
    });
    console.log(`Created demo supplier user: ${supplierEmail}`);
  }

  let supplierProfile = await SupplierProfile.findOne({ userId: supplierUser._id });
  if (!supplierProfile) {
    supplierProfile = await SupplierProfile.create({
      userId: supplierUser._id,
      companyName: 'Apex OEM Auto Supply',
      businessType: 'distributor',
      taxId: 'US-EIN-987654321',
      website: 'https://apexautosupply.example.com',
      description: 'Authorized OEM and Tier 1 aftermarket distributor offering brake kits, suspension components, and filters.',
      categories: ['brakes', 'suspension', 'engine-parts', 'electrical-parts', 'filters', 'batteries', 'tyres', 'cooling-systems', 'body-parts'],
      contactPerson: {
        name: 'Demo Supplier Rep',
        title: 'Wholesale Accounts Lead',
        email: supplierEmail,
        phone: '+15554567890',
      },
      businessPhone: '+15554567890',
      supportEmail: 'orders@apexautosupply.example.com',
      businessAddress: {
        street: '450 Industrial Parkway, Suite 12',
        city: 'Detroit',
        state: 'MI',
        postalCode: '48201',
        country: 'USA',
      },
      verificationStatus: 'approved',
      statusHistory: [
        {
          status: 'approved',
          by: 'system',
          at: new Date(),
          note: 'Approved demo supplier profile',
        },
      ],
    });
    console.log('Created approved SupplierProfile: Apex OEM Auto Supply');
  } else if (supplierProfile.verificationStatus !== 'approved') {
    supplierProfile.verificationStatus = 'approved';
    await supplierProfile.save();
    console.log('Updated SupplierProfile to approved');
  }

  // 4. Upsert demo products idempotently
  console.log(`Upserting ${DEMO_PRODUCTS.length} realistic demo products...`);
  const categoryCounts: Record<string, number> = {};

  for (const item of DEMO_PRODUCTS) {
    const updateDoc = {
      supplierId: supplierProfile._id,
      name: item.name,
      sku: item.sku,
      brand: item.brand,
      manufacturer: item.manufacturer,
      description: item.description,
      category: item.category,
      subcategory: item.subcategory,
      images: item.images,
      priceCents: item.priceCents,
      currency: item.currency,
      stockQuantity: item.stockQuantity,
      lowStockThreshold: item.lowStockThreshold,
      condition: item.condition,
      compatibility: item.compatibility,
      status: 'active',
      $setOnInsert: {
        statusHistory: [
          {
            status: 'active',
            by: 'seed_script',
            at: new Date(),
            note: 'Populated by demo product seed script',
          },
        ],
      },
    };

    await PartProduct.findOneAndUpdate(
      { sku: item.sku },
      updateDoc,
      { upsert: true, returnDocument: 'after' }
    );

    categoryCounts[item.category] = (categoryCounts[item.category] || 0) + 1;
  }

  console.log('Demo products seeded successfully:');
  for (const [cat, count] of Object.entries(categoryCounts)) {
    console.log(`  - Category "${cat}": ${count} products`);
  }
  console.log(`Total: ${DEMO_PRODUCTS.length} products associated with ${supplierProfile.companyName} (${supplierEmail})`);

  return {
    supplierEmail,
    supplierCompanyName: supplierProfile.companyName,
    totalSeeded: DEMO_PRODUCTS.length,
    categoryCounts,
  };
}

if (require.main === module) {
  seedDemoProducts()
    .then(() => {
      console.log('Done.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seeding failed:', err);
      process.exit(1);
    });
}
