import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import * as service from "./onboarding.service.js";
import type { OnboardingListQuery } from "./onboarding.validation.js";

const id = (res: Response) => (res.locals.params as IdParam).id;

export async function list(_req: Request, res: Response) {
  res.json(await service.listCases(res.locals.query as OnboardingListQuery));
}

export async function get(_req: Request, res: Response) {
  res.json(await service.getCase(id(res)));
}

export async function create(req: Request, res: Response) {
  res.status(201).json(await service.createProspect(req.user!, req.body));
}

export async function saveAssessment(req: Request, res: Response) {
  res.json(await service.saveAssessment(req.user!, id(res), req.body));
}

export async function changeStage(req: Request, res: Response) {
  res.json(await service.changeStage(req.user!, id(res), req.body));
}
