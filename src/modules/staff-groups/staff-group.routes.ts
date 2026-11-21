import { Router } from "express";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./staff-group.controller.js";
import { assignGroupSchema, staffGroupBodySchema } from "./staff-group.validation.js";

export const staffGroupRoutes = Router();

staffGroupRoutes.get("/", controller.list);
staffGroupRoutes.post("/", validate({ body: staffGroupBodySchema }), controller.create);
staffGroupRoutes.get("/:id", validate({ params: idParam }), controller.get);
staffGroupRoutes.put("/:id", validate({ params: idParam, body: staffGroupBodySchema }), controller.update);
staffGroupRoutes.delete("/:id", validate({ params: idParam }), controller.remove);
staffGroupRoutes.post("/:id/assign", validate({ params: idParam, body: assignGroupSchema }), controller.assign);
