import logger from '../config/logger';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { connectDB } from '../config/database';
import { Blog } from '../models/Blog';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  await connectDB();

  try {
    if (req.method === 'GET') {
      const { slug } = req.query;
      
      if (slug) {
        const blog = await Blog.findOne({ slug, published: true });
        if (!blog) {
          return res.status(404).json({
            success: false,
            message: 'Blog not found',
          });
        }
        return res.status(200).json({
          success: true,
          data: blog,
        });
      }

      const { all } = req.query;
      const query = all === 'true' ? {} : { published: true };
      const blogs = await Blog.find(query).sort({ createdAt: -1 });
      return res.status(200).json({
        success: true,
        data: blogs,
      });
    } else if (req.method === 'POST') {
      const blogData = req.body;

      if (!blogData.title || !blogData.content || !blogData.image) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields',
        });
      }

      // Auto-generate slug if not provided
      if (!blogData.slug) {
        blogData.slug = blogData.title
          .toLowerCase()
          .replace(/[^\w ]+/g, '')
          .replace(/ +/g, '-');
      }

      const blog = new Blog(blogData);
      await blog.save();

      return res.status(201).json({
        success: true,
        message: 'Blog created successfully',
        data: blog,
      });
    } else if (req.method === 'PUT') {
      const { id } = req.query;

      if (!id || typeof id !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'Invalid blog ID',
        });
      }

      const blog = await Blog.findByIdAndUpdate(
        id,
        req.body,
        { returnDocument: 'after', runValidators: true }
      );

      if (!blog) {
        return res.status(404).json({
          success: false,
          message: 'Blog not found',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Blog updated successfully',
        data: blog,
      });
    } else if (req.method === 'DELETE') {
      const { id } = req.query;

      if (!id || typeof id !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'Invalid blog ID',
        });
      }

      const blog = await Blog.findByIdAndDelete(id);

      if (!blog) {
        return res.status(404).json({
          success: false,
          message: 'Blog not found',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Blog deleted successfully',
      });
    } else {
      return res.status(405).json({
        success: false,
        message: 'Method not allowed',
      });
    }
  } catch (error) {
    logger.error({ err: error }, 'Blogs handler error');
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
