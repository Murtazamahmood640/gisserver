import express from 'express';
import cors from 'cors';
import { corsOptions } from './config/cors.ts';
import { connectDB } from './config/database.ts';

// Import route handlers
import authHandler from './handlers/auth.ts';
import appointmentsHandler from './handlers/appointments.ts';
import contactHandler from './handlers/contact.ts';
import couponsHandler from './handlers/coupons.ts';
import usersHandler from './handlers/users.ts';
import feedbackHandler from './handlers/feedback.ts'
const app = express();

// Middleware
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Routes
app.post('/api/auth/login', async (req, res) => {
  await authHandler(
    { ...req, query: { action: 'login' } } as any,
    res
  );
});

app.post('/api/auth/register', async (req, res) => {
  await authHandler(
    { ...req, query: { action: 'register' } } as any,
    res
  );
});

app.get('/api/appointments', async (req, res) => {
  await appointmentsHandler(req as any, res);
});

app.post('/api/appointments', async (req, res) => {
  await appointmentsHandler(req as any, res);
});

app.put('/api/appointments/:id', async (req, res) => {
  await appointmentsHandler(
    { ...req, query: { id: req.params.id } } as any,
    res
  );
});

app.delete('/api/appointments/:id', async (req, res) => {
  await appointmentsHandler(
    { ...req, query: { id: req.params.id } } as any,
    res
  );
});


// Users routes
app.get('/api/users', async (req, res) => {
  await usersHandler(req as any, res);
});

app.post('/api/users', async (req, res) => {
  await usersHandler(req as any, res);
});

app.put('/api/users', async (req, res) => {
  await usersHandler(req as any, res);
});

app.delete('/api/users', async (req, res) => {
  await usersHandler(req as any, res);
});


app.post('/api/contact', async (req, res) => {
  await contactHandler(req as any, res);
});

app.get('/api/contact', async (req, res) => {
  await contactHandler(req as any, res);
});

app.put('/api/contact', async (req, res) => {
  await contactHandler(req as any, res);
});

app.delete('/api/contact', async (req, res) => {
  await contactHandler(req as any, res);
});

// Coupons routes
app.get('/api/feedback', async (req, res) => {
  await feedbackHandler(req as any, res);
});

app.post('/api/feedback', async (req, res) => {
  await feedbackHandler(req as any, res);
});
app.put('/api/feedback', async (req, res) => {
  await feedbackHandler(req as any, res);
});

app.delete('/api/feedback', async (req, res) => {
  await feedbackHandler(req as any, res);
});
app.get('/api/coupons', async (req, res) => {
  await couponsHandler(req as any, res);
});

app.post('/api/coupons', async (req, res) => {
  await couponsHandler(req as any, res);
});

app.put('/api/coupons', async (req, res) => {
  await couponsHandler(req as any, res);
});

app.delete('/api/coupons', async (req, res) => {
  await couponsHandler(req as any, res);
});

// Error handling
app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    console.error('Error:', err);

    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error:
        process.env.NODE_ENV === 'development'
          ? err.message
          : undefined,
    });
  }
);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
  });
});

export default app;
