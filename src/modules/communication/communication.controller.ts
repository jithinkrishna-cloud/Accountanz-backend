import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import * as service from "./communication.service.js";
import type { DeclineRequestInput, MeetingListQuery, MentionableQuery, MeetingRequestListQuery, MessageParam, NewMeetingInput, NewThreadInput, ReplyInput, ThreadListQuery } from "./communication.validation.js";

const id = (res: Response) => (res.locals.params as IdParam).id;

export const threads = async (req: Request, res: Response) => void res.json(await service.listThreads(req.user!, res.locals.query as ThreadListQuery));
export const thread = async (req: Request, res: Response) => void res.json(await service.getThread(req.user!, id(res)));
export const startThread = async (req: Request, res: Response) => void res.status(201).json(await service.startThread(req.user!, req.body as NewThreadInput));
export const reply = async (req: Request, res: Response) => {
  const b = req.body as ReplyInput;
  res.status(201).json(await service.reply(req.user!, id(res), b.body, b.mentions));
};
export const editMessage = async (req: Request, res: Response) => {
  const p = res.locals.params as MessageParam;
  const b = req.body as ReplyInput;
  res.json(await service.editMessage(req.user!, p.id, p.messageId, b.body, b.mentions));
};
export const mentionable = async (req: Request, res: Response) => {
  const q = res.locals.query as MentionableQuery;
  res.json({ items: await service.listMentionable(req.user!, q.client_id, q.visibility) });
};
export const meetings = async (req: Request, res: Response) => void res.json(await service.listMeetings(req.user!, res.locals.query as MeetingListQuery));
export const schedule = async (req: Request, res: Response) => void res.status(201).json(await service.scheduleMeeting(req.user!, req.body as NewMeetingInput));

export async function cancelMeeting(req: Request, res: Response) {
  await service.cancelMeeting(req.user!, id(res));
  res.status(204).end();
}

export const meetingRequests = async (req: Request, res: Response) => void res.json(await service.listMeetingRequests(req.user!, res.locals.query as MeetingRequestListQuery));
export const scheduleRequest = async (req: Request, res: Response) => void res.status(201).json(await service.scheduleFromRequest(req.user!, id(res), req.body as NewMeetingInput));

export async function declineRequest(req: Request, res: Response) {
  await service.declineMeetingRequest(req.user!, id(res), (req.body as DeclineRequestInput).reason);
  res.status(204).end();
}
