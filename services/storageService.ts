import { v2 as cloudinary } from 'cloudinary';

// Configure Cloudinary once at module load using process.env.CLOUDINARY_*
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
];
export const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

// Magic byte signatures
const MAGIC_BYTES: Record<string, number[][]> = {
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/png': [[0x89, 0x50, 0x4e, 0x47]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]], // RIFF at offset 0, and WEBP checked at offset 8
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]], // %PDF
};

export async function validateFileBuffer(buffer: Buffer, mimeType: string): Promise<void> {
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    throw new Error('File type not allowed');
  }
  if (buffer.length > MAX_SIZE_BYTES) {
    throw new Error('File too large (max 5 MB)');
  }

  // Check magic bytes
  const sigs = MAGIC_BYTES[mimeType];
  if (sigs) {
    const matches = sigs.some((sig) => sig.every((byte, i) => buffer[i] === byte));
    if (!matches) {
      throw new Error('File content does not match declared type');
    }
    // Additional check for webp: WEBP header at offset 8
    if (mimeType === 'image/webp') {
      const webpSig = [0x57, 0x45, 0x42, 0x50];
      const webpMatches = webpSig.every((byte, i) => buffer[8 + i] === byte);
      if (!webpMatches) {
        throw new Error('File content does not match declared type');
      }
    }
  }
}

export async function uploadDocument(
  buffer: Buffer,
  mimeType: string,
  userId: string
): Promise<{ publicId: string; resourceType: string }> {
  // Upload as 'authenticated' to prevent public access
  // Returns publicId; NEVER log it
  const resourceType = mimeType === 'application/pdf' ? 'raw' : 'image';
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        type: 'authenticated',
        folder: `technicians/${userId}/documents`,
        resource_type: resourceType,
        access_mode: 'authenticated',
      },
      (err, result) => {
        if (err || !result) {
          return reject(err || new Error('Upload failed'));
        }
        resolve({ publicId: result.public_id, resourceType: result.resource_type });
      }
    );
    uploadStream.end(buffer);
  });
}

export async function deleteDocument(publicId: string, resourceType: string): Promise<void> {
  await cloudinary.uploader.destroy(publicId, {
    type: 'authenticated',
    resource_type: resourceType as any,
  });
}

export function generateSignedUrl(publicId: string, resourceType: string): string {
  // Expires in 5 minutes (300 seconds)
  return cloudinary.utils.private_download_url(publicId, '', {
    resource_type: resourceType,
    expires_at: Math.floor(Date.now() / 1000) + 300,
    attachment: false,
  });
}
