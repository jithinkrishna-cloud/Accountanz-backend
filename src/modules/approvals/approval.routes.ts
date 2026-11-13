import { Router } from "express";
import { validate } from "../../middleware/validate.js";
import * as controller from "./approval.controller.js";
import { approvalListQuerySchema, createApprovalSchema } from "./approval.validation.js";

/** Client approval requests, mounted at /api/admin/client-approvals and /api/team/client-approvals. */
export const approvalRoutes = Router();

approvalRoutes.get("/", validate({ query: approvalListQuerySchema }), controller.list);
approvalRoutes.post("/", validate({ body: createApprovalSchema }), controller.create);
