import { Router } from "express";
import { validate } from "../../middleware/validate.js";
import * as controller from "./team.controller.js";
import { clientIdParam, createTeamSchema, teamListQuerySchema, teamNameSchema } from "./team.validation.js";

export const teamRoutes = Router();

teamRoutes.get("/", validate({ query: teamListQuerySchema }), controller.list);
teamRoutes.get("/client-options", controller.clientOptions);
teamRoutes.post("/", validate({ body: createTeamSchema }), controller.create);
teamRoutes.put("/:clientId", validate({ params: clientIdParam, body: teamNameSchema }), controller.rename);
