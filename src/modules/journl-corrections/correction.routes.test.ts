import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalRole } from "../../types/auth.types.js";

/**
 * Route wiring only (service mocked): who reaches the correction paths, and that mounting them before the team
 * guard leaves every other team route's access unchanged. Runs on a loopback port; no DB, no JournL.
 */

const m = vi.hoisted(() => ({
  list: vi.fn(),
  createDraft: vi.fn(),
  awaitingMyApproval: vi.fn(),
  reject: vi.fn(),
  checkJournl: vi.fn(),
  resolveManually: vi.fn(),
  prepareAgain: vi.fn(),
  dashboard: vi.fn(),
  approveAndPost: vi.fn(),
  post: vi.fn(),
}));

vi.mock("../../middleware/authenticate.js", () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const role = req.headers["x-test-role"] as PortalRole | undefined;
    if (role) req.user = { id: 7, email: "t@x.in", fullName: "T", role };
    next();
  },
}));
vi.mock("./correction.service.js", () => ({
  list: m.list,
  createDraft: m.createDraft,
  awaitingMyApproval: m.awaitingMyApproval,
  reject: m.reject,
  checkJournl: m.checkJournl,
  resolveManually: m.resolveManually,
  prepareAgain: m.prepareAgain,
  preview: vi.fn(),
  get: vi.fn(),
  updateDraft: vi.fn(),
  submit: vi.fn(),
  sendBack: vi.fn(),
}));
vi.mock("../workspace/workspace.service.js", () => ({ dashboard: m.dashboard }));
vi.mock("./correction.posting.js", () => ({ approveAndPost: m.approveAndPost, post: m.post }));

const { teamRoutes } = await import("../team.routes.js");
const { errorHandler } = await import("../../middleware/error-handler.js");

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/team", teamRoutes);
  app.use(errorHandler);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/team/workspace`;
});
afterAll(() => new Promise((r) => server.close(r)));

beforeEach(() => {
  vi.clearAllMocks();
  m.list.mockResolvedValue([]);
  m.awaitingMyApproval.mockResolvedValue({ count: 0, items: [] });
  m.reject.mockResolvedValue({ id: 1 });
  m.dashboard.mockResolvedValue({ ok: true });
});

const call = (path: string, role: PortalRole | null, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(role ? { "x-test-role": role } : {}), ...(init.headers ?? {}) } });

describe("correction routes", () => {
  it.each<PortalRole>(["bookkeeper", "finance_manager", "cfo", "super_admin"])("%s reaches the list and the reviewer queue", async (role) => {
    expect((await call("/clients/42/journl/corrections", role)).status).toBe(200);
    expect(m.list).toHaveBeenCalledWith(expect.objectContaining({ role }), 42);
    expect((await call("/journl/corrections/awaiting", role)).status).toBe(200);
  });

  it.each<PortalRole>(["ops_admin", "client_owner"])("%s is refused (403)", async (role) => {
    expect((await call("/clients/42/journl/corrections", role)).status).toBe(403);
    expect((await call("/journl/corrections/awaiting", role)).status).toBe(403);
    expect(m.list).not.toHaveBeenCalled();
  });

  it("reject needs a comment (400 before the service)", async () => {
    const res = await call("/clients/42/journl/corrections/5/reject", "finance_manager", { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(400);
    expect(m.reject).not.toHaveBeenCalled();
    expect((await call("/clients/42/journl/corrections/5/reject", "finance_manager", { method: "POST", body: JSON.stringify({ comment: "No" }) })).status).toBe(200);
    expect(m.reject).toHaveBeenCalledWith(expect.anything(), 5, "No", expect.anything(), 42);
  });

  it("a draft body without a kind is a 400", async () => {
    const res = await call("/clients/42/journl/corrections", "bookkeeper", { method: "POST", body: JSON.stringify({ reason: "x" }) });
    expect(res.status).toBe(400);
    expect(m.createDraft).not.toHaveBeenCalled();
  });

  it("parses a journal body into the service input (rupees → paise, branch id)", async () => {
    m.createDraft.mockResolvedValue({ id: 1 });
    const body = { kind: "journal_entry", branch_id: "5", voucher_date: "2026-11-01", reason: " Reclass ", lines: [{ ledger_id: 10, side: "dr", amount: "100.50" }, { ledger_id: 11, side: "cr", amount: 100.5 }] };
    expect((await call("/clients/42/journl/corrections", "bookkeeper", { method: "POST", body: JSON.stringify(body) })).status).toBe(201);
    expect(m.createDraft.mock.calls[0][2]).toEqual({
      kind: "journal_entry",
      purpose: "correction",
      reason: "Reclass",
      branch_id: 5,
      journal: { voucher_date: "2026-11-01", lines: [{ ledger_id: 10, ledger_name: "", side: "dr", amount_paise: 10050 }, { ledger_id: 11, ledger_name: "", side: "cr", amount_paise: 10050 }] },
    });
  });

  it("a Suspense body never carries an amount or side", async () => {
    m.createDraft.mockResolvedValue({ id: 1 });
    const body = { kind: "opening_balance", purpose: "unresolved_tb_difference", ledger_id: 30, reason: "Old books", amount: "999", side: "cr" };
    expect((await call("/clients/42/journl/corrections", "bookkeeper", { method: "POST", body: JSON.stringify(body) })).status).toBe(201);
    expect(m.createDraft.mock.calls[0][2]).toEqual({ kind: "opening_balance", purpose: "unresolved_tb_difference", reason: "Old books", ledger_id: 30 });
  });

  it("check / resolve / prepare-again are wired with ids, body and role access", async () => {
    m.checkJournl.mockResolvedValue({ found: false });
    m.resolveManually.mockResolvedValue({ id: 5 });
    m.prepareAgain.mockResolvedValue({ id: 9 });
    const p = "/clients/42/journl/corrections/5";
    expect((await call(`${p}/check`, "finance_manager", { method: "POST" })).status).toBe(200);
    expect(m.checkJournl).toHaveBeenCalledWith(expect.objectContaining({ role: "finance_manager" }), 5, expect.anything(), 42);
    expect((await call(`${p}/check`, "ops_admin", { method: "POST" })).status).toBe(403);
    expect((await call(`${p}/resolve`, "finance_manager", { method: "POST", body: JSON.stringify({ to: "posted" }) })).status).toBe(400);
    expect((await call(`${p}/resolve`, "finance_manager", { method: "POST", body: JSON.stringify({ to: "maybe", note: "x" }) })).status).toBe(400);
    expect(m.resolveManually).not.toHaveBeenCalled();
    expect((await call(`${p}/resolve`, "super_admin", { method: "POST", body: JSON.stringify({ to: "posted", note: " Saw it ", voucher_id: 77 }) })).status).toBe(200);
    expect(m.resolveManually).toHaveBeenCalledWith(expect.anything(), 5, "posted", "Saw it", "77", expect.anything(), 42);
    expect((await call(`${p}/prepare-again`, "bookkeeper", { method: "POST" })).status).toBe(201);
    expect(m.prepareAgain).toHaveBeenCalledWith(expect.anything(), 5, expect.anything(), 42);
    expect((await call(`${p}/prepare-again`, "ops_admin", { method: "POST" })).status).toBe(403);
  });

  it("approve (optional comment) and post are wired; super_admin reaches them, ops_admin never", async () => {
    m.approveAndPost.mockResolvedValue({ id: 5, status: "posted" });
    m.post.mockResolvedValue({ id: 5, status: "approved", message: "Waiting for the owner to refresh JournL" });
    const p = "/clients/42/journl/corrections/5";
    expect((await call(`${p}/approve`, "finance_manager", { method: "POST" })).status).toBe(200);
    expect(m.approveAndPost).toHaveBeenLastCalledWith(expect.objectContaining({ role: "finance_manager" }), 5, undefined, expect.anything(), 42);
    expect((await call(`${p}/approve`, "super_admin", { method: "POST", body: JSON.stringify({ comment: " Fine " }) })).status).toBe(200);
    expect(m.approveAndPost).toHaveBeenLastCalledWith(expect.objectContaining({ role: "super_admin" }), 5, "Fine", expect.anything(), 42);
    expect((await call(`${p}/approve`, "cfo", { method: "POST", body: JSON.stringify({ comment: "   " }) })).status).toBe(200);
    expect(m.approveAndPost).toHaveBeenLastCalledWith(expect.anything(), 5, undefined, expect.anything(), 42);
    expect((await call(`${p}/approve`, "cfo", { method: "POST", body: JSON.stringify({ comment: "x".repeat(1001) }) })).status).toBe(400);
    const res = await call(`${p}/post`, "bookkeeper", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ message: "Waiting for the owner to refresh JournL" });
    expect(m.post).toHaveBeenCalledWith(expect.objectContaining({ role: "bookkeeper" }), 5, expect.anything(), 42);
    expect((await call(`${p}/post`, "super_admin", { method: "POST" })).status).toBe(200);
    m.approveAndPost.mockClear();
    m.post.mockClear();
    expect((await call(`${p}/approve`, "ops_admin", { method: "POST" })).status).toBe(403);
    expect((await call(`${p}/post`, "ops_admin", { method: "POST" })).status).toBe(403);
    expect((await call(`${p}/post`, "client_owner", { method: "POST" })).status).toBe(403);
    expect(m.approveAndPost).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
  });

  it("other team routes keep their access: super_admin still can't reach the workspace dashboard", async () => {
    expect((await call("/dashboard", "super_admin")).status).toBe(403);
    expect((await call("/dashboard", "bookkeeper")).status).toBe(200);
  });
});
