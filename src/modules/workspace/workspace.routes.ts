import { Router } from "express";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./workspace.controller.js";
import { journlDataQuerySchema } from "../integrations/integration.validation.js";
import { checklistQuerySchema, closingParamsSchema, readinessSchema } from "./workspace.validation.js";

/** Accountant workspace: /api/team/workspace. `client-options` is also mounted for admins (shared pickers). */
export const workspaceRoutes = Router();

workspaceRoutes.get("/dashboard", controller.dashboard);
workspaceRoutes.get("/clients", controller.clients);
workspaceRoutes.get("/client-options", controller.clientOptions);
workspaceRoutes.get("/clients/:id", validate({ params: idParam }), controller.client);
workspaceRoutes.get("/clients/:id/journl-data", validate({ params: idParam, query: journlDataQuerySchema }), controller.clientJournlData);
workspaceRoutes.get("/closing", validate({ query: checklistQuerySchema }), controller.checklist);
workspaceRoutes.put("/closing/:clientId/:period", validate({ params: closingParamsSchema, body: readinessSchema }), controller.setReadiness);
