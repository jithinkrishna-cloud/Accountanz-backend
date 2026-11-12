import { Router } from "express";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./integration.controller.js";
import { createConnectionSchema, integrationListQuerySchema } from "./integration.validation.js";

export const integrationRoutes = Router();

integrationRoutes.get("/", validate({ query: integrationListQuerySchema }), controller.list);
integrationRoutes.post("/", validate({ body: createConnectionSchema }), controller.create);
integrationRoutes.post("/:id/health-check", validate({ params: idParam }), controller.healthCheck);
