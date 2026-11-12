import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import type { ListQuery } from "../../utils/pagination.js";
import * as service from "./knowledge.service.js";

export async function list(_req: Request, res: Response) {
  res.json(await service.listArticles(res.locals.query as ListQuery));
}

export async function create(req: Request, res: Response) {
  res.status(201).json(await service.createArticle(req.user!, req.body));
}

export async function update(req: Request, res: Response) {
  res.json(await service.updateArticle(req.user!, (res.locals.params as IdParam).id, req.body));
}

export async function remove(req: Request, res: Response) {
  await service.deleteArticle(req.user!, (res.locals.params as IdParam).id);
  res.status(204).end();
}
