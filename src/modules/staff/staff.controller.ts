import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import * as service from "./staff.service.js";
import type { StaffListQuery } from "./staff.validation.js";

export async function list(_req: Request, res: Response) {
  res.json(await service.listStaff(res.locals.query as StaffListQuery));
}

export async function get(_req: Request, res: Response) {
  res.json(await service.getStaff((res.locals.params as IdParam).id));
}

export async function invite(req: Request, res: Response) {
  res.status(201).json(await service.inviteStaff(req.user!, req.body));
}

export async function resendInvite(req: Request, res: Response) {
  res.json(await service.resendInvite(req.user!, (res.locals.params as IdParam).id));
}

export async function remove(req: Request, res: Response) {
  await service.deleteStaff(req.user!, (res.locals.params as IdParam).id);
  res.status(204).end();
}

export async function update(req: Request, res: Response) {
  res.json(await service.updateStaff(req.user!, (res.locals.params as IdParam).id, req.body));
}
