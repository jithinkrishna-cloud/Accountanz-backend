import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import * as service from "./communication.service.js";
import type { MeetingListQuery, NewMeetingInput, NewThreadInput, ReplyInput, ThreadListQuery } from "./communication.validation.js";

const id = (res: Response) => (res.locals.params as IdParam).id;

export const threads = async (req: Request, res: Response) => void res.json(await service.listThreads(req.user!, res.locals.query as ThreadListQuery));
export const thread = async (req: Request, res: Response) => void res.json(await service.getThread(req.user!, id(res)));
export const startThread = async (req: Request, res: Response) => void res.status(201).json(await service.startThread(req.user!, req.body as NewThreadInput));
export const reply = async (req: Request, res: Response) => void res.status(201).json(await service.reply(req.user!, id(res), (req.body as ReplyInput).body));
export const meetings = async (req: Request, res: Response) => void res.json(await service.listMeetings(req.user!, res.locals.query as MeetingListQuery));
export const schedule = async (req: Request, res: Response) => void res.status(201).json(await service.scheduleMeeting(req.user!, req.body as NewMeetingInput));

export async function cancelMeeting(req: Request, res: Response) {
  await service.cancelMeeting(req.user!, id(res));
  res.status(204).end();
}
