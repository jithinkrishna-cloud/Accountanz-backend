import { Router, type Response } from "express";
import { singleFile } from "../../middleware/upload.js";
import { idParam, validate, type IdParam } from "../../middleware/validate.js";
import * as packageChanges from "../package-changes/package-change.service.js";
import { packageChangeDecisionSchema, staffPackageChangeSchema } from "../package-changes/package-change.validation.js";
import * as controller from "./engagement.controller.js";
import { engagementBodySchema, engagementListQuerySchema, engagementUpdateSchema, statusBodySchema } from "./engagement.validation.js";

export const engagementRoutes = Router();

const agreementUpload = singleFile("file", { maxMb: 10, extensions: ["pdf", "png", "jpg", "jpeg"], label: "The agreement" });

engagementRoutes.get("/", validate({ query: engagementListQuerySchema }), controller.list);
engagementRoutes.post("/", validate({ body: engagementBodySchema }), controller.create);
engagementRoutes.get("/:id", validate({ params: idParam }), controller.get);
engagementRoutes.patch("/:id", validate({ params: idParam, body: engagementUpdateSchema }), controller.update);
engagementRoutes.post("/:id/status", validate({ params: idParam, body: statusBodySchema }), controller.changeStatus);
engagementRoutes.post("/:id/activate-now", validate({ params: idParam }), controller.activateNow);
engagementRoutes.post("/:id/agreement", validate({ params: idParam }), agreementUpload, controller.uploadAgreement);
engagementRoutes.get("/:id/agreement", validate({ params: idParam }), controller.downloadAgreement);

// Package changes: staff change the package directly, or answer a client's request.
const idOf = (res: Response) => (res.locals.params as IdParam).id;
engagementRoutes.post("/:id/package-change", validate({ params: idParam, body: staffPackageChangeSchema }), async (req, res) =>
  void res.json(await packageChanges.staffChange(req.user!, idOf(res), req.body)),
);
engagementRoutes.post("/package-changes/:id/decision", validate({ params: idParam, body: packageChangeDecisionSchema }), async (req, res) =>
  void res.json(await packageChanges.decideChange(req.user!, idOf(res), req.body)),
);
