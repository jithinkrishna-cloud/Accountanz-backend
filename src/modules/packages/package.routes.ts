import { Router } from "express";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./package.controller.js";
import { packageBodySchema, packageUpdateSchema } from "./package.validation.js";

export const packageRoutes = Router();

packageRoutes.get("/", controller.list);
packageRoutes.post("/", validate({ body: packageBodySchema }), controller.create);
packageRoutes.patch("/:id", validate({ params: idParam, body: packageUpdateSchema }), controller.update);
