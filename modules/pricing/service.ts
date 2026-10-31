import { ServicePrice, IServicePrice, VehicleCategory } from '../../models/ServicePrice';
import { Service } from '../../models/Service';
import { ServiceCategory } from '../../models/ServiceCategory';
import { CommissionRule, ICommissionRule } from '../../models/CommissionRule';
import logger from '../../config/logger';

export class PricingService {
  /**
   * Helper to normalize vehicle category input
   */
  static normalizeVehicleCategory(category: string): VehicleCategory {
    const clean = category.toLowerCase().trim();
    if (clean === 'sedan') return 'sedan';
    if (clean === 'crossover') return 'crossover';
    if (clean === 'suv') return 'suv';
    if (clean === 'truck') return 'truck';
    if (clean === 'rv-boat-semi' || clean === 'rv/boat/semi' || clean.includes('boat') || clean.includes('semi') || clean.includes('rv')) {
      return 'rv-boat-semi';
    }
    return clean as VehicleCategory;
  }

  /**
   * Public price lookup by service (ID or Slug) and vehicle category
   */
  static async lookupPrice(serviceIdentifier: string, rawVehicleCategory: string) {
    const vehicleCategory = this.normalizeVehicleCategory(rawVehicleCategory);

    let service = null;
    if (/^[0-9a-fA-F]{24}$/.test(serviceIdentifier)) {
      service = await Service.findById(serviceIdentifier);
    }
    if (!service) {
      service = await Service.findOne({ slug: serviceIdentifier.toLowerCase().trim() });
    }

    if (!service || !service.isActive) {
      const err = new Error(`Service '${serviceIdentifier}' not found or is currently unavailable`) as any;
      err.statusCode = 404;
      err.code = 'NOT_FOUND';
      throw err;
    }

    if (service.categoryId) {
      const category = await ServiceCategory.findById(service.categoryId);
      if (!category || !category.isActive) {
        const err = new Error(`Service '${serviceIdentifier}' is currently unavailable`) as any;
        err.statusCode = 404;
        err.code = 'NOT_FOUND';
        throw err;
      }
    }

    const priceRecord = await ServicePrice.findOne({
      serviceId: service._id,
      vehicleCategory,
    });

    if (!priceRecord) {
      const err = new Error(`Price for service '${service.name}' and category '${vehicleCategory}' not found`) as any;
      err.statusCode = 404;
      err.code = 'PRICE_NOT_FOUND';
      throw err;
    }

    return {
      serviceId: service._id.toString(),
      serviceName: service.name,
      serviceSlug: service.slug,
      vehicleCategory,
      price: priceRecord.price, // Integer cents
      priceUsd: Number((priceRecord.price / 100).toFixed(2)),
    };
  }

  static async getPricesForService(serviceId: string) {
    const prices = await ServicePrice.find({ serviceId }).sort({ vehicleCategory: 1 });
    return prices.map((p) => ({
      _id: p._id,
      serviceId: p.serviceId,
      vehicleCategory: p.vehicleCategory,
      price: p.price,
      priceUsd: Number((p.price / 100).toFixed(2)),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
  }

  static async getAllPrices() {
    const prices = await ServicePrice.find()
      .populate('serviceId', 'name slug categoryId')
      .sort({ serviceId: 1, vehicleCategory: 1 });
    return prices.map((p) => ({
      _id: p._id,
      serviceId: p.serviceId,
      vehicleCategory: p.vehicleCategory,
      price: p.price,
      priceUsd: Number((p.price / 100).toFixed(2)),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
  }

  static async upsertPrice(serviceId: string, rawVehicleCategory: string, price: number): Promise<IServicePrice> {
    const vehicleCategory = this.normalizeVehicleCategory(rawVehicleCategory);
    const updated = await ServicePrice.findOneAndUpdate(
      { serviceId, vehicleCategory },
      { $set: { price } },
      { returnDocument: 'after', upsert: true, runValidators: true }
    );
    logger.info({ serviceId, vehicleCategory, price }, 'Service price upserted');
    return updated;
  }

  static async updatePrice(id: string, price: number): Promise<IServicePrice | null> {
    const updated = await ServicePrice.findByIdAndUpdate(
      id,
      { $set: { price } },
      { returnDocument: 'after', runValidators: true }
    );
    if (updated) {
      logger.info({ priceId: id, price }, 'Service price updated');
    }
    return updated;
  }

  static async deletePrice(id: string): Promise<boolean> {
    const res = await ServicePrice.findByIdAndDelete(id);
    if (res) {
      logger.info({ priceId: id }, 'Service price deleted');
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Commission Rules
  // ---------------------------------------------------------------------------
  static async getCommissionRules(): Promise<ICommissionRule[]> {
    return CommissionRule.find().sort({ scope: 1, createdAt: -1 });
  }

  static async createCommissionRule(data: Partial<ICommissionRule>): Promise<ICommissionRule> {
    const rule = new CommissionRule(data);
    await rule.save();
    logger.info({ ruleId: rule._id.toString(), scope: rule.scope }, 'Commission rule created');
    return rule;
  }

  static async updateCommissionRule(id: string, data: Partial<ICommissionRule>): Promise<ICommissionRule | null> {
    const rule = await CommissionRule.findByIdAndUpdate(id, { $set: data }, { returnDocument: 'after', runValidators: true });
    if (rule) {
      logger.info({ ruleId: id }, 'Commission rule updated');
    }
    return rule;
  }

  static async deleteCommissionRule(id: string): Promise<boolean> {
    const res = await CommissionRule.findByIdAndDelete(id);
    if (res) {
      logger.info({ ruleId: id }, 'Commission rule deleted');
      return true;
    }
    return false;
  }

  /**
   * Resolves effective commission for a transaction (service -> category -> global)
   */
  static async calculateCommission(params: {
    amountCents: number;
    serviceId?: string;
    categoryId?: string;
  }) {
    let rule: ICommissionRule | null = null;

    if (params.serviceId) {
      rule = await CommissionRule.findOne({ scope: 'service', scopeId: params.serviceId, isActive: true });
    }

    if (!rule && params.categoryId) {
      rule = await CommissionRule.findOne({ scope: 'category', scopeId: params.categoryId, isActive: true });
    }

    if (!rule) {
      rule = await CommissionRule.findOne({ scope: 'global', isActive: true });
    }

    const commissionPercent = rule ? rule.commissionPercent : 15;
    const processingPercent = rule ? rule.processingPercent : 3;

    const commissionAmountCents = Math.round((params.amountCents * commissionPercent) / 100);
    const processingAmountCents = Math.round((params.amountCents * processingPercent) / 100);
    const payoutAmountCents = Math.max(0, params.amountCents - commissionAmountCents - processingAmountCents);

    return {
      amountCents: params.amountCents,
      amountUsd: Number((params.amountCents / 100).toFixed(2)),
      commissionPercent,
      processingPercent,
      commissionAmountCents,
      processingAmountCents,
      payoutAmountCents,
      appliedRuleScope: rule ? rule.scope : 'default-global',
    };
  }
}
