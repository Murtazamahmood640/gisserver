import mongoose, { Schema } from 'mongoose';

export interface ICounter {
  _id: string;
  seq: number;
}

const CounterSchema = new Schema<ICounter>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { _id: false, timestamps: true }
);

export const Counter =
  mongoose.models.Counter ||
  mongoose.model<ICounter>('Counter', CounterSchema, 'counters');

export async function getNextSequenceValue(sequenceName: string): Promise<number> {
  const result = await Counter.findByIdAndUpdate(
    sequenceName,
    { $inc: { seq: 1 } },
    { returnDocument: 'after', upsert: true }
  );
  return result.seq;
}
