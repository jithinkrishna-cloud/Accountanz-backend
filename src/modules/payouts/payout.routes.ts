import { Router } from "express";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./payout.controller.js";
import { generateRunSchema, markPaidSchema, payoutPeriodQuerySchema } from "./payout.validation.js";

export const payoutRoutes = Router();

payoutRoutes.get("/", validate({ query: payoutPeriodQuerySchema }), controller.list);
payoutRoutes.post("/generate", validate({ body: generateRunSchema }), controller.generate);
payoutRoutes.post("/:id/approve", validate({ params: idParam }), controller.approve);
payoutRoutes.post("/:id/mark-paid", validate({ params: idParam, body: markPaidSchema }), controller.markPaid);
