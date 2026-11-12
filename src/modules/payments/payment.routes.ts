import { Router } from "express";
import { validate } from "../../middleware/validate.js";
import * as controller from "./payment.controller.js";
import { paymentListQuerySchema, recordPaymentSchema } from "./payment.validation.js";

export const paymentRoutes = Router();

paymentRoutes.get("/", validate({ query: paymentListQuerySchema }), controller.list);
paymentRoutes.get("/open-invoices", controller.openInvoices);
paymentRoutes.post("/", validate({ body: recordPaymentSchema }), controller.record);
