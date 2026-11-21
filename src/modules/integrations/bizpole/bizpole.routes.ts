import { Router } from "express";
import { journlEnabled } from "../../../middleware/journl-enabled.js";
import { validate } from "../../../middleware/validate.js";
import * as c from "./bizpole.controller.js";
import { connectSchema, selectCompanySchema, staffParams, staffQuery } from "./bizpole.validation.js";

/**
 * Client portal: mounted at /api/app/software/bizpole after the portal's own guards (client roles + the user's
 * company context). Connect / choose / disconnect are owner-only (checked in the service).
 */
export const bizpoleOwnerRoutes = Router();
bizpoleOwnerRoutes.use(journlEnabled);
bizpoleOwnerRoutes.get("/", c.status);
bizpoleOwnerRoutes.post("/connect", validate({ body: connectSchema }), c.connect);
bizpoleOwnerRoutes.post("/company", validate({ body: selectCompanySchema }), c.selectCompany);
bizpoleOwnerRoutes.post("/disconnect", c.disconnect);

/**
 * Accountant workspace: mounted under /api/team/workspace behind the team guard (accountant roles). Each read checks
 * the user works on that client (else 404) and is audited. GET only: there are no write routes.
 */
export const bizpoleStaffRoutes = Router();
bizpoleStaffRoutes.get("/clients/:id/bizpole/:resource", journlEnabled, validate({ params: staffParams, query: staffQuery }), c.read);
