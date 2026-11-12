import { Router } from "express";
import { singleFile } from "../../middleware/upload.js";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./engagement.controller.js";
import { engagementBodySchema, engagementListQuerySchema, engagementUpdateSchema, statusBodySchema } from "./engagement.validation.js";

export const engagementRoutes = Router();

const agreementUpload = singleFile("file", { maxMb: 10, extensions: ["pdf", "png", "jpg", "jpeg"], label: "The agreement" });

engagementRoutes.get("/", validate({ query: engagementListQuerySchema }), controller.list);
engagementRoutes.post("/", validate({ body: engagementBodySchema }), controller.create);
engagementRoutes.get("/:id", validate({ params: idParam }), controller.get);
engagementRoutes.patch("/:id", validate({ params: idParam, body: engagementUpdateSchema }), controller.update);
engagementRoutes.post("/:id/status", validate({ params: idParam, body: statusBodySchema }), controller.changeStatus);
engagementRoutes.post("/:id/agreement", validate({ params: idParam }), agreementUpload, controller.uploadAgreement);
engagementRoutes.get("/:id/agreement", validate({ params: idParam }), controller.downloadAgreement);
