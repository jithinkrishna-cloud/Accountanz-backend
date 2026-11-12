import { Router } from "express";
import { validate } from "../../middleware/validate.js";
import { listQuerySchema } from "../../utils/pagination.js";
import * as controller from "./audit.controller.js";

export const auditRoutes = Router();

auditRoutes.get("/", validate({ query: listQuerySchema }), controller.list);
