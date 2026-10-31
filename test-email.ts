import dotenv from 'dotenv';
import path from 'path';
import { sendEmail } from './services/emailService';

dotenv.config({ path: path.resolve(__dirname, '.env') });

async function testEmail() {
  try {
    console.log('Attempting to send test email...');
    console.log('Using SMTP User:', process.env.STACKMAIL_USER);
    
    await sendEmail({
      to: 'murtazamahmood640@gmail.com',
      subject: 'Test Email from Global Integrated Support',
      html: '<h1>Success!</h1><p>This is a test email to verify that SMTP settings are correct.</p>',
    });
    
    console.log('Test email sent successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Test email failed:', error);
    process.exit(1);
  }
}

testEmail();
