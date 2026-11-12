import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { ACCOUNTANT_ROLES } from "../types/auth.types.js";
import { staffReviewRoutes } from "./reviews/review.routes.js";
import { staffTaskRoutes } from "./tasks/task.routes.js";

/**
 * Accountant Workspace API: everything under /api/team requires a bookkeeper, finance manager or CFO.
 * Client-level access (active assignment today) is enforced per request in the services.
 */
export const teamRoutes = Router();

teamRoutes.use(authenticate, authorize(...ACCOUNTANT_ROLES));
teamRoutes.use("/tasks", staffTaskRoutes);
teamRoutes.use("/reviews", staffReviewRoutes);
