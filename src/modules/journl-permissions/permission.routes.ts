import { Router } from "express";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./permission.controller.js";
import { modulePermissionBody, modulePermissionParams } from "./permission.validation.js";

/** Admin: /api/admin/journl-permissions. Assignment-level JournL module permissions (provisional catalogue). */
export const journlPermissionRoutes = Router();

journlPermissionRoutes.get("/catalog", controller.catalog);
journlPermissionRoutes.get("/assignments/:id", validate({ params: idParam }), controller.forAssignment);
journlPermissionRoutes.put("/assignments/:id/modules/:moduleKey", validate({ params: modulePermissionParams, body: modulePermissionBody }), controller.setModule);
