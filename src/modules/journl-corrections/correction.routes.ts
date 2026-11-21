import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { journlEnabled } from "../../middleware/journl-enabled.js";
import { ACCOUNTANT_ROLES } from "../../types/auth.types.js";
import * as controller from "./correction.controller.js";
import { approveBody, clientParams, commentBody, correctionInputSchema, correctionParams, resolveBody } from "./correction.controller.js";

/**
 * JournL corrections, mounted at /api/team/workspace BEFORE the team guard (team.routes.ts) so super_admin can reach
 * these paths, and only these: the guard below applies to the correction prefixes alone, and any other path falls
 * through to the team router unchanged. ops_admin is never allowed (it never prepares or approves).
 * Client scope (404) and per-action rules (prepare / initiator / approver) are enforced in the service.
 */
export const correctionRoutes = Router();

const BASE = "/clients/:id/journl/corrections";
correctionRoutes.use([BASE, "/journl/corrections"], journlEnabled, authenticate, authorize(...ACCOUNTANT_ROLES, "super_admin"));
correctionRoutes.get("/journl/corrections/awaiting", controller.awaiting);
correctionRoutes.get(BASE, validate({ params: clientParams }), controller.list);
correctionRoutes.post(BASE, validate({ params: clientParams, body: correctionInputSchema }), controller.create);
correctionRoutes.get(`${BASE}/lookup/ledgers`, validate({ params: clientParams }), controller.lookupLedgers);
correctionRoutes.get(`${BASE}/lookup/branches`, validate({ params: clientParams }), controller.lookupBranches);
correctionRoutes.post(`${BASE}/preview`, validate({ params: clientParams, body: correctionInputSchema }), controller.preview);
correctionRoutes.get(`${BASE}/:cid`, validate({ params: correctionParams }), controller.get);
correctionRoutes.patch(`${BASE}/:cid`, validate({ params: correctionParams, body: correctionInputSchema }), controller.update);
correctionRoutes.post(`${BASE}/:cid/submit`, validate({ params: correctionParams }), controller.submit);
correctionRoutes.post(`${BASE}/:cid/send-back`, validate({ params: correctionParams, body: commentBody }), controller.sendBack);
correctionRoutes.post(`${BASE}/:cid/reject`, validate({ params: correctionParams, body: commentBody }), controller.reject);
correctionRoutes.post(`${BASE}/:cid/check`, validate({ params: correctionParams }), controller.check);
correctionRoutes.post(`${BASE}/:cid/resolve`, validate({ params: correctionParams, body: resolveBody }), controller.resolve);
correctionRoutes.post(`${BASE}/:cid/prepare-again`, validate({ params: correctionParams }), controller.prepareAgain);
correctionRoutes.post(`${BASE}/:cid/approve`, validate({ params: correctionParams, body: approveBody }), controller.approve);
correctionRoutes.post(`${BASE}/:cid/post`, validate({ params: correctionParams }), controller.post);
