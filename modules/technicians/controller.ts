import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { TechnicianService } from './service';
import { DocumentType } from '../../models/TechnicianProfile';

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10 }, // 5 MB, max 1 file, max 10 fields
}).single('document');

export function documentUploadMiddleware(req: Request, res: Response, next: NextFunction) {
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

export class TechnicianController {
  static async register(req: Request, res: Response) {
    const result = await TechnicianService.registerTechnician(req.body);
    return res.status(201).json({
      success: true,
      message: 'Technician registered successfully. Please verify your email.',
      data: result,
    });
  }

  static async apply(req: Request, res: Response) {
    const profile = await TechnicianService.applyForTechnician(req.user!.userId);
    return res.status(200).json({
      success: true,
      message: 'Technician application created',
      data: profile,
    });
  }

  static async getMe(req: Request, res: Response) {
    const data = await TechnicianService.getMe(req.user!.userId);
    return res.status(200).json({
      success: true,
      data,
    });
  }

  static async updateMe(req: Request, res: Response) {
    const profile = await TechnicianService.updateMe(req.user!.userId, req.body);
    return res.status(200).json({
      success: true,
      data: profile,
    });
  }

  static async updateSkills(req: Request, res: Response) {
    const profile = await TechnicianService.updateSkills(req.user!.userId, req.body);
    return res.status(200).json({
      success: true,
      data: profile,
    });
  }

  static async updateServiceArea(req: Request, res: Response) {
    const profile = await TechnicianService.updateServiceArea(req.user!.userId, req.body);
    return res.status(200).json({
      success: true,
      data: profile,
    });
  }

  static async updateAvailability(req: Request, res: Response) {
    const profile = await TechnicianService.updateAvailability(req.user!.userId, req.body);
    return res.status(200).json({
      success: true,
      data: profile,
    });
  }

  static async setOnline(req: Request, res: Response) {
    const isOnline = req.body?.isOnline !== undefined ? Boolean(req.body.isOnline) : true;
    const result = await TechnicianService.setOnline(req.user!.userId, isOnline);
    return res.status(200).json({
      success: true,
      data: result,
    });
  }

  static async submit(req: Request, res: Response) {
    const profile = await TechnicianService.submitApplication(req.user!.userId);
    return res.status(200).json({
      success: true,
      message: 'Application submitted for review',
      data: profile,
    });
  }

  static async uploadDocument(req: Request, res: Response) {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No document file provided',
        error: { code: 'FILE_REQUIRED', message: 'No document file provided' },
      });
    }

    const type = (req.body.type || 'id') as DocumentType;
    const expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : undefined;

    const doc = await TechnicianService.uploadDocument(
      req.user!.userId,
      req.file.buffer,
      req.file.mimetype,
      type,
      expiresAt
    );

    return res.status(201).json({
      success: true,
      message: 'Document uploaded successfully',
      data: doc,
    });
  }

  static async deleteDocument(req: Request, res: Response) {
    const { docId } = req.params;
    const result = await TechnicianService.deleteDocument(req.user!.userId, docId);
    return res.status(200).json(result);
  }

  static async getMyDocumentUrl(req: Request, res: Response) {
    const { docId } = req.params;
    const result = await TechnicianService.getSignedDocumentUrl(docId, req.user!);
    return res.status(200).json({
      success: true,
      data: result,
    });
  }

  // Admin & Dispatcher Endpoints
  static async listTechnicians(req: Request, res: Response) {
    const result = await TechnicianService.listTechnicians({
      status: req.query.status as string,
      category: req.query.category as string,
      zip: req.query.zip as string,
      search: req.query.search as string,
      page: req.query.page ? Number(req.query.page) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    return res.status(200).json({
      success: true,
      data: result.technicians,
      meta: result.pagination,
    });
  }

  static async getTechnician(req: Request, res: Response) {
    const { id } = req.params;
    const data = await TechnicianService.getTechnician(id);
    return res.status(200).json({
      success: true,
      data,
    });
  }

  static async getAdminDocumentUrl(req: Request, res: Response) {
    const { id, docId } = req.params;
    const result = await TechnicianService.getSignedDocumentUrl(docId, req.user!, id);
    return res.status(200).json({
      success: true,
      data: result,
    });
  }

  static async approve(req: Request, res: Response) {
    const { id } = req.params;
    const profile = await TechnicianService.approveApplication(id, req.user!.userId);
    return res.status(200).json({
      success: true,
      message: 'Technician application approved',
      data: profile,
    });
  }

  static async reject(req: Request, res: Response) {
    const { id } = req.params;
    const { reason } = req.body;
    const profile = await TechnicianService.rejectApplication(id, req.user!.userId, reason);
    return res.status(200).json({
      success: true,
      message: 'Technician application rejected',
      data: profile,
    });
  }

  static async suspend(req: Request, res: Response) {
    const { id } = req.params;
    const { reason } = req.body;
    const profile = await TechnicianService.suspendTechnician(id, req.user!.userId, reason);
    return res.status(200).json({
      success: true,
      message: 'Technician suspended',
      data: profile,
    });
  }

  static async reinstate(req: Request, res: Response) {
    const { id } = req.params;
    const profile = await TechnicianService.reinstateTechnician(id, req.user!.userId);
    return res.status(200).json({
      success: true,
      message: 'Technician reinstated',
      data: profile,
    });
  }

  static async adminPatch(req: Request, res: Response) {
    const { id } = req.params;
    const profile = await TechnicianService.adminPatch(id, req.user!.userId, req.body);
    return res.status(200).json({
      success: true,
      message: 'Technician updated successfully',
      data: profile,
    });
  }

  static async approveDocument(req: Request, res: Response) {
    const { id, docId } = req.params;
    const { note } = req.body;
    const doc = await TechnicianService.approveDocument(id, docId, req.user!.userId, note);
    return res.status(200).json({
      success: true,
      message: 'Document approved',
      data: doc,
    });
  }

  static async rejectDocument(req: Request, res: Response) {
    const { id, docId } = req.params;
    const { note } = req.body;
    const doc = await TechnicianService.rejectDocument(id, docId, req.user!.userId, note);
    return res.status(200).json({
      success: true,
      message: 'Document rejected',
      data: doc,
    });
  }

  static async getTechnicianJobs(req: Request, res: Response) {
    const { id } = req.params;
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const result = await TechnicianService.getTechnicianJobs(id, page, limit);
    return res.status(200).json({
      success: true,
      data: result.jobs,
      meta: result.pagination,
    });
  }

  // Customer Admin methods
  static async listCustomers(req: Request, res: Response) {
    const result = await TechnicianService.listCustomers({
      search: req.query.search as string,
      status: req.query.status as string,
      page: req.query.page ? Number(req.query.page) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    return res.status(200).json({
      success: true,
      data: result.customers,
      meta: result.pagination,
    });
  }

  static async suspendCustomer(req: Request, res: Response) {
    const { id } = req.params;
    const { reason } = req.body || {};
    const result = await TechnicianService.suspendCustomer(id, req.user!.userId, reason);
    return res.status(200).json(result);
  }

  static async reinstateCustomer(req: Request, res: Response) {
    const { id } = req.params;
    const result = await TechnicianService.reinstateCustomer(id, req.user!.userId);
    return res.status(200).json(result);
  }

  // Cron Check
  static async runExpiryCheck(_req: Request, res: Response) {
    const result = await TechnicianService.runDocumentExpiryCheck();
    return res.status(200).json({
      success: true,
      message: 'Document expiry check completed',
      data: result,
    });
  }
}
