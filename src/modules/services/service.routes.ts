import { Router } from "express";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./service.controller.js";
import { serviceBodySchema, serviceUpdateSchema } from "./service.validation.js";

export const serviceRoutes = Router();

serviceRoutes.get("/", controller.list);
serviceRoutes.post("/", validate({ body: serviceBodySchema }), controller.create);
serviceRoutes.patch("/:id", validate({ params: idParam, body: serviceUpdateSchema }), controller.update);
