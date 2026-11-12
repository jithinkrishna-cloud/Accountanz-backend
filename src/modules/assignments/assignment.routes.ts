import { Router } from "express";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./assignment.controller.js";
import { assignmentBodySchema, assignmentListQuerySchema, assignmentUpdateSchema } from "./assignment.validation.js";

export const assignmentRoutes = Router();

assignmentRoutes.get("/", validate({ query: assignmentListQuerySchema }), controller.list);
assignmentRoutes.get("/options", controller.options);
assignmentRoutes.post("/", validate({ body: assignmentBodySchema }), controller.create);
assignmentRoutes.get("/:id", validate({ params: idParam }), controller.get);
assignmentRoutes.patch("/:id", validate({ params: idParam, body: assignmentUpdateSchema }), controller.update);
assignmentRoutes.post("/:id/end", validate({ params: idParam }), controller.end);
