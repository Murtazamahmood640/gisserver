import { ServiceCategory, IServiceCategory } from '../../models/ServiceCategory';
import { Service, IService } from '../../models/Service';
import { ServicePrice } from '../../models/ServicePrice';
import { Appointment } from '../../models/Appointment';
import { Addon, IAddon } from '../../models/Addon';
import { Coupon } from '../../models/Coupon';
import logger from '../../config/logger';

export class CatalogService {
  // ---------------------------------------------------------------------------
  // Categories
  // ---------------------------------------------------------------------------
  static async getActiveCategories(): Promise<any[]> {
    return ServiceCategory.find({ isActive: true })
      .select('slug name description icon sortOrder requiresLocation allowsScheduling')
      .sort({ sortOrder: 1, name: 1 })
      .lean();
  }

  static async getAllCategories(): Promise<IServiceCategory[]> {
    return ServiceCategory.find().sort({ sortOrder: 1, name: 1 });
  }

  static async getCategoryById(id: string): Promise<IServiceCategory | null> {
    return ServiceCategory.findById(id);
  }

  static async createCategory(data: Partial<IServiceCategory>): Promise<IServiceCategory> {
    const existing = await ServiceCategory.findOne({ slug: data.slug?.toLowerCase().trim() });
    if (existing) {
      const err = new Error(`Category with slug '${data.slug}' already exists`) as any;
      err.statusCode = 409;
      err.code = 'DUPLICATE_KEY_ERROR';
      throw err;
    }

    const category = new ServiceCategory(data);
    await category.save();
    logger.info({ categoryId: category._id.toString(), slug: category.slug }, 'Service category created');
    return category;
  }

  static async updateCategory(id: string, data: Partial<IServiceCategory>): Promise<IServiceCategory | null> {
    const category = await ServiceCategory.findByIdAndUpdate(id, { $set: data }, { returnDocument: 'after', runValidators: true });
    if (category) {
      logger.info({ categoryId: id }, 'Service category updated');
    }
    return category;
  }

  static async deleteCategory(id: string): Promise<boolean> {
    // Conflict check: block deleting category with existing services
    const serviceCount = await Service.countDocuments({ categoryId: id });
    if (serviceCount > 0) {
      const err = new Error(`Cannot delete category: contains ${serviceCount} existing service(s)`) as any;
      err.statusCode = 409;
      err.code = 'CATEGORY_IN_USE';
      throw err;
    }

    const res = await ServiceCategory.findByIdAndDelete(id);
    if (res) {
      logger.info({ categoryId: id }, 'Service category deleted');
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Services
  // ---------------------------------------------------------------------------
  static async getActiveServices(filter?: { categoryId?: string; categorySlug?: string }): Promise<any[]> {
    const query: any = { isActive: true };

    if (filter?.categoryId) {
      query.categoryId = filter.categoryId;
    } else if (filter?.categorySlug) {
      const cat = await ServiceCategory.findOne({ slug: filter.categorySlug, isActive: true });
      if (cat) {
        query.categoryId = cat._id;
      } else {
        return [];
      }
    }

    const services = await Service.find(query)
      .populate({
        path: 'categoryId',
        match: { isActive: true },
        select: 'name slug icon',
      })
      .select('slug name description durationMinutes images pricingModel categoryId')
      .sort({ name: 1 })
      .lean();

    // Ensure services with inactive categories are omitted
    return services
      .filter((s: any) => Boolean(s.categoryId))
      .map((s: any) => ({
        id: s._id.toString(),
        slug: s.slug,
        name: s.name,
        description: s.description,
        durationMinutes: s.durationMinutes,
        images: s.images,
        pricingModel: s.pricingModel,
        category: {
          id: s.categoryId._id.toString(),
          name: s.categoryId.name,
          slug: s.categoryId.slug,
          icon: s.categoryId.icon,
        },
      }));
  }

  static async getAllServices(): Promise<IService[]> {
    return Service.find().populate('categoryId', 'name slug icon').sort({ name: 1 });
  }

  static async getServiceById(id: string): Promise<IService | null> {
    return Service.findById(id).populate('categoryId', 'name slug icon');
  }

  static async getServiceBySlug(slug: string): Promise<IService | null> {
    return Service.findOne({ slug: slug.toLowerCase().trim() }).populate('categoryId', 'name slug icon');
  }

  static async createService(data: Partial<IService>): Promise<IService> {
    const existing = await Service.findOne({ slug: data.slug?.toLowerCase().trim() });
    if (existing) {
      const err = new Error(`Service with slug '${data.slug}' already exists`) as any;
      err.statusCode = 409;
      err.code = 'DUPLICATE_KEY_ERROR';
      throw err;
    }

    const service = new Service(data);
    await service.save();
    logger.info({ serviceId: service._id.toString(), slug: service.slug }, 'Service created');
    return service;
  }

  static async updateService(id: string, data: Partial<IService>): Promise<IService | null> {
    const service = await Service.findByIdAndUpdate(id, { $set: data }, { returnDocument: 'after', runValidators: true });
    if (service) {
      logger.info({ serviceId: id }, 'Service updated');
    }
    return service;
  }

  static async deleteService(id: string): Promise<boolean> {
    const service = await Service.findById(id);
    if (!service) return false;

    // Conflict check 1: block deleting service with existing prices
    const priceCount = await ServicePrice.countDocuments({ serviceId: id });
    if (priceCount > 0) {
      const err = new Error(`Cannot delete service: contains ${priceCount} associated price record(s)`) as any;
      err.statusCode = 409;
      err.code = 'SERVICE_HAS_PRICES';
      throw err;
    }

    // Conflict check 2: block deleting service referenced in appointments/bookings
    const appointmentCount = await Appointment.countDocuments({
      serviceType: new RegExp(service.name, 'i'),
    });
    if (appointmentCount > 0) {
      const err = new Error(`Cannot delete service: referenced in ${appointmentCount} appointment(s)`) as any;
      err.statusCode = 409;
      err.code = 'SERVICE_HAS_APPOINTMENTS';
      throw err;
    }

    const res = await Service.findByIdAndDelete(id);
    if (res) {
      logger.info({ serviceId: id }, 'Service deleted');
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Addons
  // ---------------------------------------------------------------------------
  static async getActiveAddons(filter?: { serviceId?: string; categoryId?: string }): Promise<any[]> {
    const query: any = { isActive: true };

    if (filter?.serviceId) {
      query.$or = [
        { serviceIds: filter.serviceId },
        { serviceIds: { $size: 0 } },
        { serviceIds: { $exists: false } },
      ];
    }
    if (filter?.categoryId) {
      query.categoryId = filter.categoryId;
    }

    const addons = await Addon.find(query).select('name price').sort({ price: 1, name: 1 }).lean();
    return addons.map((a: any) => ({
      id: a._id.toString(),
      name: a.name,
      price: a.price, // Integer cents
      priceUsd: Number((a.price / 100).toFixed(2)),
    }));
  }

  static async getAllAddons(): Promise<any[]> {
    const addons = await Addon.find().populate('serviceIds', 'name slug').populate('categoryId', 'name slug').sort({ name: 1 });
    return addons.map((a) => ({
      _id: a._id,
      id: a._id.toString(),
      name: a.name,
      price: a.price, // Integer cents
      priceUsd: Number((a.price / 100).toFixed(2)),
      serviceIds: a.serviceIds,
      categoryId: a.categoryId,
      isActive: a.isActive,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    }));
  }

  static async getAddonById(id: string): Promise<IAddon | null> {
    return Addon.findById(id);
  }

  static async createAddon(data: Partial<IAddon>): Promise<IAddon> {
    const addon = new Addon(data);
    await addon.save();
    logger.info({ addonId: addon._id.toString(), name: addon.name }, 'Addon created');
    return addon;
  }

  static async updateAddon(id: string, data: Partial<IAddon>): Promise<IAddon | null> {
    const addon = await Addon.findByIdAndUpdate(id, { $set: data }, { returnDocument: 'after', runValidators: true });
    if (addon) {
      logger.info({ addonId: id }, 'Addon updated');
    }
    return addon;
  }

  static async deleteAddon(id: string): Promise<boolean> {
    const res = await Addon.findByIdAndDelete(id);
    if (res) {
      logger.info({ addonId: id }, 'Addon deleted');
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Coupons Validation
  // ---------------------------------------------------------------------------
  static async validateCoupon(code: string, subtotalCents: number) {
    const cleanCode = code.toUpperCase().trim();
    if (!cleanCode) {
      return { valid: false, discountPercent: 0, discountCents: 0 };
    }

    let discountPercent = 0;
    const coupon = await Coupon.findOne({
      code: cleanCode,
      isActive: true,
      expiryDate: { $gt: new Date() },
    });

    if (coupon) {
      discountPercent = coupon.discountPercentage;
    } else if (cleanCode === 'FIRST10') {
      discountPercent = 10;
    }

    if (discountPercent > 0) {
      const discountCents = Math.round((subtotalCents * discountPercent) / 100);
      return {
        valid: true,
        discountPercent,
        discountCents,
      };
    }

    return {
      valid: false,
      discountPercent: 0,
      discountCents: 0,
    };
  }
}
