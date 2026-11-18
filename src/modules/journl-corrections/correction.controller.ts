import type { Request, Response } from "express";
import { z } from "zod";
import { requestContext } from "../audit/journl-read-audit.js";
import * as posting from "./correction.posting.js";
import * as service from "./correction.service.js";
import type { CorrectionInput } from "./correction.service.js";
import { journalCorrectionSchema, openingCorrectionSchema, suspenseCorrectionSchema } from "./correction.validation.js";

// ───────────── Request schemas ─────────────

export const clientParams = z.object({ id: z.coerce.number().int().positive() });
export const correctionParams = z.object({ id: z.coerce.number().int().positive(), cid: z.coerce.number().int().positive() });
export const commentBody = z.object({
  comment: z.string({ message: "A comment is required" }).trim().min(1, "A comment is required").max(1000, "Keep the comment under 1000 characters"),
});

export const resolveBody = z.object({
  to: z.enum(["posted", "rejected"], { message: "Choose posted or rejected" }),
  note: z.string({ message: "A note is required" }).trim().min(1, "A note is required").max(1000, "Keep the note under 1000 characters"),
  voucher_id: z.union([z.string(), z.number()]).transform((v) => String(v).trim()).pipe(z.string().min(1).max(64)).optional(),
});

const head = z.object({
  kind: z.enum(["journal_entry", "opening_balance"], { message: "Choose what to correct" }),
  purpose: z.enum(["correction", "unresolved_tb_difference"]).default("correction"),
});
const branchId = z.object({
  branch_id: z.union([z.number(), z.string().regex(/^\d+$/)], { message: "Choose a branch" }).transform(Number).pipe(z.number().int().positive("Choose a branch")),
});

/** Copies a sub-schema's issues onto the outer parse so `validate` reports them per field. */
function parseInto<T>(schema: z.ZodType<T>, raw: unknown, ctx: z.RefinementCtx): T | typeof z.NEVER {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  for (const i of r.error.issues) ctx.addIssue({ code: "custom", path: i.path as (string | number)[], message: i.message });
  return z.NEVER;
}

/**
 * A correction as the preparer sends it (flat body):
 *  - journal entry: `{ kind: "journal_entry", branch_id, voucher_date, lines, reason }`
 *  - opening balance: `{ kind: "opening_balance", ledger_id, amount, side, reason }`
 *  - unresolved difference: `{ kind: "opening_balance", purpose: "unresolved_tb_difference", ledger_id, reason }`
 *    (amount and side are never accepted; they come from the books)
 */
export const correctionInputSchema = z.unknown().transform((raw, ctx): CorrectionInput => {
  const h = parseInto(head, raw, ctx);
  if (h === z.NEVER) return z.NEVER;
  if (h.kind === "journal_entry") {
    if (h.purpose !== "correction") {
      ctx.addIssue({ code: "custom", path: ["purpose"], message: "An unresolved difference is adjusted on a Suspense ledger's opening balance" });
      return z.NEVER;
    }
    const b = parseInto(branchId, raw, ctx);
    const j = parseInto(journalCorrectionSchema, raw, ctx);
    if (b === z.NEVER || j === z.NEVER) return z.NEVER;
    return { kind: "journal_entry", purpose: "correction", reason: j.reason, branch_id: b.branch_id, journal: { voucher_date: j.voucher_date, lines: j.lines } };
  }
  if (h.purpose === "unresolved_tb_difference") {
    const s = parseInto(suspenseCorrectionSchema, raw, ctx);
    if (s === z.NEVER) return z.NEVER;
    return { kind: "opening_balance", purpose: "unresolved_tb_difference", reason: s.reason, ledger_id: s.ledger_id };
  }
  const o = parseInto(openingCorrectionSchema, raw, ctx);
  if (o === z.NEVER) return z.NEVER;
  return { kind: "opening_balance", purpose: "correction", reason: o.reason, opening: { ledger_id: o.ledger_id, ledger_name: o.ledger_name, amount_paise: o.amount_paise, side: o.side } };
});

type ClientParams = z.infer<typeof clientParams>;
type CorrectionParams = z.infer<typeof correctionParams>;
type CommentBody = z.infer<typeof commentBody>;
type ResolveBody = z.infer<typeof resolveBody>;

// ───────────── Handlers ─────────────

const clientOf = (res: Response) => (res.locals.params as ClientParams).id;
const ids = (res: Response) => res.locals.params as CorrectionParams;

export const list = async (req: Request, res: Response) => void res.json({ items: await service.list(req.user!, clientOf(res)) });

export const lookupLedgers = async (req: Request, res: Response) =>
  void res.json({ items: await service.lookupLedgers(req.user!, clientOf(res), String(req.query.q ?? "").slice(0, 100)) });
export const lookupBranches = async (req: Request, res: Response) => void res.json({ items: await service.lookupBranches(req.user!, clientOf(res)) });

export const preview = async (req: Request, res: Response) => void res.json(await service.preview(req.user!, clientOf(res), req.body as CorrectionInput));

export const create = async (req: Request, res: Response) =>
  void res.status(201).json(await service.createDraft(req.user!, clientOf(res), req.body as CorrectionInput, requestContext(req)));

export const get = async (req: Request, res: Response) => {
  const p = ids(res);
  res.json(await service.get(req.user!, p.cid, p.id));
};

export const update = async (req: Request, res: Response) => {
  const p = ids(res);
  res.json(await service.updateDraft(req.user!, p.cid, req.body as CorrectionInput, requestContext(req), p.id));
};

export const submit = async (req: Request, res: Response) => {
  const p = ids(res);
  res.json(await service.submit(req.user!, p.cid, requestContext(req), p.id));
};

export const sendBack = async (req: Request, res: Response) => {
  const p = ids(res);
  res.json(await service.sendBack(req.user!, p.cid, (req.body as CommentBody).comment, requestContext(req), p.id));
};

export const reject = async (req: Request, res: Response) => {
  const p = ids(res);
  res.json(await service.reject(req.user!, p.cid, (req.body as CommentBody).comment, requestContext(req), p.id));
};

export const awaiting = async (req: Request, res: Response) => void res.json(await service.awaitingMyApproval(req.user!));

export const check = async (req: Request, res: Response) => {
  const p = ids(res);
  res.json(await service.checkJournl(req.user!, p.cid, requestContext(req), p.id));
};

export const resolve = async (req: Request, res: Response) => {
  const p = ids(res);
  const b = req.body as ResolveBody;
  res.json(await service.resolveManually(req.user!, p.cid, b.to, b.note, b.voucher_id, requestContext(req), p.id));
};

export const prepareAgain = async (req: Request, res: Response) => {
  const p = ids(res);
  res.status(201).json(await service.prepareAgain(req.user!, p.cid, requestContext(req), p.id));
};

// ───────────── Task 8: approve and post (the only paths that write to JournL) ─────────────

/** Approve-and-post takes an optional comment (blank = none). */
export const approveBody = z.object({
  comment: z.string().trim().max(1000, "Keep the comment under 1000 characters").optional(),
});
type ApproveBody = z.infer<typeof approveBody>;

export const approve = async (req: Request, res: Response) => {
  const p = ids(res);
  const c = (req.body as ApproveBody).comment;
  res.json(await posting.approveAndPost(req.user!, p.cid, c ? c : undefined, requestContext(req), p.id));
};

export const post = async (req: Request, res: Response) => {
  const p = ids(res);
  res.json(await posting.post(req.user!, p.cid, requestContext(req), p.id));
};
