import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from backend/.env
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Dev only — refuses to run in production
if (process.env.NODE_ENV === 'production') {
  console.error('[checkStorage] Refusing to run in production mode.');
  process.exit(1);
}

import { uploadDocument, generateSignedUrl, deleteDocument } from '../services/storageService';

// 1x1 transparent PNG buffer
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// Minimal valid PDF buffer (%PDF-1.4 ...)
const TINY_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 3 3]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000102 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n160\n%%EOF',
  'utf8'
);

async function checkUrlAccessibility(url: string): Promise<number> {
  try {
    const res = await fetch(url, { method: 'GET' });
    return res.status;
  } catch {
    return 0;
  }
}

async function runStorageCheck() {
  console.log('=== Cloudinary Authenticated Storage Verification ===\n');
  const dummyUserId = 'test_storage_check_' + Date.now();
  let allPassed = true;

  // 1. Upload 1x1 PNG as authenticated asset
  let pngPublicId = '';
  let pngResourceType = 'image';
  try {
    const res = await uploadDocument(TINY_PNG, 'image/png', dummyUserId);
    pngPublicId = res.publicId;
    pngResourceType = res.resourceType;
    console.log('[PASS] Step 1a: Upload 1x1 PNG as authenticated asset succeeded.');
  } catch (err: any) {
    console.error('[FAIL] Step 1a: Upload 1x1 PNG failed:', err.message);
    allPassed = false;
  }

  // 2. Upload tiny PDF as authenticated asset
  let pdfPublicId = '';
  let pdfResourceType = 'raw';
  try {
    const res = await uploadDocument(TINY_PDF, 'application/pdf', dummyUserId);
    pdfPublicId = res.publicId;
    pdfResourceType = res.resourceType;
    console.log('[PASS] Step 1b: Upload tiny PDF as authenticated asset succeeded.');
  } catch (err: any) {
    console.error('[FAIL] Step 1b: Upload tiny PDF failed:', err.message);
    allPassed = false;
  }

  // 3. Verify unsigned URL is NOT accessible for PNG
  if (pngPublicId) {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const unsignedPngUrl = `https://res.cloudinary.com/${cloudName}/image/upload/${pngPublicId}.png`;
    const status = await checkUrlAccessibility(unsignedPngUrl);
    // Authenticated assets on Cloudinary return 401 or 404 when requested without a signature
    if (status === 401 || status === 404 || status === 403) {
      console.log(`[PASS] Step 2a: Unsigned PNG URL is correctly forbidden/inaccessible (HTTP ${status}).`);
    } else {
      console.error(`[FAIL] Step 2a: Unsigned PNG URL unexpectedly returned HTTP ${status}. Expected 401/403/404.`);
      allPassed = false;
    }
  }

  // 4. Verify signed URL IS accessible for PNG
  if (pngPublicId) {
    const signedPngUrl = generateSignedUrl(pngPublicId, pngResourceType);
    const status = await checkUrlAccessibility(signedPngUrl);
    if (status >= 200 && status < 300) {
      console.log(`[PASS] Step 2b: 5-minute signed PNG URL is accessible (HTTP ${status}).`);
    } else {
      console.error(`[FAIL] Step 2b: Signed PNG URL failed with HTTP ${status}.`);
      allPassed = false;
    }
  }

  // 5. Verify unsigned URL is NOT accessible for PDF
  if (pdfPublicId) {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const unsignedPdfUrl = `https://res.cloudinary.com/${cloudName}/raw/upload/${pdfPublicId}`;
    const status = await checkUrlAccessibility(unsignedPdfUrl);
    if (status === 401 || status === 404 || status === 403) {
      console.log(`[PASS] Step 3a: Unsigned PDF URL is correctly forbidden/inaccessible (HTTP ${status}).`);
    } else {
      console.error(`[FAIL] Step 3a: Unsigned PDF URL unexpectedly returned HTTP ${status}. Expected 401/403/404.`);
      allPassed = false;
    }
  }

  // 6. Verify signed URL IS accessible for PDF
  if (pdfPublicId) {
    const signedPdfUrl = generateSignedUrl(pdfPublicId, pdfResourceType);
    const status = await checkUrlAccessibility(signedPdfUrl);
    if (status >= 200 && status < 300) {
      console.log(`[PASS] Step 3b: 5-minute signed PDF URL is accessible (HTTP ${status}).`);
    } else {
      console.error(`[FAIL] Step 3b: Signed PDF URL failed with HTTP ${status}.`);
      allPassed = false;
    }
  }

  // 7. Cleanup: Delete both assets
  if (pngPublicId) {
    try {
      await deleteDocument(pngPublicId, pngResourceType);
      console.log('[PASS] Step 4a: Deleted PNG test asset.');
    } catch (err: any) {
      console.error('[FAIL] Step 4a: Failed to delete PNG asset:', err.message);
      allPassed = false;
    }
  }

  if (pdfPublicId) {
    try {
      await deleteDocument(pdfPublicId, pdfResourceType);
      console.log('[PASS] Step 4b: Deleted PDF test asset.');
    } catch (err: any) {
      console.error('[FAIL] Step 4b: Failed to delete PDF asset:', err.message);
      allPassed = false;
    }
  }

  console.log('\n=== Storage Verification Summary ===');
  if (allPassed) {
    console.log('Result: ALL STORAGE SECURITY CHECKS PASSED.\n');
    process.exit(0);
  } else {
    console.error('Result: ONE OR MORE STORAGE CHECKS FAILED.\n');
    process.exit(1);
  }
}

runStorageCheck();
