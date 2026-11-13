import { Router } from "express";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./integration.controller.js";
import { createConnectionSchema, integrationListQuerySchema, journlDataQuerySchema, verifyConnectionSchema } from "./integration.validation.js";

export const integrationRoutes = Router();

integrationRoutes.get("/", validate({ query: integrationListQuerySchema }), controller.list);
integrationRoutes.post("/", validate({ body: createConnectionSchema }), controller.create);
integrationRoutes.post("/:id/verify", validate({ params: idParam, body: verifyConnectionSchema }), controller.verify);
integrationRoutes.get("/:id/journl-data", validate({ params: idParam, query: journlDataQuerySchema }), controller.journlData);
integrationRoutes.post("/:id/health-check", validate({ params: idParam }), controller.healthCheck);
