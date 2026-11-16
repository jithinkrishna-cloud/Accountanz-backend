import { Router, type RequestHandler } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { documentUpload, multipartFields } from "../../middleware/upload.js";
import { idParam, validate } from "../../middleware/validate.js";
import { CLIENT_ROLES } from "../../types/auth.types.js";
import * as c from "./client-portal.controller.js";
import { requireContext } from "./client-portal.service.js";
import { approvalDecisionSchema, connectJournlSchema, meetingRequestSchema, newThreadSchema, portalClientUpdateSchema, replySchema, settingsSchema, tasksQuerySchema, uploadMetaSchema } from "./client-portal.validation.js";
import { activity as jlActivity, catalog as jlCatalog, team as jlTeam, setModule as jlSetModule } from "./journl-client-permission.controller.js";
import { modulePermissionBody, modulePermissionParams } from "../journl-permissions/permission.validation.js";

/** Resolves the signed-in user's company once per request; every handler reads only that company. */
const withClient: RequestHandler = async (req, res, next) => {
  res.locals.client = await requireContext(req.user!);
  next();
};

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
clientPortalRoutes.post("/software/journl/disconnect", c.disconnectJournl);
clientPortalRoutes.get("/documents", c.documents);
clientPortalRoutes.post("/documents", documentUpload(), multipartFields(uploadMetaSchema), c.upload);
clientPortalRoutes.get("/documents/:id/file", validate({ params: idParam }), c.downloadDocument);
clientPortalRoutes.get("/requests", c.requests);
clientPortalRoutes.get("/tasks", validate({ query: tasksQuerySchema }), c.tasks);
clientPortalRoutes.get("/reports", c.reports);
clientPortalRoutes.get("/reports/:id/file", validate({ params: idParam }), c.downloadReport);
clientPortalRoutes.get("/approvals", c.approvals);
clientPortalRoutes.post("/approvals/:id/decision", validate({ params: idParam, body: approvalDecisionSchema }), c.decideApproval);
clientPortalRoutes.get("/messages", c.threads);
clientPortalRoutes.post("/messages", validate({ body: newThreadSchema }), c.startThread);
clientPortalRoutes.get("/messages/mentionable", c.mentionable);
clientPortalRoutes.get("/messages/:id", validate({ params: idParam }), c.thread);
clientPortalRoutes.post("/messages/:id", validate({ params: idParam, body: replySchema }), c.reply);
clientPortalRoutes.get("/meetings", c.meetings);
clientPortalRoutes.get("/meeting-requests", c.meetingRequests);
clientPortalRoutes.post("/meeting-requests", validate({ body: meetingRequestSchema }), c.requestMeeting);
clientPortalRoutes.post("/meeting-requests/:id/withdraw", validate({ params: idParam }), c.withdrawMeetingRequest);
clientPortalRoutes.get("/billing", c.billing);
clientPortalRoutes.get("/packages", c.packages);
clientPortalRoutes.get("/proposal", c.proposal);
clientPortalRoutes.post("/proposal/accept", c.acceptProposal);
clientPortalRoutes.post("/packages/:id/choose", validate({ params: idParam }), c.choosePackage);
clientPortalRoutes.get("/settings", c.settings);
clientPortalRoutes.patch("/settings", validate({ body: settingsSchema }), c.updateSettings);
clientPortalRoutes.patch("/client", validate({ body: portalClientUpdateSchema }), c.updateClient);
clientPortalRoutes.get("/journl-permissions/catalog", jlCatalog);
clientPortalRoutes.get("/journl-permissions/team", jlTeam);
clientPortalRoutes.get("/journl-permissions/assignments/:id/activity", validate({ params: idParam }), jlActivity);
clientPortalRoutes.put(
  "/journl-permissions/assignments/:id/modules/:moduleKey",
  validate({ params: modulePermissionParams, body: modulePermissionBody }),
  jlSetModule,
);
