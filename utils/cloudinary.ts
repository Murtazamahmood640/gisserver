import logger from '../config/logger';
import { v2 as cloudinary } from 'cloudinary';

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
export const uploadToCloudinary = async (file: string, folder: string = 'blogs') => {
  try {
    const result = await cloudinary.uploader.upload(file, {
      folder,
      resource_type: 'auto',
    });
    return result.secure_url;
  } catch (error) {
    logger.error({ err: error }, 'Cloudinary upload error');
    throw error;
  }
};

export default cloudinary;
