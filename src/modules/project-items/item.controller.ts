import type { Request, Response } from "express";
import { pipeline } from "node:stream/promises";
import type { StoredFile } from "../../utils/file-storage.js";
import { spaceOf } from "../projects/project-access.js";
import * as service from "./item.service.js";
import type { ListItemsQuery } from "./item.validation.js";

const p = (res: Response) => res.locals.params as { number: number; id?: number };

export const list = async (_req: Request, res: Response) => void res.json(await service.listItems(spaceOf(res), res.locals.query as ListItemsQuery));
export const get = async (_req: Request, res: Response) => void res.json(await service.getItem(spaceOf(res), p(res).number));
export const create = async (req: Request, res: Response) => void res.status(201).json(await service.createItem(req.user!, spaceOf(res), req.body));
export const update = async (req: Request, res: Response) => void res.json(await service.updateItem(req.user!, spaceOf(res), p(res).number, req.body));
export const move = async (req: Request, res: Response) => void res.json(await service.moveItem(req.user!, spaceOf(res), p(res).number, req.body));
export async function remove(req: Request, res: Response) {
  await service.deleteItem(req.user!, spaceOf(res), p(res).number);
  res.status(204).end();
}

export const activity = async (_req: Request, res: Response) => void res.json({ items: await service.getActivity(spaceOf(res), p(res).number) });
export const comments = async (_req: Request, res: Response) => void res.json({ items: await service.getComments(spaceOf(res), p(res).number) });
export const addComment = async (req: Request, res: Response) =>
  void res.status(201).json({ items: await service.addComment(req.user!, spaceOf(res), p(res).number, (req.body as { body: string }).body) });
export const editComment = async (req: Request, res: Response) =>
  void res.json({ items: await service.editComment(req.user!, spaceOf(res), p(res).number, p(res).id!, (req.body as { body: string }).body) });
export const deleteComment = async (req: Request, res: Response) => void res.json({ items: await service.deleteComment(req.user!, spaceOf(res), p(res).number, p(res).id!) });

export const addAttachment = async (req: Request, res: Response) => void res.status(201).json({ items: await service.addAttachment(req.user!, spaceOf(res), p(res).number, req.file!) });
export const deleteAttachment = async (req: Request, res: Response) => void res.json({ items: await service.deleteAttachment(req.user!, spaceOf(res), p(res).number, p(res).id!) });
export async function downloadAttachment(_req: Request, res: Response) {
  const { file, name } = (await service.openAttachment(spaceOf(res), p(res).number, p(res).id!)) as { file: StoredFile; name: string };
  res.setHeader("Cache-Control", "private, no-store");
  res.attachment(name);
  res.type(file.contentType);
  if (Number.isFinite(file.size)) res.setHeader("Content-Length", String(file.size));
  await pipeline(file.stream, res);
}
