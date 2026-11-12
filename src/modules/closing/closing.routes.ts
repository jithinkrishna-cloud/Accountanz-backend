import { Router } from "express";
import { validate } from "../../middleware/validate.js";
import * as controller from "./closing.controller.js";
import { closingParams, closingStatusSchema } from "./closing.validation.js";

export const closingRoutes = Router();

closingRoutes.get("/", controller.grid);
closingRoutes.put("/:clientId/:period", validate({ params: closingParams, body: closingStatusSchema }), controller.setStatus);
