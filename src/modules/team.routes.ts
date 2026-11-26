import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { ACCOUNTANT_ROLES } from "../types/auth.types.js";
import { approvalRoutes } from "./approvals/approval.routes.js";
import { communicationRoutes } from "./communication/communication.routes.js";
import { documentRoutes } from "./documents/document.routes.js";
import { bizpoleStaffRoutes } from "./integrations/bizpole/bizpole.routes.js";
import { reportRoutes } from "./reports/report.routes.js";
import { staffReviewRoutes } from "./reviews/review.routes.js";
import { staffTaskRoutes } from "./tasks/task.routes.js";
import { workspaceRoutes } from "./workspace/workspace.routes.js";

/**
 * Accountant Workspace API: everything under /api/team requires a bookkeeper, finance manager or CFO.
 * Delivery routers (documents, reports, client approvals, communication) are shared with /api/admin.
 * Client-level access (active assignment today) is enforced per request in the services.
 */
export const teamRoutes = Router();

teamRoutes.use(authenticate, authorize(...ACCOUNTANT_ROLES));
teamRoutes.use("/tasks", staffTaskRoutes);
teamRoutes.use("/reviews", staffReviewRoutes);
teamRoutes.use("/workspace", workspaceRoutes);
teamRoutes.use("/workspace", bizpoleStaffRoutes);
teamRoutes.use("/documents", documentRoutes);
teamRoutes.use("/reports", reportRoutes);
teamRoutes.use("/client-approvals", approvalRoutes);
teamRoutes.use("/communication", communicationRoutes);
