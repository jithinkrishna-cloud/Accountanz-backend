import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import * as service from "./task.service.js";
import type { GenerateTasksInput, TaskListQuery } from "./task.validation.js";

/** Shared by the admin and accountant portals; the service enforces each role's permissions. */
const idOf = (res: Response) => (res.locals.params as IdParam).id;

export async function list(_req: Request, res: Response) {
  res.json(await service.listTasks(res.locals.query as TaskListQuery));
}

export async function listForStaff(req: Request, res: Response) {
  res.json(await service.listTasksForStaff(req.user!, res.locals.query as TaskListQuery));
}

export async function options(req: Request, res: Response) {
  res.json(await service.getTaskOptions(req.user!, (res.locals.query as { client_id?: number }).client_id));
}

export async function get(req: Request, res: Response) {
  res.json(await service.getTaskDetail(req.user!, idOf(res)));
}

export async function create(req: Request, res: Response) {
  res.status(201).json(await service.createTask(req.user!, req.body));
}

export async function update(req: Request, res: Response) {
  res.json(await service.updateTask(req.user!, idOf(res), req.body));
}

export async function checklist(req: Request, res: Response) {
  res.json(await service.updateChecklist(req.user!, idOf(res), req.body.done));
}

export async function logWork(req: Request, res: Response) {
  res.status(201).json(await service.logWork(req.user!, idOf(res), req.body));
}

export async function submit(req: Request, res: Response) {
  res.json(await service.submitTask(req.user!, idOf(res)));
}

export async function generate(req: Request, res: Response) {
  res.status(201).json(await service.generateTasks(req.user!, (req.body as GenerateTasksInput).period));
}
