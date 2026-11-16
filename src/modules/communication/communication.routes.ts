import { Router } from "express";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./communication.controller.js";
import { declineRequestSchema, meetingListQuerySchema, mentionableQuerySchema, meetingRequestListQuerySchema, messageParam, newMeetingSchema, newThreadSchema, replySchema, threadListQuerySchema } from "./communication.validation.js";

/** Mounted at /api/admin/communication and /api/team/communication; the service applies client access. */
export const communicationRoutes = Router();

communicationRoutes.get("/threads", validate({ query: threadListQuerySchema }), controller.threads);
communicationRoutes.post("/threads", validate({ body: newThreadSchema }), controller.startThread);
communicationRoutes.get("/mentionable", validate({ query: mentionableQuerySchema }), controller.mentionable);
communicationRoutes.get("/threads/:id", validate({ params: idParam }), controller.thread);
communicationRoutes.post("/threads/:id/messages", validate({ params: idParam, body: replySchema }), controller.reply);
communicationRoutes.patch("/threads/:id/messages/:messageId", validate({ params: messageParam, body: replySchema }), controller.editMessage);
communicationRoutes.get("/meetings", validate({ query: meetingListQuerySchema }), controller.meetings);
communicationRoutes.post("/meetings", validate({ body: newMeetingSchema }), controller.schedule);
communicationRoutes.delete("/meetings/:id", validate({ params: idParam }), controller.cancelMeeting);
communicationRoutes.get("/meeting-requests", validate({ query: meetingRequestListQuerySchema }), controller.meetingRequests);
communicationRoutes.post("/meeting-requests/:id/schedule", validate({ params: idParam, body: newMeetingSchema }), controller.scheduleRequest);
communicationRoutes.post("/meeting-requests/:id/decline", validate({ params: idParam, body: declineRequestSchema }), controller.declineRequest);
