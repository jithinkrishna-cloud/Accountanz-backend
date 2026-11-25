import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import type { StoredFile } from "../../utils/file-storage.js";
import * as service from "./client-portal.service.js";
import * as clientService from "../clients/client.service.js";
import * as taskService from "../tasks/task.service.js";
import * as folderService from "../document-folders/document-folder.service.js";
import type { ClientContext } from "./client-portal.types.js";
import type { ClientUpdateInput } from "../clients/client.validation.js";
import type { PortalClientUpdateInput, UploadMeta } from "./client-portal.validation.js";
import { AppError } from "../../utils/app-error.js";

/** Set by the router's context middleware: the signed-in user's company. */
const ctx = (res: Response) => res.locals.client as ClientContext;
const idOf = (res: Response) => (res.locals.params as IdParam).id;

async function sendFile(res: Response, { file, name }: { file: StoredFile; name: string }) {
  res.setHeader("Cache-Control", "private, no-store");
  res.attachment(name);
  res.type(file.contentType);
  if (Number.isFinite(file.size)) res.setHeader("Content-Length", String(file.size));
  await pipeline(file.stream, res);
}

/** Works without a linked company: tells the frontend which state to show. */
export async function context(req: Request, res: Response) {
  const c = await service.findContext(req.user!);
  res.json({ company: c ? { id: c.clientId, name: c.clientName, status: c.clientStatus, role: c.role, can_approve: c.canApprove } : null });
}

export const dashboard = async (_req: Request, res: Response) => void res.json(await service.getDashboard(ctx(res)));
export const business = async (_req: Request, res: Response) => void res.json(await service.getBusiness(ctx(res)));
export const team = async (_req: Request, res: Response) => void res.json({ items: await service.getTeam(ctx(res)) });
export const teamMember = async (_req: Request, res: Response) => void res.json(await service.getMemberOverview(ctx(res), idOf(res)));
export const software = async (_req: Request, res: Response) => void res.json({ items: await service.getSoftware(ctx(res)) });
export const disconnectJournl = async (req: Request, res: Response) => void res.json({ items: await service.disconnectJournl(req.user!, ctx(res)) });

export const documents = async (_req: Request, res: Response) => void res.json({ items: await service.getDocuments(ctx(res)) });
export const requests = async (_req: Request, res: Response) => void res.json({ items: await service.getRequests(ctx(res)) });
export const reports = async (_req: Request, res: Response) => void res.json({ items: await service.getReports(ctx(res)) });
export const approvals = async (_req: Request, res: Response) => void res.json({ items: await service.getApprovals(ctx(res)) });
export const threads = async (_req: Request, res: Response) => void res.json({ items: await service.getThreads(ctx(res)) });
export const meetings = async (_req: Request, res: Response) => void res.json({ items: await service.getMeetings(ctx(res)) });
export const meetingRequests = async (_req: Request, res: Response) => void res.json({ items: await service.getMeetingRequests(ctx(res)) });
export const requestMeeting = async (req: Request, res: Response) => void res.status(201).json(await service.requestMeeting(req.user!, ctx(res), req.body));

export async function withdrawMeetingRequest(req: Request, res: Response) {
  await service.withdrawMeetingRequest(req.user!, ctx(res), idOf(res));
  res.status(204).end();
}
export const billing = async (_req: Request, res: Response) => void res.json(await service.getBilling(ctx(res)));
export const tasks = async (_req: Request, res: Response) => void res.json(await service.getTasks(ctx(res), (res.locals.query as { period?: string }).period));
// Document Centre folders (any depth) and moving files between them.
export const folders = async (_req: Request, res: Response) => void res.json({ items: await folderService.listFolders(ctx(res).clientId) });
export const createFolder = async (req: Request, res: Response) => void res.status(201).json(await folderService.createFolder(req.user!, ctx(res).clientId, req.body));
export const renameFolder = async (req: Request, res: Response) => void res.json(await folderService.renameFolder(req.user!, ctx(res).clientId, idOf(res), req.body));
export async function deleteFolder(req: Request, res: Response) {
  await folderService.deleteFolder(req.user!, ctx(res).clientId, idOf(res));
  res.status(204).end();
}
export const shareDocument = async (req: Request, res: Response) =>
  void res.json(await folderService.shareDocument(req.user!, ctx(res), idOf(res), (req.body as { user_ids: number[] }).user_ids));
export const shareFolder = async (req: Request, res: Response) =>
  void res.json(await folderService.shareFolder(req.user!, ctx(res), idOf(res), (req.body as { user_ids: number[] }).user_ids));
export const attachToRequest = async (req: Request, res: Response) =>
  void res.json(await service.attachExistingDocument(req.user!, ctx(res), idOf(res), (req.body as { document_id: number }).document_id));
export async function moveDocument(req: Request, res: Response) {
  await folderService.moveDocument(req.user!, ctx(res).clientId, idOf(res), req.body);
  res.status(204).end();
}

export const createTask =async (req: Request, res: Response) => void res.status(201).json(await taskService.createTaskForClient(req.user!, ctx(res), req.body));
export const settings = async (_req: Request, res: Response) => void res.json(await service.getSettings(ctx(res)));

export async function upload(req: Request, res: Response) {
  res.status(201).json(await service.uploadDocument(req.user!, ctx(res), res.locals.body as UploadMeta, req.file!));
}
export const downloadDocument = async (_req: Request, res: Response) => sendFile(res, await service.openDocument(ctx(res), idOf(res)));
export const downloadReport = async (_req: Request, res: Response) => sendFile(res, await service.openReport(ctx(res), idOf(res)));

export async function decideApproval(req: Request, res: Response) {
  await service.decideApproval(req.user!, ctx(res), idOf(res), req.body);
  res.status(204).end();
}

export const thread = async (_req: Request, res: Response) => void res.json(await service.getThread(ctx(res), idOf(res)));
export const startThread = async (req: Request, res: Response) => void res.status(201).json(await service.startThread(req.user!, ctx(res), req.body));
export const reply = async (req: Request, res: Response) => void res.status(201).json(await service.reply(req.user!, ctx(res), idOf(res), req.body.body, req.body.mentions));
export const editMessage = async (req: Request, res: Response) => {
  const p = res.locals.params as { id: number; messageId: number };
  res.json(await service.editMessage(req.user!, ctx(res), p.id, p.messageId, req.body.body, req.body.mentions));
};
export const mentionable =async (req: Request, res: Response) => void res.json({ items: await service.getMentionable(req.user!, ctx(res)) });
export const updateSettings = async (req: Request, res: Response) => void res.json(await service.updateSettings(ctx(res), req.body));

export async function updateClient(req: Request, res: Response) {
  const c = ctx(res);
  if (c.role !== "owner") throw AppError.forbidden("Only the company owner can change business details");
  // Body is already validated by portalClientUpdateSchema: only trade name, state and address survive.
  const input = req.body as PortalClientUpdateInput;
  if (Object.keys(input).length === 0) throw new AppError("VALIDATION_ERROR", "Nothing to update");
  await clientService.updateClient(req.user!, c.clientId, input as ClientUpdateInput);
  res.json(await service.getBusiness(c));
}

export const packages = async (_req: Request, res: Response) => void res.json(await service.getPackages(ctx(res)));
export const proposal = async (_req: Request, res: Response) => void res.json({ proposal: await service.getProposal(ctx(res)) });
export const acceptProposal = async (req: Request, res: Response) => void res.json({ proposal: await service.acceptProposal(req.user!, ctx(res)) });
export const choosePackage = async (req: Request, res: Response) => void res.json(await service.choosePackage(req.user!, ctx(res), idOf(res)));
