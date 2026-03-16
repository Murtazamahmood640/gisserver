import app from './app.ts';
import { connectDB } from './config/database.ts';

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await connectDB();
    console.log('Connected to MongoDB');

    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
