import { Router } from "express";
import { idParam, validate } from "../../middleware/validate.js";
import { listQuerySchema } from "../../utils/pagination.js";
import * as controller from "./document.controller.js";
import { documentListQuerySchema, documentStatusSchema } from "./document.validation.js";

export const documentRoutes = Router();

documentRoutes.get("/", validate({ query: documentListQuerySchema }), controller.list);
documentRoutes.get("/requests", validate({ query: listQuerySchema }), controller.openRequests);
documentRoutes.patch("/:id/status", validate({ params: idParam, body: documentStatusSchema }), controller.setStatus);
documentRoutes.get("/:id/file", validate({ params: idParam }), controller.download);
