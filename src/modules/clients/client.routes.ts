import { Router } from "express";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./client.controller.js";
import {
  branchBodySchema,
  branchParamsSchema,
  clientBodySchema,
  clientListQuerySchema,
  clientUpdateSchema,
  companyTaxDetailsSchema,
  financialProfileSchema,
  inviteClientUserSchema,
  stakeholderListSchema,
  stakeholderParamsSchema,
  stakeholderSchema,
} from "./client.validation.js";

export const clientRoutes = Router();

clientRoutes.get("/", validate({ query: clientListQuerySchema }), controller.list);
clientRoutes.post("/", validate({ body: clientBodySchema }), controller.create);
clientRoutes.get("/:id", validate({ params: idParam }), controller.get);
clientRoutes.patch("/:id", validate({ params: idParam, body: clientUpdateSchema }), controller.update);
clientRoutes.post("/:id/users", validate({ params: idParam, body: inviteClientUserSchema }), controller.inviteUser);
clientRoutes.post("/:id/branches", validate({ params: idParam, body: branchBodySchema }), controller.addBranch);
clientRoutes.patch("/:id/branches/:branchId", validate({ params: branchParamsSchema, body: branchBodySchema }), controller.updateBranch);
clientRoutes.delete("/:id/branches/:branchId", validate({ params: branchParamsSchema }), controller.removeBranch);

clientRoutes.get("/:id/tax-details", validate({ params: idParam }), controller.getTaxDetails);
clientRoutes.put("/:id/tax-details", validate({ params: idParam, body: companyTaxDetailsSchema }), controller.saveTaxDetails);
clientRoutes.get("/:id/stakeholders", validate({ params: idParam }), controller.listStakeholders);
clientRoutes.put("/:id/stakeholders", validate({ params: idParam, body: stakeholderListSchema }), controller.saveStakeholders);
clientRoutes.post("/:id/stakeholders", validate({ params: idParam, body: stakeholderSchema }), controller.addStakeholder);
clientRoutes.patch("/:id/stakeholders/:stakeholderId", validate({ params: stakeholderParamsSchema, body: stakeholderSchema }), controller.updateStakeholder);
clientRoutes.delete("/:id/stakeholders/:stakeholderId", validate({ params: stakeholderParamsSchema }), controller.removeStakeholder);
clientRoutes.get("/:id/financial-profile", validate({ params: idParam }), controller.getFinancialProfile);
clientRoutes.put("/:id/financial-profile", validate({ params: idParam, body: financialProfileSchema }), controller.saveFinancialProfile);
