import mongoose from 'mongoose';

export interface IBlog extends mongoose.Document {
  title: string;
  slug: string;
  content: string;
  excerpt: string;
  image: string;
  category: string;
  author: string;
  published: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const blogSchema = new mongoose.Schema<IBlog>(
  {
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
    },
    slug: {
      type: String,
      required: [true, 'Slug is required'],
      unique: true,
      lowercase: true,
    },
    content: {
      type: String,
      required: [true, 'Content is required'],
    },
    excerpt: {
      type: String,
      required: [true, 'Excerpt is required'],
    },
    image: {
      type: String,
      required: [true, 'Image URL is required'],
    },
    category: {
      type: String,
      required: [true, 'Category is required'],
      default: 'Detailing',
    },
    author: {
      type: String,
      required: [true, 'Author is required'],
      default: 'Admin',
    },
    published: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

export const Blog =
  mongoose.models.Blog || mongoose.model<IBlog>('Blog', blogSchema);
