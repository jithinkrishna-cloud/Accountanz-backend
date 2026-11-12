import { Router, type RequestHandler } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { singleFile } from "../../middleware/upload.js";
import { idParam, validate } from "../../middleware/validate.js";
import { AppError } from "../../utils/app-error.js";
import { CLIENT_ROLES } from "../../types/auth.types.js";
import * as c from "./client-portal.controller.js";
import { requireContext } from "./client-portal.service.js";
import { approvalDecisionSchema, connectJournlSchema, newThreadSchema, replySchema, settingsSchema, tasksQuerySchema, uploadMetaSchema } from "./client-portal.validation.js";

/** Resolves the signed-in user's company once per request; every handler reads only that company. */
const withClient: RequestHandler = async (req, res, next) => {
  res.locals.client = await requireContext(req.user!);
  next();
};

/** Multipart fields arrive as strings after the file is parsed; validate them like a body. */
const uploadMeta: RequestHandler = (req, res, next) => {
  const parsed = uploadMetaSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Please check the upload details");
  res.locals.body = parsed.data;
  next();
};

const docUpload = singleFile("file", {
  maxMb: 20,
  extensions: ["pdf", "png", "jpg", "jpeg", "xls", "xlsx", "csv", "doc", "docx", "zip"],
  label: "The document",
});

/** Client portal API: /api/app (client owners and members only). */
export const clientPortalRoutes = Router();

clientPortalRoutes.use(authenticate, authorize(...CLIENT_ROLES));
clientPortalRoutes.get("/context", c.context);
clientPortalRoutes.use(withClient);

clientPortalRoutes.get("/dashboard", c.dashboard);
clientPortalRoutes.get("/business", c.business);
clientPortalRoutes.get("/team", c.team);
clientPortalRoutes.get("/software", c.software);
clientPortalRoutes.post("/software/journl", validate({ body: connectJournlSchema }), c.connectJournl);
clientPortalRoutes.get("/documents", c.documents);
clientPortalRoutes.post("/documents", docUpload, uploadMeta, c.upload);
clientPortalRoutes.get("/documents/:id/file", validate({ params: idParam }), c.downloadDocument);
clientPortalRoutes.get("/requests", c.requests);
clientPortalRoutes.get("/tasks", validate({ query: tasksQuerySchema }), c.tasks);
clientPortalRoutes.get("/reports", c.reports);
clientPortalRoutes.get("/reports/:id/file", validate({ params: idParam }), c.downloadReport);
clientPortalRoutes.get("/approvals", c.approvals);
clientPortalRoutes.post("/approvals/:id/decision", validate({ params: idParam, body: approvalDecisionSchema }), c.decideApproval);
clientPortalRoutes.get("/messages", c.threads);
clientPortalRoutes.post("/messages", validate({ body: newThreadSchema }), c.startThread);
clientPortalRoutes.get("/messages/:id", validate({ params: idParam }), c.thread);
clientPortalRoutes.post("/messages/:id", validate({ params: idParam, body: replySchema }), c.reply);
clientPortalRoutes.get("/meetings", c.meetings);
clientPortalRoutes.get("/billing", c.billing);
clientPortalRoutes.get("/settings", c.settings);
clientPortalRoutes.patch("/settings", validate({ body: settingsSchema }), c.updateSettings);
