import mongoose, { Document, Schema } from 'mongoose';

export interface ISlotReservation extends Document {
  date: string; // "YYYY-MM-DD"
  slot: string; // "HH:mm" (24h format)
  categoryId: mongoose.Types.ObjectId;
  count: number;
  createdAt: Date;
  updatedAt: Date;
}

const SlotReservationSchema = new Schema<ISlotReservation>(
  {
    date: { type: String, required: true, index: true },
    slot: { type: String, required: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'ServiceCategory', required: true, index: true },
    count: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

SlotReservationSchema.index({ date: 1, slot: 1, categoryId: 1 }, { unique: true });

export const SlotReservation =
  mongoose.models.SlotReservation ||
  mongoose.model<ISlotReservation>('SlotReservation', SlotReservationSchema, 'slotReservations');
