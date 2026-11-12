import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import * as service from "./assignment.service.js";
import type { AssignmentListQuery } from "./assignment.validation.js";

const id = (res: Response) => (res.locals.params as IdParam).id;

export async function list(_req: Request, res: Response) {
  res.json(await service.listAssignments(res.locals.query as AssignmentListQuery));
}

export async function options(_req: Request, res: Response) {
  res.json(await service.assignmentOptions());
}

export async function get(_req: Request, res: Response) {
  res.json(await service.getAssignment(id(res)));
}

export async function create(req: Request, res: Response) {
  res.status(201).json(await service.createAssignment(req.user!, req.body));
}

export async function update(req: Request, res: Response) {
  res.json(await service.updateAssignment(req.user!, id(res), req.body));
}

export async function end(req: Request, res: Response) {
  res.json(await service.endAssignment(req.user!, id(res)));
}
