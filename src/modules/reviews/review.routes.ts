import { Router } from "express";
import { validate } from "../../middleware/validate.js";
import * as controller from "./review.controller.js";
import { reviewDecisionSchema, taskIdParam } from "./review.validation.js";

/** Admin portal: /api/admin/reviews */
export const reviewRoutes = Router();

reviewRoutes.get("/", controller.overview);
reviewRoutes.post("/:taskId", validate({ params: taskIdParam, body: reviewDecisionSchema }), controller.decide);

/** Accountant portal: /api/team/reviews (scoped to clients I review; same decision rules). */
export const staffReviewRoutes = Router();

staffReviewRoutes.get("/", controller.staffQueue);
staffReviewRoutes.post("/:taskId", validate({ params: taskIdParam, body: reviewDecisionSchema }), controller.decide);
