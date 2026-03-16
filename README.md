# GIS Backend API

This is the backend API for the GIS (Luxe Detail Booker) application, designed to be deployed on **Vercel** as a Node.js serverless function.

## Project Structure

```
gis_backend/
├── config/
│   ├── cors.ts           # CORS configuration
│   └── database.ts       # MongoDB connection
├── handlers/
│   ├── auth.ts           # Authentication (login/register)
│   ├── appointments.ts   # Appointment CRUD operations
│   ├── contact.ts        # Contact form submissions
│   ├── users.ts          # User management (admin only)
│   ├── coupons.ts        # Coupon management (admin only)
│   └── feedback.ts       # Feedback/reviews management
├── middleware/
│   └── auth.ts           # Authentication middleware
├── models/
│   ├── User.ts           # User schema
│   ├── Appointment.ts    # Appointment schema
│   ├── Contact.ts        # Contact schema
│   ├── Coupon.ts         # Coupon schema
│   └── Feedback.ts       # Feedback schema
├── services/
│   └── emailService.ts   # Email sending service
├── utils/
│   └── jwt.ts            # JWT token management
├── app.ts                # Express app configuration
├── server.ts             # Server entry point (local development)
├── vercel.json           # Vercel deployment config
├── package.json          # Dependencies
├── tsconfig.json         # TypeScript config
├── .env                  # Environment variables
└── README.md             # This file
```

## Setup & Deployment

### 1. Local Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Server will run on http://localhost:3000
```

### 2. Deploy to Vercel

#### Prerequisites
- GitHub account (repository must be public)
- Vercel account (vercel.com)

#### Steps

1. **Create a new GitHub repository** for the backend
   ```bash
   # Initialize git in gis_backend folder
   cd gis_backend
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/gis-backend.git
   git push -u origin main
   ```

2. **Deploy to Vercel**
   - Go to https://vercel.com/new
   - Click "Import Git Repository"
   - Select `YOUR_USERNAME/gis-backend`
   - Click "Deploy"

3. **Add Environment Variables**
   - In Vercel dashboard, go to Project Settings → Environment Variables
   - Add the following variables:

```env
MONGODB_URI=mongodb+srv://murtazamahmood640_db_user:vb9C9IfaeRynMjlu@cluster0.xdxrbc9.mongodb.net/?appName=Cluster0
JWT_SECRET=42d7f1cf-8b83-4c52-8bfb-e6d1a5acf5a1
STACKMAIL_HOST=smtp.stackmail.com
STACKMAIL_PORT=587
STACKMAIL_SECURE=false
STACKMAIL_USER=info@vornoxlab.com
STACKMAIL_PASS=vornoxtest@12
ADMIN_EMAIL=info@vornoxlab.com
FRONTEND_URL=https://yourdomain.com
NODE_ENV=production
```

4. **Redeploy** - Vercel will automatically redeploy after environment variables are set

### 3. Get Your API Base URL

After deployment, you'll get a URL like: `https://gis-backend-xxxx.vercel.app`

This is your **Backend API Base URL** - use it in your frontend configuration.

## API Endpoints

### Public Endpoints (No Authentication Required)

#### Auth
- `POST /api/auth/login` - User login
- `POST /api/auth/register` - User registration

#### Appointments
- `POST /api/appointments` - Create new appointment

#### Contact
- `POST /api/contact` - Submit contact form

#### Feedback
- `POST /api/feedback` - Submit feedback/review
- `GET /api/feedback?published=true` - Get published feedback

#### Coupons
- `GET /api/coupons?active=true` - Get active coupons

### Protected Endpoints (Admin Only)

#### Appointments
- `GET /api/appointments` - List all appointments
- `PUT /api/appointments/:id` - Update appointment
- `DELETE /api/appointments/:id` - Delete appointment

#### Contact
- `GET /api/contact` - List all contact submissions
- `PUT /api/contact/:id` - Update contact status
- `DELETE /api/contact/:id` - Delete contact

#### Users
- `GET /api/users` - List users (with query: `?search=&role=&status=`)
- `POST /api/users` - Create new user
- `PUT /api/users/:id` - Update user
- `DELETE /api/users/:id` - Delete user

#### Coupons
- `GET /api/coupons` - List all coupons
- `POST /api/coupons` - Create coupon
- `PUT /api/coupons/:id` - Update coupon
- `DELETE /api/coupons/:id` - Delete coupon

#### Feedback (Admin)
- `GET /api/feedback` - List all feedback
- `PUT /api/feedback/:id` - Update feedback status
- `DELETE /api/feedback/:id` - Delete feedback

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `MONGODB_URI` | MongoDB connection string | `mongodb+srv://...` |
| `JWT_SECRET` | Secret key for JWT tokens | Any random string |
| `STACKMAIL_HOST` | Email SMTP server | `smtp.stackmail.com` |
| `STACKMAIL_PORT` | Email SMTP port | `587` |
| `STACKMAIL_USER` | Email account username | `info@example.com` |
| `STACKMAIL_PASS` | Email account password | Your password |
| `ADMIN_EMAIL` | Admin notification email | `info@example.com` |
| `FRONTEND_URL` | Frontend URL for CORS | `https://yourdomain.com` |
| `NODE_ENV` | Environment | `production` |

## Frontend Configuration

Update your frontend `.env.production`:

```env
VITE_API_BASE_URL=https://gis-backend-xxxx.vercel.app/api
```

Then build and deploy your frontend to your hosting.

## Continuous Updates

### When you make changes to the backend:

1. **Commit and push** to GitHub
   ```bash
   git add .
   git commit -m "Your message"
   git push origin main
   ```

2. **Vercel automatically redeploys** - No manual action needed!

3. **Verify** - Check Vercel dashboard for deployment status

## Troubleshooting

### CORS Errors
- Update `FRONTEND_URL` in environment variables
- Restart deployment in Vercel

### Database Connection Issues
- Verify `MONGODB_URI` is correct
- Check MongoDB Atlas IP whitelist allows Vercel

### Email Not Sending
- Verify Stackmail credentials
- Check email logs in Stackmail dashboard

### 404 Not Found
- Ensure routes are correctly defined in `app.ts`
- Check request URL matches endpoint path

## Support

For issues or questions, contact: info@vornoxlab.com
