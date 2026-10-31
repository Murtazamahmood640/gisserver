import express, { Router } from 'express';
import { PaymentController } from './controller';

export const webhookRouter = Router();

webhookRouter.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  PaymentController.handleWebhook
);
