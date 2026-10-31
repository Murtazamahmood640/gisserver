import mongoose, { Document, Schema } from 'mongoose';

export type InventoryAdjustmentReason =
  | 'initial_stock'
  | 'restock'
  | 'manual_adjustment'
  | 'damaged'
  | 'audit'
  | 'correction';

export interface IInventoryLog extends Document {
  productId: mongoose.Types.ObjectId;
  supplierId: mongoose.Types.ObjectId;
  change: number;
  previousQuantity: number;
  newQuantity: number;
  reason: InventoryAdjustmentReason;
  actorId: string;
  actorRole: string;
  notes?: string;
  createdAt: Date;
}

const InventoryLogSchema = new Schema<IInventoryLog>(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'PartProduct',
      required: true,
      index: true,
    },
    supplierId: {
      type: Schema.Types.ObjectId,
      ref: 'SupplierProfile',
      required: true,
      index: true,
    },
    change: {
      type: Number,
      required: true,
    },
    previousQuantity: {
      type: Number,
      required: true,
      min: 0,
    },
    newQuantity: {
      type: Number,
      required: true,
      min: 0,
    },
    reason: {
      type: String,
      enum: ['initial_stock', 'restock', 'manual_adjustment', 'damaged', 'audit', 'correction'],
      required: true,
    },
    actorId: {
      type: String,
      required: true,
    },
    actorRole: {
      type: String,
      required: true,
    },
    notes: {
      type: String,
      trim: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

InventoryLogSchema.index({ productId: 1, createdAt: -1 });
InventoryLogSchema.index({ supplierId: 1, createdAt: -1 });

export const InventoryLog =
  mongoose.models.InventoryLog ||
  mongoose.model<IInventoryLog>('InventoryLog', InventoryLogSchema, 'inventoryLogs');
