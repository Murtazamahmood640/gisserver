import { Router } from 'express';
import { VehicleController } from './controller';
import { authenticateToken } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { createVehicleSchema, updateVehicleSchema } from './schema';

const router = Router();

router.use(authenticateToken);

router.post('/', validateBody(createVehicleSchema), VehicleController.create);
router.get('/', VehicleController.list);
router.get('/:id', VehicleController.getById);
router.put('/:id', validateBody(updateVehicleSchema), VehicleController.update);
router.delete('/:id', VehicleController.delete);

export default router;
