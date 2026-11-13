import { Router } from "express";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./communication.controller.js";
import { meetingListQuerySchema, newMeetingSchema, newThreadSchema, replySchema, threadListQuerySchema } from "./communication.validation.js";

/** Mounted at /api/admin/communication and /api/team/communication; the service applies client access. */
export const communicationRoutes = Router();

communicationRoutes.get("/threads", validate({ query: threadListQuerySchema }), controller.threads);
communicationRoutes.post("/threads", validate({ body: newThreadSchema }), controller.startThread);
communicationRoutes.get("/threads/:id", validate({ params: idParam }), controller.thread);
communicationRoutes.post("/threads/:id/messages", validate({ params: idParam, body: replySchema }), controller.reply);
communicationRoutes.get("/meetings", validate({ query: meetingListQuerySchema }), controller.meetings);
communicationRoutes.post("/meetings", validate({ body: newMeetingSchema }), controller.schedule);
communicationRoutes.delete("/meetings/:id", validate({ params: idParam }), controller.cancelMeeting);
