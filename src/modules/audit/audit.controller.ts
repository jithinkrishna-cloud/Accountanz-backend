import type { Request, Response } from "express";
import type { ListQuery } from "../../utils/pagination.js";
import { listAuditLogs } from "./audit.repository.js";

export async function list(_req: Request, res: Response) {
  res.json(await listAuditLogs(res.locals.query as ListQuery));
}
