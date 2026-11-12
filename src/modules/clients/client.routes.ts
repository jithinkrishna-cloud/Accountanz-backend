import { Router } from "express";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./client.controller.js";
import { clientBodySchema, clientListQuerySchema, clientUpdateSchema, inviteClientUserSchema } from "./client.validation.js";

export const clientRoutes = Router();

clientRoutes.get("/", validate({ query: clientListQuerySchema }), controller.list);
clientRoutes.post("/", validate({ body: clientBodySchema }), controller.create);
clientRoutes.get("/:id", validate({ params: idParam }), controller.get);
clientRoutes.patch("/:id", validate({ params: idParam, body: clientUpdateSchema }), controller.update);
clientRoutes.post("/:id/users", validate({ params: idParam, body: inviteClientUserSchema }), controller.inviteUser);
