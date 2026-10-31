import logger from '../config/logger';
import type { Request, Response } from 'express';
import { uploadToCloudinary } from '../utils/cloudinary';

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

function isValidImageType(buffer: Buffer, mimeType?: string): boolean {
  if (mimeType) {
    const normalized = mimeType.toLowerCase();
    return (
      normalized === 'image/jpeg' ||
      normalized === 'image/jpg' ||
      normalized === 'image/png' ||
      normalized === 'image/webp'
    );
  }

  // Magic bytes check
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true; // JPEG
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return true; // PNG
  }

  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return true; // WebP
  }

  return false;
}

export default async function handler(req: Request, res: Response): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({
      success: false,
      message: 'Method not allowed',
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' },
    });
    return;
  }

  try {
    const { image, folder } = req.body;

    if (!image || typeof image !== 'string') {
      res.status(400).json({
        success: false,
        message: 'No image data provided',
        error: { code: 'VALIDATION_ERROR', message: 'Image base64 string is required' },
      });
      return;
    }

    let base64Data = image;
    let declaredMime: string | undefined;

    const dataUriMatch = image.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-+.]+);base64,(.+)$/);
    if (dataUriMatch) {
      declaredMime = dataUriMatch[1];
      base64Data = dataUriMatch[2];
    }

    const buffer = Buffer.from(base64Data, 'base64');

    if (buffer.length === 0) {
      res.status(400).json({
        success: false,
        message: 'Invalid base64 image data',
        error: { code: 'INVALID_BASE64', message: 'Unable to decode base64 image data' },
      });
      return;
    }

    if (buffer.length > MAX_SIZE_BYTES) {
      res.status(400).json({
        success: false,
        message: 'Image size exceeds maximum limit of 5 MB',
        error: { code: 'FILE_TOO_LARGE', message: 'Image size exceeds maximum limit of 5 MB' },
      });
      return;
    }

    if (!isValidImageType(buffer, declaredMime)) {
      res.status(400).json({
        success: false,
        message: 'Only JPEG, PNG, and WebP images are allowed',
        error: {
          code: 'INVALID_FILE_TYPE',
          message: 'Only JPEG, PNG, and WebP images are allowed',
        },
      });
      return;
    }

    const imageUrl = await uploadToCloudinary(image, folder || 'blogs');

    res.status(200).json({
      success: true,
      message: 'Image uploaded successfully',
      url: imageUrl,
      data: { url: imageUrl },
    });
  } catch (error) {
    logger.error({ err: error }, 'Upload handler error');
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: error instanceof Error ? error.message : 'Unknown upload error',
      },
    });
  }
}
