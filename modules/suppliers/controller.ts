import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { SupplierService } from './service';
import { SupplierDocumentType } from '../../models/SupplierProfile';
import { getErrorDetails } from '../../utils/httpErrors';

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10 }, // 5 MB, max 1 file, max 10 fields
}).single('document');

export function supplierDocumentUploadMiddleware(req: Request, res: Response, next: NextFunction) {
  memoryUpload(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          message: 'File too large (max 5 MB)',
          error: { code: 'FILE_TOO_LARGE', message: 'File too large (max 5 MB)' },
        });
      }
      const message = err instanceof Error ? err.message : 'File upload error';
      return res.status(400).json({
        success: false,
        message,
        error: { code: 'UPLOAD_ERROR', message },
      });
    }
    next();
  });
}

export class SupplierController {
  static async register(req: Request, res: Response) {
    try {
      const result = await SupplierService.registerSupplier(req.body);
      return res.status(201).json({
        success: true,
        message: 'Supplier registered successfully. Please verify your email.',
        data: result,
      });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({
        success: false,
        message,
        error: { code, message },
      });
    }
  }

  static async apply(req: Request, res: Response) {
    try {
      const profile = await SupplierService.applyForSupplier(req.user!.userId, req.body);
      return res.status(200).json({
        success: true,
        message: 'Supplier application created successfully',
        data: profile,
      });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({
        success: false,
        message,
        error: { code, message },
      });
    }
  }

  static async getMe(req: Request, res: Response) {
    try {
      const data = await SupplierService.getMe(req.user!.userId);
      return res.status(200).json({
        success: true,
        data,
      });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({
        success: false,
        message,
        error: { code, message },
      });
    }
  }

  static async updateMe(req: Request, res: Response) {
    try {
      const profile = await SupplierService.updateMe(req.user!.userId, req.body);
      return res.status(200).json({
        success: true,
        message: 'Supplier profile updated successfully',
        data: profile,
      });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({
        success: false,
        message,
        error: { code, message },
      });
    }
  }

  static async submit(req: Request, res: Response) {
    try {
      const profile = await SupplierService.submitApplication(req.user!.userId);
      return res.status(200).json({
        success: true,
        message: 'Supplier application submitted for administrative review',
        data: profile,
      });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({
        success: false,
        message,
        error: { code, message },
      });
    }
  }

  static async uploadDocument(req: Request, res: Response) {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'No document file provided',
          error: { code: 'FILE_REQUIRED', message: 'No document file provided' },
        });
      }

      const type = (req.body.type || 'business_license') as SupplierDocumentType;
      const fileName = req.file.originalname || req.body.fileName;
      const expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : undefined;

      const doc = await SupplierService.uploadDocument(
        req.user!.userId,
        req.file.buffer,
        req.file.mimetype,
        type,
        fileName,
        expiresAt
      );

      return res.status(201).json({
        success: true,
        message: 'Document uploaded successfully',
        data: doc,
      });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({
        success: false,
        message,
        error: { code, message },
      });
    }
  }

  static async deleteDocument(req: Request, res: Response) {
    try {
      await SupplierService.deleteDocument(req.user!.userId, req.params.docId);
      return res.status(200).json({
        success: true,
        message: 'Document deleted successfully',
      });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({
        success: false,
        message,
        error: { code, message },
      });
    }
  }

  static async getDocumentSignedUrl(req: Request, res: Response) {
    try {
      const url = await SupplierService.getDocumentSignedUrl(req.user!.userId, req.params.docId);
      return res.status(200).json({
        success: true,
        data: { url },
      });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({
        success: false,
        message,
        error: { code, message },
      });
    }
  }

  // =========================================================================
  // Admin Endpoints
  // =========================================================================

  static async listSuppliers(req: Request, res: Response) {
    try {
      const result = await SupplierService.listSuppliers({
        status: req.query.status as string,
        search: req.query.search as string,
        page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 20,
      });

      return res.status(200).json({
        success: true,
        data: result.suppliers,
        meta: {
          total: result.total,
          page: result.page,
          limit: result.limit,
          totalPages: result.totalPages,
        },
      });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({
        success: false,
        message,
        error: { code, message },
      });
    }
  }

  static async getSupplier(req: Request, res: Response) {
    try {
      const profile = await SupplierService.getSupplierById(req.params.id);
      return res.status(200).json({
        success: true,
        data: profile,
      });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({
        success: false,
        message,
        error: { code, message },
      });
    }
  }

  static async approve(req: Request, res: Response) {
    try {
      const profile = await SupplierService.approveSupplier(req.params.id, req.user!.userId);
      return res.status(200).json({
        success: true,
        message: 'Supplier approved successfully',
        data: profile,
      });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({
        success: false,
        message,
        error: { code, message },
      });
    }
  }

  static async reject(req: Request, res: Response) {
    try {
      const profile = await SupplierService.rejectSupplier(
        req.params.id,
        req.user!.userId,
        req.body.reason
      );
      return res.status(200).json({
        success: true,
        message: 'Supplier rejected successfully',
        data: profile,
      });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({
        success: false,
        message,
        error: { code, message },
      });
    }
  }

  static async suspend(req: Request, res: Response) {
    try {
      const profile = await SupplierService.suspendSupplier(
        req.params.id,
        req.user!.userId,
        req.body.reason
      );
      return res.status(200).json({
        success: true,
        message: 'Supplier suspended successfully',
        data: profile,
      });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({
        success: false,
        message,
        error: { code, message },
      });
    }
  }

  static async reinstate(req: Request, res: Response) {
    try {
      const profile = await SupplierService.reinstateSupplier(req.params.id, req.user!.userId);
      return res.status(200).json({
        success: true,
        message: 'Supplier reinstated successfully',
        data: profile,
      });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({
        success: false,
        message,
        error: { code, message },
      });
    }
  }

  static async approveDocument(req: Request, res: Response) {
    try {
      const profile = await SupplierService.reviewDocument(
        req.params.id,
        req.params.docId,
        req.user!.userId,
        'approved',
        req.body.note
      );
      return res.status(200).json({
        success: true,
        message: 'Document approved',
        data: profile,
      });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({
        success: false,
        message,
        error: { code, message },
      });
    }
  }

  static async rejectDocument(req: Request, res: Response) {
    try {
      const profile = await SupplierService.reviewDocument(
        req.params.id,
        req.params.docId,
        req.user!.userId,
        'rejected',
        req.body.note
      );
      return res.status(200).json({
        success: true,
        message: 'Document rejected',
        data: profile,
      });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({
        success: false,
        message,
        error: { code, message },
      });
    }
  }

  static async getAdminDocumentUrl(req: Request, res: Response) {
    try {
      const url = await SupplierService.getAdminDocumentUrl(
        req.params.id,
        req.params.docId,
        req.user!.userId
      );
      return res.status(200).json({
        success: true,
        data: { url },
      });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({
        success: false,
        message,
        error: { code, message },
      });
    }
  }
}
