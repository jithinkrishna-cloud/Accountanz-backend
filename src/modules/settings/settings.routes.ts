import { Router } from "express";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./settings.controller.js";
import { updateSettingsSchema } from "./settings.validation.js";

export const settingsRoutes = Router();

settingsRoutes.get("/", controller.get);
// Billing identity and GST rate affect every invoice, so only super admins may change them.
settingsRoutes.patch("/", authorize("super_admin"), validate({ body: updateSettingsSchema }), controller.update);
