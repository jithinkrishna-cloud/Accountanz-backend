import { Router } from "express";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./invoice.controller.js";
import { createInvoiceSchema, invoiceListQuerySchema, invoiceStatusSchema } from "./invoice.validation.js";

export const invoiceRoutes = Router();

invoiceRoutes.get("/", validate({ query: invoiceListQuerySchema }), controller.list);
invoiceRoutes.post("/", validate({ body: createInvoiceSchema }), controller.create);
invoiceRoutes.patch("/:id/status", validate({ params: idParam, body: invoiceStatusSchema }), controller.setStatus);
