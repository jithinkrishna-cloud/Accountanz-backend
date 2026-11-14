import { Router } from "express";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./integration.controller.js";
import { integrationListQuerySchema, journlDataQuerySchema } from "./integration.validation.js";

/** Admin: /api/admin/integrations. Read-only: connections come from the owner's "Sign in with JournL". */
export const integrationRoutes = Router();

integrationRoutes.get("/", validate({ query: integrationListQuerySchema }), controller.list);
integrationRoutes.get("/:id/journl-data", validate({ params: idParam, query: journlDataQuerySchema }), controller.journlData);
