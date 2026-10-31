import { Router } from 'express';
import { CustomerController } from './controller';
import { authenticateToken } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import {
  updateCustomerProfileSchema,
  addressSchema,
  updateAddressSchema,
} from './schema';

const router = Router();

// All customer routes require authentication
router.use(authenticateToken);

router.get('/me', CustomerController.getMe);
router.put('/me', validateBody(updateCustomerProfileSchema), CustomerController.updateMe);

router.post(['/me/addresses', '/addresses'], validateBody(addressSchema), CustomerController.addAddress);
router.put(['/me/addresses/:addressId', '/addresses/:addressId'], validateBody(updateAddressSchema), CustomerController.updateAddress);
router.delete(['/me/addresses/:addressId', '/addresses/:addressId'], CustomerController.deleteAddress);

export default router;
