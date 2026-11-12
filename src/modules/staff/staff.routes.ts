import { Router } from "express";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./staff.controller.js";
import { inviteStaffSchema, staffListQuerySchema, updateStaffSchema } from "./staff.validation.js";

export const staffRoutes = Router();

staffRoutes.get("/", validate({ query: staffListQuerySchema }), controller.list);
staffRoutes.post("/invite", validate({ body: inviteStaffSchema }), controller.invite);
staffRoutes.get("/:id", validate({ params: idParam }), controller.get);
staffRoutes.patch("/:id", validate({ params: idParam, body: updateStaffSchema }), controller.update);
staffRoutes.post("/:id/invite-link", validate({ params: idParam }), controller.resendInvite);
staffRoutes.delete("/:id", validate({ params: idParam }), controller.remove);
