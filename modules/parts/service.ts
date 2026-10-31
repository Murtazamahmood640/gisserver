import mongoose from 'mongoose';
import { PartProduct, IPartProduct, PartProductStatus, IProductImage } from '../../models/PartProduct';
import { PartCategory, IPartCategory, DEFAULT_PART_CATEGORIES } from '../../models/PartCategory';
import { InventoryLog, InventoryAdjustmentReason } from '../../models/InventoryLog';
import { SupplierProfile } from '../../models/SupplierProfile';
import { PartOrder, IPartOrder, PartOrderStatus } from '../../models/PartOrder';
import { createHttpError } from '../../utils/httpErrors';
import logger from '../../config/logger';

// Status transitions that suppliers can make themselves
const SUPPLIER_ALLOWED_TRANSITIONS: Partial<Record<PartProductStatus, PartProductStatus[]>> = {
  draft: ['pending_review', 'archived'],
  rejected: ['draft', 'pending_review'],
  active: ['archived'],
  pending_review: ['draft'],
};

// Status transitions that admins can make
const ADMIN_ALLOWED_TRANSITIONS: Partial<Record<PartProductStatus, PartProductStatus[]>> = {
  pending_review: ['active', 'rejected'],
  active: ['archived'],
  archived: ['active'],
  rejected: ['active'],
};

// Ensure default categories exist in DB
export async function seedPartCategories(): Promise<void> {
  if (mongoose.connection.readyState !== 1) {
    return;
  }
  try {
    for (const cat of DEFAULT_PART_CATEGORIES) {
      await PartCategory.findOneAndUpdate(
        { slug: cat.slug },
        { $setOnInsert: { ...cat, isActive: true } },
        { upsert: true, returnDocument: 'before' }
      );
    }
  } catch (err) {
    logger.error({ err }, 'Failed to seed part categories');
  }
}

// ---------------------------------------------------------------------------
// Helper: sanitize product for supplier/public views
// ---------------------------------------------------------------------------
function sanitizeProduct(product: IPartProduct) {
  const obj = product.toObject({ virtuals: true });
  delete obj.adminNotes;
  return obj;
}

// ---------------------------------------------------------------------------
// Category Management
// ---------------------------------------------------------------------------
export class PartCategoryService {
  static async listCategories(activeOnly = true): Promise<IPartCategory[]> {
    const filter = activeOnly ? { isActive: true } : {};
    return PartCategory.find(filter).sort({ sortOrder: 1, name: 1 }).lean();
  }

  static async getCategory(slug: string): Promise<IPartCategory> {
    const cat = await PartCategory.findOne({ slug }).lean();
    if (!cat) throw createHttpError('Category not found', 404, 'NOT_FOUND');
    return cat;
  }

  static async createCategory(data: {
    slug: string;
    name: string;
    description?: string;
    icon?: string;
    subcategories?: string[];
    isActive?: boolean;
    sortOrder?: number;
  }): Promise<IPartCategory> {
    const existing = await PartCategory.findOne({ slug: data.slug });
    if (existing) throw createHttpError('Category slug already exists', 409, 'CONFLICT');
    return PartCategory.create(data);
  }

  static async updateCategory(slug: string, data: Partial<IPartCategory>): Promise<IPartCategory> {
    const cat = await PartCategory.findOneAndUpdate({ slug }, { $set: data }, { new: true });
    if (!cat) throw createHttpError('Category not found', 404, 'NOT_FOUND');
    return cat;
  }
}

// ---------------------------------------------------------------------------
// Supplier Product Management
// ---------------------------------------------------------------------------
export class PartProductService {

  /** Get the supplier profile _id from userId */
  static async getSupplierProfileId(userId: string): Promise<mongoose.Types.ObjectId> {
    const profile = await SupplierProfile.findOne({ userId }).select('_id verificationStatus').lean();
    if (!profile) throw createHttpError('Supplier profile not found', 404, 'NOT_FOUND');
    return profile._id;
  }

  /** Create a new product draft */
  static async createProduct(
    userId: string,
    data: {
      name: string;
      sku: string;
      brand: string;
      manufacturer?: string;
      description: string;
      category: string;
      subcategory?: string;
      priceCents: number;
      currency?: string;
      stockQuantity?: number;
      lowStockThreshold?: number;
      condition?: 'new' | 'used' | 'refurbished';
      compatibility?: any[];
      images?: any[];
      status?: PartProductStatus;
    }
  ): Promise<any> {
    const supplierId = await this.getSupplierProfileId(userId);

    // Check SKU uniqueness within this supplier
    const existing = await PartProduct.findOne({
      supplierId,
      sku: data.sku.trim().toUpperCase(),
    });
    if (existing) {
      throw createHttpError(`SKU '${data.sku}' is already used by another product`, 409, 'DUPLICATE_SKU');
    }

    // Validate category exists
    const category = await PartCategory.findOne({ slug: data.category, isActive: true }).lean();
    if (!category) {
      throw createHttpError(`Category '${data.category}' not found or inactive`, 400, 'INVALID_CATEGORY');
    }

    const initialStatus: PartProductStatus = data.status === 'pending_review' ? 'pending_review' : 'draft';

    const product = await PartProduct.create({
      supplierId,
      name: data.name.trim(),
      sku: data.sku.trim().toUpperCase(),
      brand: data.brand.trim(),
      manufacturer: data.manufacturer?.trim(),
      description: data.description.trim(),
      category: data.category,
      subcategory: data.subcategory?.trim(),
      priceCents: data.priceCents,
      currency: data.currency || 'USD',
      stockQuantity: data.stockQuantity ?? 0,
      lowStockThreshold: data.lowStockThreshold ?? 5,
      condition: data.condition ?? 'new',
      compatibility: data.compatibility ?? [],
      images: data.images ?? [],
      status: initialStatus,
      statusHistory: [
        {
          status: initialStatus,
          by: userId,
          at: new Date(),
          note: 'Product created',
        },
      ],
    });

    // Record initial stock in inventory log
    if ((data.stockQuantity ?? 0) > 0) {
      await InventoryLog.create({
        productId: product._id,
        supplierId,
        change: data.stockQuantity!,
        previousQuantity: 0,
        newQuantity: data.stockQuantity!,
        reason: 'initial_stock' as InventoryAdjustmentReason,
        actorId: userId,
        actorRole: 'supplier',
        notes: 'Initial stock set on product creation',
      });
    }

    return sanitizeProduct(product);
  }

  /** List supplier's own products */
  static async listSupplierProducts(
    userId: string,
    options: {
      status?: PartProductStatus | '';
      category?: string;
      search?: string;
      page?: number;
      limit?: number;
    }
  ): Promise<any> {
    const supplierId = await this.getSupplierProfileId(userId);
    const { status, category, search, page = 1, limit = 20 } = options;
    const skip = (page - 1) * limit;

    const filter: Record<string, any> = { supplierId };
    if (status) filter.status = status;
    if (category) filter.category = category;
    if (search) {
      filter.$text = { $search: search };
    }

    const [products, total] = await Promise.all([
      PartProduct.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PartProduct.countDocuments(filter),
    ]);

    return {
      products: products.map((p: any) => {
        const { adminNotes, ...rest } = p;
        return rest;
      }),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Get supplier's own product by id */
  static async getSupplierProduct(userId: string, productId: string): Promise<any> {
    const supplierId = await this.getSupplierProfileId(userId);
    const product = await PartProduct.findOne({ _id: productId, supplierId }).lean();
    if (!product) throw createHttpError('Product not found', 404, 'NOT_FOUND');
    const { adminNotes, ...rest } = product as any;
    return rest;
  }

  /** Update supplier's own product */
  static async updateProduct(
    userId: string,
    productId: string,
    data: Partial<{
      name: string;
      sku: string;
      brand: string;
      manufacturer: string;
      description: string;
      category: string;
      subcategory: string;
      priceCents: number;
      currency: string;
      stockQuantity: number;
      lowStockThreshold: number;
      condition: 'new' | 'used' | 'refurbished';
      compatibility: any[];
      images: any[];
      status: PartProductStatus;
    }>
  ): Promise<any> {
    const supplierId = await this.getSupplierProfileId(userId);
    const product = await PartProduct.findOne({ _id: productId, supplierId });
    if (!product) throw createHttpError('Product not found', 404, 'NOT_FOUND');

    // Validate status transition
    if (data.status && data.status !== product.status) {
      const allowed = SUPPLIER_ALLOWED_TRANSITIONS[product.status as PartProductStatus] ?? [];
      if (!allowed.includes(data.status)) {
        throw createHttpError(
          `Cannot transition product from '${product.status}' to '${data.status}'`,
          400,
          'INVALID_STATE_TRANSITION'
        );
      }
    }

    // SKU uniqueness check if sku is being changed
    if (data.sku && data.sku.toUpperCase() !== product.sku) {
      const duplicate = await PartProduct.findOne({
        supplierId,
        sku: data.sku.toUpperCase(),
        _id: { $ne: productId },
      });
      if (duplicate) {
        throw createHttpError(`SKU '${data.sku}' is already used by another product`, 409, 'DUPLICATE_SKU');
      }
    }

    // Validate category if changed
    if (data.category && data.category !== product.category) {
      const category = await PartCategory.findOne({ slug: data.category, isActive: true });
      if (!category) throw createHttpError(`Category '${data.category}' not found or inactive`, 400, 'INVALID_CATEGORY');
    }

    const editableFields = [
      'name', 'sku', 'brand', 'manufacturer', 'description', 'category',
      'subcategory', 'priceCents', 'currency', 'lowStockThreshold', 'condition',
      'compatibility', 'images',
    ] as const;

    for (const field of editableFields) {
      if (data[field] !== undefined) {
        if (field === 'sku') {
          (product as any).sku = (data.sku as string).toUpperCase();
        } else {
          (product as any)[field] = data[field];
        }
      }
    }

    // Handle stock quantity change as inventory adjustment
    if (data.stockQuantity !== undefined && data.stockQuantity !== product.stockQuantity) {
      const change = data.stockQuantity - product.stockQuantity;
      const prev = product.stockQuantity;
      product.stockQuantity = data.stockQuantity;
      await InventoryLog.create({
        productId: product._id,
        supplierId,
        change,
        previousQuantity: prev,
        newQuantity: data.stockQuantity,
        reason: 'manual_adjustment' as InventoryAdjustmentReason,
        actorId: userId,
        actorRole: 'supplier',
        notes: 'Stock updated via product edit',
      });
    }

    // Handle status transition
    if (data.status && data.status !== product.status) {
      product.statusHistory.push({
        status: data.status,
        by: userId,
        at: new Date(),
        note: `Status changed by supplier`,
      });
      product.status = data.status;
    }

    await product.save();
    return sanitizeProduct(product);
  }

  /** Adjust stock quantity atomically */
  static async adjustStock(
    userId: string,
    productId: string,
    data: {
      change?: number;
      newQuantity?: number;
      reason: InventoryAdjustmentReason;
      notes?: string;
    },
    actorRole: string = 'supplier'
  ): Promise<any> {
    const supplierId = await this.getSupplierProfileId(userId);

    // Use findOneAndUpdate for atomic update to prevent race conditions
    let updateResult: any;
    let previousQuantity: number;
    let newQuantity: number;
    let change: number;

    if (data.newQuantity !== undefined) {
      // Set to exact quantity
      newQuantity = data.newQuantity;
      const product = await PartProduct.findOneAndUpdate(
        { _id: productId, supplierId },
        { $set: { stockQuantity: data.newQuantity } },
        { new: false } // return old doc
      );
      if (!product) throw createHttpError('Product not found', 404, 'NOT_FOUND');
      previousQuantity = product.stockQuantity;
      change = newQuantity - previousQuantity;
      updateResult = product;
    } else if (data.change !== undefined) {
      // Increment/decrement atomically
      const product = await PartProduct.findOneAndUpdate(
        {
          _id: productId,
          supplierId,
          // Ensure stock doesn't go negative
          stockQuantity: { $gte: data.change < 0 ? -data.change : 0 },
        },
        { $inc: { stockQuantity: data.change } },
        { new: false }
      );
      if (!product) {
        // Check if product exists at all
        const exists = await PartProduct.findOne({ _id: productId, supplierId });
        if (!exists) throw createHttpError('Product not found', 404, 'NOT_FOUND');
        throw createHttpError('Insufficient stock for this adjustment', 400, 'INSUFFICIENT_STOCK');
      }
      previousQuantity = product.stockQuantity;
      newQuantity = previousQuantity + data.change;
      change = data.change;
      updateResult = product;
    } else {
      throw createHttpError('Either change or newQuantity must be provided', 400, 'VALIDATION_ERROR');
    }

    // Record in inventory log
    await InventoryLog.create({
      productId: productId,
      supplierId,
      change,
      previousQuantity,
      newQuantity,
      reason: data.reason,
      actorId: userId,
      actorRole,
      notes: data.notes,
    });

    const updated = await PartProduct.findById(productId).lean();
    const { adminNotes, ...rest } = updated as any;
    return rest;
  }

  /** Upload product image — stores URL after cloudinary upload */
  static async addProductImage(
    userId: string,
    productId: string,
    imageData: { url: string; alt?: string; isPrimary?: boolean }
  ): Promise<any> {
    const supplierId = await this.getSupplierProfileId(userId);
    const product = await PartProduct.findOne({ _id: productId, supplierId });
    if (!product) throw createHttpError('Product not found', 404, 'NOT_FOUND');

    if (product.images.length >= 10) {
      throw createHttpError('Maximum of 10 images per product', 400, 'IMAGE_LIMIT_REACHED');
    }

    // If setting as primary, unset others
    if (imageData.isPrimary) {
      product.images.forEach((img: IProductImage) => { img.isPrimary = false; });
    }

    product.images.push({
      url: imageData.url,
      alt: imageData.alt ?? '',
      isPrimary: imageData.isPrimary ?? product.images.length === 0,
    });

    await product.save();
    return sanitizeProduct(product);
  }

  /** Remove a product image by URL index */
  static async removeProductImage(userId: string, productId: string, imageIndex: number): Promise<any> {
    const supplierId = await this.getSupplierProfileId(userId);
    const product = await PartProduct.findOne({ _id: productId, supplierId });
    if (!product) throw createHttpError('Product not found', 404, 'NOT_FOUND');
    if (imageIndex < 0 || imageIndex >= product.images.length) {
      throw createHttpError('Image index out of range', 400, 'INVALID_INDEX');
    }

    product.images.splice(imageIndex, 1);
    // Ensure at least the first image is primary after removal
    if (product.images.length > 0 && !product.images.some((i: IProductImage) => i.isPrimary)) {
      product.images[0].isPrimary = true;
    }

    await product.save();
    return sanitizeProduct(product);
  }

  /** Get inventory history for a product */
  static async getInventoryHistory(userId: string, productId: string, page = 1, limit = 20): Promise<any> {
    const supplierId = await this.getSupplierProfileId(userId);
    const product = await PartProduct.findOne({ _id: productId, supplierId }).select('_id');
    if (!product) throw createHttpError('Product not found', 404, 'NOT_FOUND');

    const skip = (page - 1) * limit;
    const [logs, total] = await Promise.all([
      InventoryLog.find({ productId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      InventoryLog.countDocuments({ productId }),
    ]);

    return { logs, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }
}

// ---------------------------------------------------------------------------
// Admin Product Management
// ---------------------------------------------------------------------------
export class AdminPartProductService {

  /** List all products with filters */
  static async listProducts(options: {
    supplierId?: string;
    category?: string;
    status?: PartProductStatus | '';
    search?: string;
    brand?: string;
    page?: number;
    limit?: number;
  }): Promise<any> {
    const { supplierId, category, status, search, brand, page = 1, limit = 20 } = options;
    const skip = (page - 1) * limit;

    const filter: Record<string, any> = {};
    if (supplierId) filter.supplierId = new mongoose.Types.ObjectId(supplierId);
    if (category) filter.category = category;
    if (status) filter.status = status;
    if (brand) filter.brand = { $regex: brand, $options: 'i' };
    if (search) filter.$text = { $search: search };

    const [products, total] = await Promise.all([
      PartProduct.find(filter)
        .populate('supplierId', 'companyName businessType verificationStatus')
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PartProduct.countDocuments(filter),
    ]);

    return {
      products,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Get single product (admin view, includes adminNotes) */
  static async getProduct(productId: string): Promise<any> {
    const product = await PartProduct.findById(productId)
      .populate('supplierId', 'companyName businessType verificationStatus')
      .lean();
    if (!product) throw createHttpError('Product not found', 404, 'NOT_FOUND');
    return product;
  }

  /** Approve a pending_review product */
  static async approveProduct(productId: string, adminId: string, note?: string): Promise<any> {
    const product = await PartProduct.findById(productId);
    if (!product) throw createHttpError('Product not found', 404, 'NOT_FOUND');

    const allowed = ADMIN_ALLOWED_TRANSITIONS[product.status as PartProductStatus] ?? [];
    if (!allowed.includes('active')) {
      throw createHttpError(
        `Cannot approve product from status '${product.status}'`,
        400,
        'INVALID_STATE_TRANSITION'
      );
    }

    // Verify supplier is approved before allowing listing
    const supplier = await SupplierProfile.findById(product.supplierId).select('verificationStatus companyName');
    if (!supplier || supplier.verificationStatus !== 'approved') {
      throw createHttpError(
        'Cannot approve product: supplier account is not approved',
        400,
        'SUPPLIER_NOT_APPROVED'
      );
    }

    product.status = 'active';
    product.rejectionReason = undefined;
    product.statusHistory.push({
      status: 'active',
      by: adminId,
      at: new Date(),
      note: note || 'Product approved by admin',
    });

    await product.save();
    logger.info({ productId, adminId }, 'Admin approved product');
    return product.toObject();
  }

  /** Reject a product with reason */
  static async rejectProduct(productId: string, adminId: string, reason: string, notes?: string): Promise<any> {
    const product = await PartProduct.findById(productId);
    if (!product) throw createHttpError('Product not found', 404, 'NOT_FOUND');

    const allowed = ADMIN_ALLOWED_TRANSITIONS[product.status as PartProductStatus] ?? [];
    if (!allowed.includes('rejected')) {
      throw createHttpError(
        `Cannot reject product from status '${product.status}'`,
        400,
        'INVALID_STATE_TRANSITION'
      );
    }

    product.status = 'rejected';
    product.rejectionReason = reason;
    if (notes) product.adminNotes = notes;
    product.statusHistory.push({
      status: 'rejected',
      by: adminId,
      at: new Date(),
      note: reason,
    });

    await product.save();
    logger.info({ productId, adminId, reason }, 'Admin rejected product');
    return product.toObject();
  }

  /** Archive a product */
  static async archiveProduct(productId: string, adminId: string, reason?: string): Promise<any> {
    const product = await PartProduct.findById(productId);
    if (!product) throw createHttpError('Product not found', 404, 'NOT_FOUND');

    product.status = 'archived';
    product.statusHistory.push({
      status: 'archived',
      by: adminId,
      at: new Date(),
      note: reason || 'Archived by admin',
    });

    await product.save();
    logger.info({ productId, adminId }, 'Admin archived product');
    return product.toObject();
  }

  /** Get inventory history (admin view) */
  static async getInventoryHistory(productId: string, page = 1, limit = 20): Promise<any> {
    const product = await PartProduct.findById(productId).select('_id');
    if (!product) throw createHttpError('Product not found', 404, 'NOT_FOUND');

    const skip = (page - 1) * limit;
    const [logs, total] = await Promise.all([
      InventoryLog.find({ productId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      InventoryLog.countDocuments({ productId }),
    ]);
    return { logs, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }
}

// ---------------------------------------------------------------------------
// Public Marketplace Queries (active products from approved suppliers)
// ---------------------------------------------------------------------------
export class MarketplaceService {

  /** Browse active marketplace products */
  static async browse(options: {
    category?: string;
    brand?: string;
    search?: string;
    minPrice?: number;
    maxPrice?: number;
    inStockOnly?: boolean;
    condition?: 'new' | 'used' | 'refurbished';
    make?: string;
    model?: string;
    page?: number;
    limit?: number;
    sort?: 'price_asc' | 'price_desc' | 'newest';
  }): Promise<any> {
    const {
      category, brand, search, minPrice, maxPrice,
      inStockOnly, condition, make, model,
      page = 1, limit = 24, sort = 'newest',
    } = options;

    const skip = (page - 1) * limit;

    const filter: Record<string, any> = { status: 'active' };

    if (category) filter.category = category;
    if (brand) filter.brand = { $regex: `^${brand}$`, $options: 'i' };
    if (condition) filter.condition = condition;
    if (inStockOnly) filter.stockQuantity = { $gt: 0 };
    if (minPrice !== undefined || maxPrice !== undefined) {
      filter.priceCents = {};
      if (minPrice !== undefined) filter.priceCents.$gte = minPrice;
      if (maxPrice !== undefined) filter.priceCents.$lte = maxPrice;
    }
    if (search) filter.$text = { $search: search };
    if (make) filter['compatibility.make'] = { $regex: make, $options: 'i' };
    if (model) filter['compatibility.model'] = { $regex: model, $options: 'i' };

    let sortObj: Record<string, 1 | -1> = { createdAt: -1 };
    if (sort === 'price_asc') sortObj = { priceCents: 1 };
    else if (sort === 'price_desc') sortObj = { priceCents: -1 };

    // Only show products from approved suppliers
    const approvedSupplierIds = await SupplierProfile.find({ verificationStatus: 'approved' })
      .select('_id')
      .lean()
      .then((profiles) => profiles.map((p) => p._id));

    filter.supplierId = { $in: approvedSupplierIds };

    const [products, total] = await Promise.all([
      PartProduct.find(filter)
        .select('-adminNotes -statusHistory -rejectionReason')
        .populate('supplierId', 'companyName businessType supportEmail')
        .sort(sortObj)
        .skip(skip)
        .limit(limit)
        .lean(),
      PartProduct.countDocuments(filter),
    ]);

    return {
      products,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Get a single public product detail */
  static async getProduct(productId: string): Promise<any> {
    const approvedSupplierIds = await SupplierProfile.find({ verificationStatus: 'approved' })
      .select('_id')
      .lean()
      .then((profiles) => profiles.map((p) => p._id));

    const product = await PartProduct.findOne({
      _id: productId,
      status: 'active',
      supplierId: { $in: approvedSupplierIds },
    })
      .select('-adminNotes -statusHistory -rejectionReason')
      .populate('supplierId', 'companyName businessType supportEmail')
      .lean();

    if (!product) throw createHttpError('Product not found or not available', 404, 'NOT_FOUND');
    return product;
  }
}

// ---------------------------------------------------------------------------
// PartOrderService — Customer Checkout & Order Creation
// ---------------------------------------------------------------------------
export class PartOrderService {
  static async createOrder(
    customerId: string,
    payload: {
      items: Array<{ productId: string; quantity: number }>;
      shippingAddress: {
        fullName?: string;
        phone?: string;
        line1: string;
        line2?: string;
        city: string;
        state: string;
        zip: string;
        country?: string;
      };
      notes?: string;
    }
  ): Promise<IPartOrder> {
    const { items, shippingAddress, notes } = payload;

    if (!items || items.length === 0) {
      throw createHttpError('Order must contain at least one item', 400, 'EMPTY_ORDER');
    }

    // Step 1: Pre-validate all requested products, statuses, and supplier verification
    const productIds = items.map((i) => i.productId);
    const approvedSuppliers = await SupplierProfile.find({ verificationStatus: 'approved' })
      .select('_id')
      .lean();
    const approvedSupplierIds = approvedSuppliers.map((s) => s._id.toString());

    const products = await PartProduct.find({ _id: { $in: productIds } });
    const productMap = new Map<string, (typeof products)[0]>();
    for (const p of products) {
      productMap.set(p._id.toString(), p);
    }

    const orderItems: Array<{
      productId: mongoose.Types.ObjectId;
      supplierId: mongoose.Types.ObjectId;
      name: string;
      sku: string;
      brand: string;
      priceCents: number;
      quantity: number;
      totalCents: number;
      imageUrl?: string;
      condition?: string;
    }> = [];

    let subtotalCents = 0;

    for (const item of items) {
      const product = productMap.get(item.productId);
      if (!product) {
        throw createHttpError(`Product ${item.productId} not found`, 404, 'PRODUCT_NOT_FOUND');
      }
      if (product.status !== 'active') {
        throw createHttpError(
          `Product "${product.name}" (${product.sku}) is not active for purchase`,
          400,
          'PRODUCT_INACTIVE'
        );
      }
      if (!approvedSupplierIds.includes(product.supplierId.toString())) {
        throw createHttpError(
          `Supplier for "${product.name}" is not currently approved`,
          400,
          'SUPPLIER_NOT_APPROVED'
        );
      }
      if (product.stockQuantity < item.quantity) {
        throw createHttpError(
          `Insufficient stock for "${product.name}". Available: ${product.stockQuantity}, requested: ${item.quantity}`,
          400,
          'INSUFFICIENT_STOCK'
        );
      }

      const itemTotal = product.priceCents * item.quantity;
      subtotalCents += itemTotal;

      const primaryImg = product.images?.find((img: IProductImage) => img.isPrimary) || product.images?.[0];

      orderItems.push({
        productId: product._id as mongoose.Types.ObjectId,
        supplierId: product.supplierId,
        name: product.name,
        sku: product.sku,
        brand: product.brand,
        priceCents: product.priceCents,
        quantity: item.quantity,
        totalCents: itemTotal,
        imageUrl: primaryImg?.url,
        condition: product.condition,
      });
    }

    // Step 2: Atomic inventory deduction with rollback on collision
    const deductedProducts: Array<{ id: string; quantity: number }> = [];

    for (const item of items) {
      const updated = await PartProduct.findOneAndUpdate(
        {
          _id: item.productId,
          stockQuantity: { $gte: item.quantity },
          status: 'active',
        },
        { $inc: { stockQuantity: -item.quantity } },
        { new: true }
      );

      if (!updated) {
        // Rollback all previously deducted items in this order
        for (const rolled of deductedProducts) {
          await PartProduct.findByIdAndUpdate(rolled.id, { $inc: { stockQuantity: rolled.quantity } });
        }
        const failedProd = productMap.get(item.productId);
        throw createHttpError(
          `Stock was depleted for "${failedProd?.name || item.productId}" during checkout. Please review your cart.`,
          409,
          'STOCK_CONFLICT'
        );
      }

      deductedProducts.push({ id: item.productId, quantity: item.quantity });
    }

    // Step 3: Record inventory logs for each deduction
    for (const item of items) {
      const prod = productMap.get(item.productId);
      const prevQty = prod ? prod.stockQuantity : item.quantity;
      await InventoryLog.create({
        productId: item.productId,
        change: -item.quantity,
        previousQuantity: prevQty,
        newQuantity: prevQty - item.quantity,
        reason: 'manual_adjustment',
        actorId: customerId,
        actorRole: 'customer',
        notes: `Customer order checkout`,
      }).catch((err) => {
        logger.warn(`Failed to create inventory log for order checkout: ${err.message}`);
      });
    }

    // Step 4: Create order document
    // Order number generation: ORD-YYYYMMDD-XXXX
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randSuffix = Math.floor(1000 + Math.random() * 9000);
    const orderNumber = `ORD-${dateStr}-${randSuffix}`;

    const order = await PartOrder.create({
      orderNumber,
      customerId,
      items: orderItems,
      shippingAddress,
      subtotalCents,
      shippingCents: 0, // In this milestone shipping/tax is not invented
      taxCents: 0,
      totalCents: subtotalCents,
      currency: 'USD',
      status: 'pending',
      paymentStatus: 'unpaid',
      statusHistory: [
        {
          status: 'pending',
          by: customerId,
          at: new Date(),
          note: 'Order placed by customer',
        },
      ],
      notes,
    });

    return order;
  }

  static async getCustomerOrders(customerId: string): Promise<IPartOrder[]> {
    return PartOrder.find({ customerId })
      .sort({ createdAt: -1 })
      .lean() as unknown as IPartOrder[];
  }

  static async getCustomerOrderById(customerId: string, orderId: string): Promise<IPartOrder> {
    const order = await PartOrder.findOne({ _id: orderId, customerId }).lean();
    if (!order) {
      throw createHttpError('Order not found', 404, 'ORDER_NOT_FOUND');
    }
    return order as unknown as IPartOrder;
  }

  // ---------------------------------------------------------------------------
  // Supplier Order Management
  // ---------------------------------------------------------------------------
  static async getSupplierOrders(supplierUserId: string): Promise<IPartOrder[]> {
    const supplier = await SupplierProfile.findOne({ userId: supplierUserId }).select('_id companyName').lean();
    if (!supplier) {
      throw createHttpError('Supplier profile not found', 404, 'SUPPLIER_PROFILE_NOT_FOUND');
    }
    const orders = await PartOrder.find({ 'items.supplierId': supplier._id })
      .populate('customerId', 'fullName email phone')
      .sort({ createdAt: -1 })
      .lean();
    return orders as unknown as IPartOrder[];
  }

  static async getSupplierOrderById(supplierUserId: string, orderId: string): Promise<IPartOrder> {
    const supplier = await SupplierProfile.findOne({ userId: supplierUserId }).select('_id companyName').lean();
    if (!supplier) {
      throw createHttpError('Supplier profile not found', 404, 'SUPPLIER_PROFILE_NOT_FOUND');
    }
    const order = await PartOrder.findOne({ _id: orderId, 'items.supplierId': supplier._id })
      .populate('customerId', 'fullName email phone')
      .lean();
    if (!order) {
      throw createHttpError('Order not found', 404, 'ORDER_NOT_FOUND');
    }
    return order as unknown as IPartOrder;
  }

  static async updateSupplierOrderStatus(
    supplierUserId: string,
    orderId: string,
    status: PartOrderStatus,
    note?: string
  ): Promise<any> {
    const supplier = await SupplierProfile.findOne({ userId: supplierUserId }).select('_id companyName').lean();
    if (!supplier) {
      throw createHttpError('Supplier profile not found', 404, 'SUPPLIER_PROFILE_NOT_FOUND');
    }
    const order = await PartOrder.findOne({ _id: orderId, 'items.supplierId': supplier._id });
    if (!order) {
      throw createHttpError('Order not found', 404, 'ORDER_NOT_FOUND');
    }
    order.status = status;
    order.statusHistory.push({
      status,
      by: supplier.companyName || supplierUserId,
      at: new Date(),
      note: note || `Status updated to ${status} by supplier`,
    });
    await order.save();
    return order.toObject();
  }

  // ---------------------------------------------------------------------------
  // Admin Order Management
  // ---------------------------------------------------------------------------
  static async getAdminOrders(options?: {
    status?: string;
    paymentStatus?: string;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{ orders: any[]; meta: { total: number; page: number; limit: number; totalPages: number } }> {
    const { status, paymentStatus, search, page = 1, limit = 50 } = options || {};
    const filter: Record<string, any> = {};
    if (status) filter.status = status;
    if (paymentStatus) filter.paymentStatus = paymentStatus;
    if (search) {
      filter.$or = [
        { orderNumber: { $regex: search, $options: 'i' } },
        { 'shippingAddress.fullName': { $regex: search, $options: 'i' } },
        { 'shippingAddress.city': { $regex: search, $options: 'i' } },
        { 'items.name': { $regex: search, $options: 'i' } },
        { 'items.sku': { $regex: search, $options: 'i' } },
      ];
    }
    const skip = (page - 1) * limit;
    const [orders, total] = await Promise.all([
      PartOrder.find(filter)
        .populate('customerId', 'fullName email phone')
        .populate('items.supplierId', 'companyName businessPhone supportEmail')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PartOrder.countDocuments(filter),
    ]);
    return {
      orders,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  static async getAdminOrderById(orderId: string): Promise<any> {
    const order = await PartOrder.findById(orderId)
      .populate('customerId', 'fullName email phone')
      .populate('items.supplierId', 'companyName businessPhone supportEmail businessAddress')
      .lean();
    if (!order) {
      throw createHttpError('Order not found', 404, 'ORDER_NOT_FOUND');
    }
    return order;
  }

  static async updateAdminOrderStatus(
    adminUserId: string,
    orderId: string,
    status: PartOrderStatus,
    note?: string
  ): Promise<any> {
    const order = await PartOrder.findById(orderId);
    if (!order) {
      throw createHttpError('Order not found', 404, 'ORDER_NOT_FOUND');
    }
    order.status = status;
    order.statusHistory.push({
      status,
      by: 'admin',
      at: new Date(),
      note: note || `Status updated to ${status} by admin`,
    });
    await order.save();
    return order.toObject();
  }
}
