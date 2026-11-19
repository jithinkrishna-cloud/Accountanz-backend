import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../../../utils/crypto.js";
import { AppError } from "../../../utils/app-error.js";

const KEY = vi.hoisted(() => Buffer.alloc(32, 5).toString("base64"));
vi.mock("../../../config/env.js", async (orig) => {
  const real = await orig<typeof import("../../../config/env.js")>();
  return { ...real, env: { ...real.env, BIZPOLE_TOKEN_KEY: KEY } };
});

const m = vi.hoisted(() => ({
  conn: { tag: "conn" },
  repo: {
    findByClient: vi.fn(),
    lockByClient: vi.fn(),
    clientGstin: vi.fn(),
    companyTakenBy: vi.fn(),
    saveNewGrant: vi.fn(),
    setCompany: vi.fn(),
    markDisconnected: vi.fn(),
    markError: vi.fn(),
    touchHealthy: vi.fn(),
  },
  getJson: vi.fn(),
  revokeGrant: vi.fn(),
  configured: vi.fn(() => true),
  exchangeCode: vi.fn(),
  accessTokenFor: vi.fn(),
  recordAudit: vi.fn(),
  requireClientAccess: vi.fn(),
}));
vi.mock("../../../database/connection.js", () => ({ withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(m.conn) }));
vi.mock("./bizpole.repository.js", () => m.repo);
vi.mock("./bizpole.client.js", async (orig) => {
  const real = await orig<typeof import("./bizpole.client.js")>();
  return { ...real, getJson: m.getJson, revokeGrant: m.revokeGrant, bizpoleConfigured: m.configured };
});
vi.mock("./bizpole.token.service.js", async (orig) => {
  const real = await orig<typeof import("./bizpole.token.service.js")>();
  return { ...real, exchangeCode: m.exchangeCode, accessTokenFor: m.accessTokenFor };
});
vi.mock("../../audit/audit.service.js", () => ({ recordAudit: m.recordAudit }));
vi.mock("../../access/client-access.js", () => ({ requireClientAccess: m.requireClientAccess }));

const { BizpoleApiError } = await import("./bizpole.client.js");
const svc = await import("./bizpole.service.js");

const owner = { id: 50, email: "owner@abc.in", role: "client_owner" } as never;
const ownerCtx = { userId: 50, clientId: 1, clientName: "ABC", clientStatus: "active", role: "owner", canApprove: true } as never;
const memberCtx = { userId: 51, clientId: 1, clientName: "ABC", clientStatus: "active", role: "member", canApprove: false } as never;
const staff = { id: 9, email: "arun@accountanz.in", role: "bookkeeper" } as never;
const reqCtx = { requestId: "req-1", ipAddress: "127.0.0.1", endpoint: "GET /api/team/workspace/clients/1/bizpole/accounts" };

const TOKENS = { access_token: "acc", token_type: "Bearer", expires_in: 900, refresh_token: "ref-0123456789abcdefghij", grant_id: "g-1", companies: [201] };
const C201 = { id: "201", name: "ABC Traders", gstin: "32ABCDE1234F1Z5" };
const C202 = { id: "202", name: "ABC Retail", gstin: null };

beforeEach(() => {
  vi.clearAllMocks();
  m.configured.mockReturnValue(true);
  m.repo.findByClient.mockResolvedValue(null);
  m.repo.lockByClient.mockResolvedValue(null);
  m.repo.clientGstin.mockResolvedValue("32ABCDE1234F1Z5");
  m.repo.companyTakenBy.mockResolvedValue(null);
  m.repo.saveNewGrant.mockResolvedValue(11);
  m.revokeGrant.mockResolvedValue(true);
  m.exchangeCode.mockResolvedValue(TOKENS);
  m.requireClientAccess.mockResolvedValue(undefined);
  m.accessTokenFor.mockResolvedValue("acc");
});

describe("connect (owner pastes a connection code)", () => {
  it("only the owner can connect; the code is not spent otherwise", async () => {
    await expect(svc.connect(owner, memberCtx, { code: "BPC-X" })).rejects.toMatchObject({ status: 403 });
    expect(m.exchangeCode).not.toHaveBeenCalled();
  });

  it("already connected: refused before the single-use code is exchanged", async () => {
    m.repo.findByClient.mockResolvedValue({ id: 11, status: "connected" });
    await expect(svc.connect(owner, ownerCtx, { code: "BPC-X" })).rejects.toMatchObject({ status: 409 });
    expect(m.exchangeCode).not.toHaveBeenCalled();
  });

  it("one shared company with a matching GSTIN connects at once, for the caller's own client only", async () => {
    m.getJson.mockResolvedValue({ data: [C201] });
    await svc.connect(owner, ownerCtx, { code: "BPC-X" });
    const [clientId, existingId, sealed, state, ownerId] = m.repo.saveNewGrant.mock.calls[0]!;
    expect(clientId).toBe(1);
    expect(existingId).toBeNull();
    expect(state).toEqual({ status: "connected", company: C201 });
    expect(ownerId).toBe(50);
    expect(sealed.accessEnc).not.toContain("acc");
    expect(m.revokeGrant).not.toHaveBeenCalled();
    expect(m.recordAudit).toHaveBeenCalledWith(owner, expect.objectContaining({ action: "Bizpole Books connected" }), m.conn);
    expect(JSON.stringify(m.recordAudit.mock.calls)).not.toContain(TOKENS.refresh_token);
  });

  it("several companies: pending with only the companies in the grant", async () => {
    m.exchangeCode.mockResolvedValue({ ...TOKENS, companies: [201, 202] });
    m.getJson.mockResolvedValue({ data: [C201, C202, { id: "999", name: "Not shared", gstin: null }] });
    await svc.connect(owner, ownerCtx, { code: "BPC-X" });
    expect(m.repo.saveNewGrant.mock.calls[0]![3]).toEqual({ status: "pending", companies: [C201, C202] });
  });

  it("GSTIN mismatch blocks the link and gives the grant back to Bizpole", async () => {
    m.repo.clientGstin.mockResolvedValue("29ZZZZZ9999Z1Z9");
    m.getJson.mockResolvedValue({ data: [C201] });
    await expect(svc.connect(owner, ownerCtx, { code: "BPC-X" })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/GSTIN/) });
    expect(m.repo.saveNewGrant).not.toHaveBeenCalled();
    expect(m.revokeGrant).toHaveBeenCalledWith(TOKENS.refresh_token);
  });

  it("a company already linked to another Accountanz client is refused (and the grant revoked)", async () => {
    m.getJson.mockResolvedValue({ data: [C201] });
    m.repo.companyTakenBy.mockResolvedValue({ client_id: 2 });
    await expect(svc.connect(owner, ownerCtx, { code: "BPC-X" })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/another Accountanz client/) });
    expect(m.revokeGrant).toHaveBeenCalledWith(TOKENS.refresh_token);
  });

  it("reconnecting over an 'error' row revokes the grant it replaces", async () => {
    const oldRefresh = "old-ref-0123456789abcdefghij";
    m.repo.findByClient.mockResolvedValue({ id: 11, status: "error" });
    m.repo.lockByClient.mockResolvedValue({ id: 11, status: "error", refresh_token_enc: encryptSecret(oldRefresh, KEY) });
    m.getJson.mockResolvedValue({ data: [C201] });
    await svc.connect(owner, ownerCtx, { code: "BPC-X" });
    expect(m.repo.saveNewGrant.mock.calls[0]![1]).toBe(11);
    expect(m.revokeGrant).toHaveBeenCalledWith(oldRefresh);
    expect(m.revokeGrant).not.toHaveBeenCalledWith(TOKENS.refresh_token);
  });
});

describe("selectCompany", () => {
  const pending = { id: 11, status: "pending", available_companies: [C201, C202] };

  it("only a company from this grant can be chosen", async () => {
    m.repo.lockByClient.mockResolvedValue(pending);
    await expect(svc.selectCompany(owner, ownerCtx, { company_id: "999" })).rejects.toMatchObject({ status: 400 });
    expect(m.repo.setCompany).not.toHaveBeenCalled();
  });

  it("connects the chosen company", async () => {
    m.repo.lockByClient.mockResolvedValue(pending);
    m.repo.clientGstin.mockResolvedValue(null);
    await svc.selectCompany(owner, ownerCtx, { company_id: "202" });
    expect(m.repo.setCompany).toHaveBeenCalledWith(11, C202, m.conn);
  });

  it("GSTIN mismatch on the chosen company is refused; the choice stays open", async () => {
    m.repo.lockByClient.mockResolvedValue({ ...pending, available_companies: JSON.stringify([{ ...C201, gstin: "29ZZZZZ9999Z1Z9" }]) });
    await expect(svc.selectCompany(owner, ownerCtx, { company_id: "201" })).rejects.toMatchObject({ status: 409 });
    expect(m.repo.setCompany).not.toHaveBeenCalled();
  });

  it("members can't choose", async () => {
    await expect(svc.selectCompany(owner, memberCtx, { company_id: "201" })).rejects.toMatchObject({ status: 403 });
  });
});

describe("disconnect", () => {
  it("drops the tokens, then revokes the grant at Bizpole with the stored refresh token", async () => {
    m.repo.lockByClient.mockResolvedValue({ id: 11, status: "connected", refresh_token_enc: encryptSecret("stored-ref-0123456789abcdef", KEY) });
    const r = await svc.disconnect(owner, ownerCtx);
    expect(m.repo.markDisconnected).toHaveBeenCalledWith(11, m.conn);
    expect(m.revokeGrant).toHaveBeenCalledWith("stored-ref-0123456789abcdef");
    expect(r.revoked_at_bizpole).toBe(true);
  });

  it("reports when Bizpole couldn't confirm the revoke", async () => {
    m.repo.lockByClient.mockResolvedValue({ id: 11, status: "connected", refresh_token_enc: encryptSecret("stored-ref-0123456789abcdef", KEY) });
    m.revokeGrant.mockResolvedValue(false);
    expect((await svc.disconnect(owner, ownerCtx)).revoked_at_bizpole).toBe(false);
  });

  it("members can't disconnect", async () => {
    await expect(svc.disconnect(owner, memberCtx)).rejects.toMatchObject({ status: 403 });
    expect(m.repo.markDisconnected).not.toHaveBeenCalled();
  });
});

describe("view", () => {
  it("never exposes tokens or the grant id", async () => {
    m.repo.findByClient.mockResolvedValue({
      id: 11, status: "connected", external_org_id: "201", external_org_name: "ABC Traders", external_gstin: C201.gstin, grant_id: "g-secret-grant",
      access_token_enc: "sealed-access", refresh_token_enc: "sealed-refresh", token_expires_at: "2026-11-19 10:00:00", available_companies: null,
      authorized_at: "2026-11-19 09:00:00", last_health_check: null, last_error: null,
    });
    const text = JSON.stringify(await svc.view(1));
    for (const secret of ["g-secret-grant", "sealed-access", "sealed-refresh"]) expect(text).not.toContain(secret);
    expect(text).toContain("ABC Traders");
  });
});

describe("gstinRule", () => {
  it("blocks only when both exist and differ; warns when only one side has one", () => {
    expect(svc.gstinRule("32ABCDE1234F1Z5", " 32abcde1234f1z5 ")).toEqual({ block: null, warning: null });
    expect(svc.gstinRule("32ABCDE1234F1Z5", "29ZZZZZ9999Z1Z9").block).toMatch(/doesn't match/);
    expect(svc.gstinRule("32ABCDE1234F1Z5", null).warning).toMatch(/no GSTIN/);
    expect(svc.gstinRule(null, "32ABCDE1234F1Z5").warning).toMatch(/no GSTIN in Accountanz/);
    expect(svc.gstinRule(null, null)).toEqual({ block: null, warning: null });
  });
});

describe("staffRead (tenant isolation, audit, paging)", () => {
  const connected = { id: 11, status: "connected", external_org_id: "201" };

  it("staff not on the client: 404, audited as denied, nothing sent to Bizpole", async () => {
    m.requireClientAccess.mockRejectedValue(AppError.notFound("Client"));
    await expect(svc.staffRead(staff, 1, "accounts", {}, reqCtx)).rejects.toMatchObject({ status: 404 });
    expect(m.getJson).not.toHaveBeenCalled();
    expect(m.recordAudit).toHaveBeenCalledWith(staff, expect.objectContaining({ action: "Bizpole Books data access denied", outcome: "denied", clientId: 1 }));
  });

  it("reads only the company linked to this client and joins every page", async () => {
    m.repo.findByClient.mockResolvedValue(connected);
    m.getJson
      .mockResolvedValueOnce({ data: [{ id: "1" }, { id: "2" }], hasMore: true, nextCursor: "c1" })
      .mockResolvedValueOnce({ data: [{ id: "3" }], hasMore: false, nextCursor: null });
    const r = await svc.staffRead(staff, 1, "accounts", {}, reqCtx);
    expect(r.data).toEqual([{ id: "1" }, { id: "2" }, { id: "3" }]);
    expect(r.pages).toBe(2);
    expect(m.getJson.mock.calls[0]!.slice(1)).toEqual(["conn:11", "companies/201/accounts", { limit: "1000" }]);
    expect(m.getJson.mock.calls[1]![3]).toEqual({ limit: "1000", cursor: "c1" });
    expect(m.recordAudit).toHaveBeenCalledWith(staff, expect.objectContaining({ action: "Bizpole Books data viewed", outcome: "success", entityId: "accounts" }));
    expect(m.repo.touchHealthy).toHaveBeenCalledWith(11);
  });

  it("passes on only the parameters Bizpole documents for that resource", async () => {
    m.repo.findByClient.mockResolvedValue(connected);
    m.getJson.mockResolvedValue({ data: [], hasMore: false, nextCursor: null });
    await svc.staffRead(staff, 1, "vouchers", { from: "2026-04-01", to: "2026-04-30", companyId: "999", foo: "x" }, reqCtx);
    expect(m.getJson.mock.calls[0]![3]).toEqual({ from: "2026-04-01", to: "2026-04-30", limit: "500" });
  });

  it("401 invalid_token: refreshes with the rejected token and retries exactly once", async () => {
    m.repo.findByClient.mockResolvedValue(connected);
    m.accessTokenFor.mockResolvedValueOnce("stale").mockResolvedValueOnce("fresh");
    m.getJson.mockRejectedValueOnce(new BizpoleApiError(401, "invalid_token", "x", "r", null)).mockResolvedValueOnce({ data: { totals: true } });
    const r = await svc.staffRead(staff, 1, "totals", { asOf: "2026-10-31" }, reqCtx);
    expect(r.data).toEqual({ data: { totals: true } });
    expect(m.accessTokenFor).toHaveBeenNthCalledWith(2, 11, "stale");
    expect(m.getJson).toHaveBeenCalledTimes(2);
    expect(m.getJson.mock.calls[1]![0]).toBe("fresh");
  });

  it("a second 401 is not retried again", async () => {
    m.repo.findByClient.mockResolvedValue(connected);
    m.getJson.mockRejectedValue(new BizpoleApiError(401, "invalid_token", "x", "r", null));
    await expect(svc.staffRead(staff, 1, "company", {}, reqCtx)).rejects.toBeInstanceOf(AppError);
    expect(m.getJson).toHaveBeenCalledTimes(2);
  });

  it("404 from Bizpole: company no longer shared, connection flagged, audited as failed", async () => {
    m.repo.findByClient.mockResolvedValue(connected);
    m.getJson.mockRejectedValue(new BizpoleApiError(404, "not_found", "Not found.", "r", null));
    await expect(svc.staffRead(staff, 1, "parties", {}, reqCtx)).rejects.toMatchObject({ status: 409 });
    expect(m.repo.markError).toHaveBeenCalledWith(11, expect.stringMatching(/no longer shared/));
    expect(m.recordAudit).toHaveBeenCalledWith(staff, expect.objectContaining({ outcome: "failed" }));
  });

  it("refuses rather than returning a partial list past the page cap", async () => {
    m.repo.findByClient.mockResolvedValue(connected);
    m.getJson.mockResolvedValue({ data: [{}], hasMore: true, nextCursor: "next" });
    await expect(svc.staffRead(staff, 1, "vouchers", {}, reqCtx)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/from\/to/) });
    expect(m.getJson).toHaveBeenCalledTimes(svc.MAX_PAGES);
  });

  it("a revoked connection asks for a reconnect and calls nothing", async () => {
    m.repo.findByClient.mockResolvedValue({ ...connected, status: "revoked" });
    await expect(svc.staffRead(staff, 1, "accounts", {}, reqCtx)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/reconnect/) });
    expect(m.getJson).not.toHaveBeenCalled();
  });
});
