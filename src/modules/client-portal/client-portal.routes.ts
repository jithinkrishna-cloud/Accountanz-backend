import { Router, type RequestHandler } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { documentUpload, multipartFields } from "../../middleware/upload.js";
import { journlEnabled } from "../../middleware/journl-enabled.js";
import { idParam, validate, type IdParam } from "../../middleware/validate.js";
import * as packageChanges from "../package-changes/package-change.service.js";
import { packageChangeRequestSchema } from "../package-changes/package-change.validation.js";
import type { ClientContext } from "./client-portal.types.js";
import { CLIENT_ROLES } from "../../types/auth.types.js";
import * as c from "./client-portal.controller.js";
import { requireContext } from "./client-portal.service.js";
import { exploreRoutes } from "../accountant-requests/accountant-request.routes.js";
import { messageParam } from "../communication/communication.validation.js";
import { approvalDecisionSchema, clientTaskSchema, meetingRequestSchema, newThreadSchema, portalClientUpdateSchema, replySchema, settingsSchema, tasksQuerySchema, uploadMetaSchema } from "./client-portal.validation.js";
import { activity as jlActivity, catalog as jlCatalog, team as jlTeam, setModule as jlSetModule } from "./journl-client-permission.controller.js";
import { modulePermissionBody, modulePermissionParams } from "../journl-permissions/permission.validation.js";
import { bizpoleOwnerRoutes } from "../integrations/bizpole/bizpole.routes.js";
import { attachDocumentSchema, createFolderSchema, moveDocumentSchema, renameFolderSchema, shareFolderSchema } from "../document-folders/document-folder.validation.js";

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
clientPortalRoutes.use(exploreRoutes);

clientPortalRoutes.get("/dashboard", c.dashboard);
clientPortalRoutes.get("/business", c.business);
clientPortalRoutes.get("/team", c.team);
clientPortalRoutes.get("/team/:id", validate({ params: idParam }), c.teamMember);
clientPortalRoutes.get("/software", c.software);
clientPortalRoutes.post("/software/journl/disconnect", journlEnabled, c.disconnectJournl);
clientPortalRoutes.use("/software/bizpole", bizpoleOwnerRoutes);
clientPortalRoutes.get("/documents", c.documents);
clientPortalRoutes.post("/documents", documentUpload(), multipartFields(uploadMetaSchema), c.upload);
clientPortalRoutes.get("/documents/:id/file", validate({ params: idParam }), c.downloadDocument);
clientPortalRoutes.patch("/documents/:id", validate({ params: idParam, body: moveDocumentSchema }), c.moveDocument);
clientPortalRoutes.get("/folders", c.folders);
clientPortalRoutes.post("/folders", validate({ body: createFolderSchema }), c.createFolder);
clientPortalRoutes.patch("/folders/:id", validate({ params: idParam, body: renameFolderSchema }), c.renameFolder);
clientPortalRoutes.delete("/folders/:id", validate({ params: idParam }), c.deleteFolder);
clientPortalRoutes.put("/folders/:id/share", validate({ params: idParam, body: shareFolderSchema }), c.shareFolder);
clientPortalRoutes.put("/documents/:id/share", validate({ params: idParam, body: shareFolderSchema }), c.shareDocument);
clientPortalRoutes.post("/requests/:id/attach", validate({ params: idParam, body: attachDocumentSchema }), c.attachToRequest);
clientPortalRoutes.get("/requests", c.requests);
clientPortalRoutes.get("/tasks", validate({ query: tasksQuerySchema }), c.tasks);
clientPortalRoutes.post("/tasks", validate({ body: clientTaskSchema }), c.createTask);
clientPortalRoutes.patch("/tasks/:id", validate({ params: idParam, body: clientTaskSchema }), c.updateTask);
clientPortalRoutes.delete("/tasks/:id", validate({ params: idParam }), c.deleteTask);
clientPortalRoutes.get("/reports", c.reports);
clientPortalRoutes.get("/reports/:id/file", validate({ params: idParam }), c.downloadReport);
clientPortalRoutes.get("/approvals", c.approvals);
clientPortalRoutes.post("/approvals/:id/decision", validate({ params: idParam, body: approvalDecisionSchema }), c.decideApproval);
clientPortalRoutes.get("/messages", c.threads);
clientPortalRoutes.post("/messages", validate({ body: newThreadSchema }), c.startThread);
clientPortalRoutes.get("/messages/mentionable", c.mentionable);
clientPortalRoutes.get("/messages/:id", validate({ params: idParam }), c.thread);
clientPortalRoutes.post("/messages/:id", validate({ params: idParam, body: replySchema }), c.reply);
clientPortalRoutes.patch("/messages/:id/:messageId", validate({ params: messageParam, body: replySchema }), c.editMessage);
clientPortalRoutes.get("/meetings", c.meetings);
clientPortalRoutes.get("/meeting-requests", c.meetingRequests);
clientPortalRoutes.post("/meeting-requests", validate({ body: meetingRequestSchema }), c.requestMeeting);
clientPortalRoutes.post("/meeting-requests/:id/withdraw", validate({ params: idParam }), c.withdrawMeetingRequest);
clientPortalRoutes.get("/billing", c.billing);
clientPortalRoutes.get("/packages", c.packages);
clientPortalRoutes.get("/proposal", c.proposal);
clientPortalRoutes.post("/proposal/accept", c.acceptProposal);
clientPortalRoutes.post("/packages/:id/choose", validate({ params: idParam }), c.choosePackage);
// Once the agreement has gone out, a different package is asked for (staff approve it) rather than chosen.
clientPortalRoutes.post("/package-changes", validate({ body: packageChangeRequestSchema }), async (req, res) =>
  void res.status(201).json(await packageChanges.requestChange(req.user!, res.locals.client as ClientContext, req.body)),
);
clientPortalRoutes.post("/package-changes/:id/withdraw", validate({ params: idParam }), async (req, res) =>
  void res.json(await packageChanges.withdrawChange(req.user!, res.locals.client as ClientContext, (res.locals.params as IdParam).id)),
);
clientPortalRoutes.get("/settings", c.settings);
clientPortalRoutes.patch("/settings", validate({ body: settingsSchema }), c.updateSettings);
clientPortalRoutes.patch("/client", validate({ body: portalClientUpdateSchema }), c.updateClient);
clientPortalRoutes.use("/journl-permissions", journlEnabled);
clientPortalRoutes.get("/journl-permissions/catalog", jlCatalog);
clientPortalRoutes.get("/journl-permissions/team", jlTeam);
clientPortalRoutes.get("/journl-permissions/assignments/:id/activity", validate({ params: idParam }), jlActivity);
clientPortalRoutes.put(
  "/journl-permissions/assignments/:id/modules/:moduleKey",
  validate({ params: modulePermissionParams, body: modulePermissionBody }),
  jlSetModule,
);
