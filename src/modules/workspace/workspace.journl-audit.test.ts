import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";

const m = vi.hoisted(() => ({
  requireClientAccess: vi.fn(),
  myClientPermissions: vi.fn(),
  journlConnection: vi.fn(),
  hasJournlAccess: vi.fn(),
  openJournlSession: vi.fn(),
  getJournlOverview: vi.fn(),
  viewLoad: vi.fn(),
  recordAudit: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("../access/client-access.js", () => ({
  requireClientAccess: m.requireClientAccess,
  isAdmin: (u: AuthUser) => u.role === "super_admin" || u.role === "ops_admin",
  isClientReviewer: vi.fn(),
  clientScope: vi.fn(),
}));
vi.mock("../journl-permissions/permission.service.js", () => ({ myClientPermissions: m.myClientPermissions }));
vi.mock("./workspace.repository.js", () => ({ journlConnection: m.journlConnection, hasJournlAccess: m.hasJournlAccess }));
vi.mock("../integrations/journl-data.service.js", () => ({ openJournlSession: m.openJournlSession, getJournlOverview: m.getJournlOverview }));
vi.mock("../integrations/journl-views.js", () => ({
  JOURNL_VIEWS: {
    trial_balance: { key: "trial_balance", module: "financial_reports", label: "Trial Balance", feature: "trial_balance", usesPeriod: true, columns: [], load: m.viewLoad },
  },
  MODULE_TABS: { financial_reports: ["trial_balance"] },
  OVERVIEW_SECTION_FEATURES: { trialBalance: "trial_balance" },
}));
vi.mock("../integrations/journl-features.js", () => ({ JOURNL_FEATURE_LIST: [{ key: "trial_balance", name: "Trial Balance" }] }));
vi.mock("../audit/audit.service.js", () => ({ recordAudit: m.recordAudit }));
vi.mock("../../utils/logger.js", () => ({ logger: { error: m.loggerError, info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("../closing/closing.service.js", () => ({ assessChecklist: vi.fn(), recentPeriods: () => ["2026-11"], setStatus: vi.fn() }));
vi.mock("../closing/closing.repository.js", () => ({ checklist: vi.fn(), currentStatus: vi.fn() }));
vi.mock("../../database/connection.js", () => ({ withTransaction: vi.fn() }));

const { clientJournlView, clientJournlData } = await import("./workspace.service.js");

const staff = { id: 7, email: "rahul@accountanz.in", role: "bookkeeper" } as AuthUser;
const admin = { id: 1, email: "admin@accountanz.in", role: "super_admin" } as AuthUser;
const CLIENT = 42;
const TOKEN = "owner-secret-token";
const ctx = { requestId: "req-123", ipAddress: "10.0.0.5", endpoint: "GET /api/team/clients/42/journl/views/trial_balance" };
const q = { from: "2026-04-01", to: "2026-11-18", page: 1, pageSize: 25 } as never;

const grant = (actions: string[]) => [{ modules: [{ module_key: "trial_balance", effective_actions: actions }] }];
const lastAudit = () => m.recordAudit.mock.calls.at(-1)!;

beforeEach(() => {
  vi.clearAllMocks();
  m.requireClientAccess.mockResolvedValue(undefined);
  m.myClientPermissions.mockResolvedValue(grant(["view"]));
  m.journlConnection.mockResolvedValue({ id: 9, status: "connected" });
  m.hasJournlAccess.mockResolvedValue(true);
  m.openJournlSession.mockResolvedValue({ token: TOKEN, companyId: "c1", expiresAt: new Date() });
  m.viewLoad.mockResolvedValue({ kind: "ok", data: { rows: [{ account: "Cash", balance: 1000 }], total: 1 } });
  m.getJournlOverview.mockResolvedValue({ trialBalance: { data: { secret: 1 }, error: null } });
  m.recordAudit.mockResolvedValue(undefined);
});

describe("clientJournlView read-audit", () => {
  it("records one success row attributed to the staff member, client and feature", async () => {
    const res = await clientJournlView(staff, CLIENT, "trial_balance", q, ctx);
    expect(res.rows).toHaveLength(1);
    expect(m.recordAudit).toHaveBeenCalledTimes(1);
    const [actor, entry] = lastAudit();
    expect(actor).toBe(staff);
    expect(entry).toMatchObject({
      action: "JournL data viewed",
      entityType: "JournlFeature",
      entityId: "trial_balance",
      clientId: CLIENT,
      outcome: "success",
      requestId: "req-123",
      ipAddress: "10.0.0.5",
      endpoint: ctx.endpoint,
    });
  });

  it("never writes the token or accounting data into the audit row", async () => {
    await clientJournlView(staff, CLIENT, "trial_balance", q, ctx);
    const written = JSON.stringify(lastAudit()[1]);
    expect(written).not.toContain(TOKEN);
    expect(written).not.toContain("Cash");
    expect(written).not.toContain("1000");
  });

  it("records admin reads under the admin's identity without checking grants", async () => {
    await clientJournlView(admin, CLIENT, "trial_balance", q, ctx);
    expect(m.myClientPermissions).not.toHaveBeenCalled();
    expect(lastAudit()[0]).toBe(admin);
    expect(lastAudit()[1]).toMatchObject({ outcome: "success", entityId: "trial_balance" });
  });

  it("still returns the data when the audit write fails, and logs the failure", async () => {
    m.recordAudit.mockRejectedValue(new Error("audit db down"));
    const res = await clientJournlView(staff, CLIENT, "trial_balance", q, ctx);
    expect(res.rows).toHaveLength(1);
    expect(m.loggerError).toHaveBeenCalledTimes(1);
    expect(m.loggerError.mock.calls[0]![1]).toBe("JournL read-audit write failed");
  });

  it("404 when not assigned: same error, audited as denied", async () => {
    m.requireClientAccess.mockRejectedValue(AppError.notFound("Client"));
    await expect(clientJournlView(staff, CLIENT, "trial_balance", q, ctx)).rejects.toMatchObject({ status: 404, message: "Client not found" });
    expect(m.viewLoad).not.toHaveBeenCalled();
    expect(lastAudit()[1]).toMatchObject({ action: "JournL data access denied", outcome: "denied", clientId: CLIENT });
  });

  it("keeps the 404 row when the client id doesn't exist (foreign key) by retrying without the client link", async () => {
    m.requireClientAccess.mockRejectedValue(AppError.notFound("Client"));
    m.recordAudit.mockRejectedValueOnce(Object.assign(new Error("fk"), { code: "ER_NO_REFERENCED_ROW_2" })).mockResolvedValueOnce(undefined);
    await expect(clientJournlView(staff, 999, "trial_balance", q, ctx)).rejects.toMatchObject({ status: 404 });
    expect(m.recordAudit).toHaveBeenCalledTimes(2);
    expect(lastAudit()[1]).toMatchObject({ clientId: null, outcome: "denied" });
    expect(lastAudit()[1].details).toContain("client #999");
    expect(m.loggerError).not.toHaveBeenCalled();
  });

  it("403 without the feature grant: same error, audited as denied, JournL never called", async () => {
    m.myClientPermissions.mockResolvedValue(grant([]));
    await expect(clientJournlView(staff, CLIENT, "trial_balance", q, ctx)).rejects.toMatchObject({ status: 403 });
    expect(m.openJournlSession).not.toHaveBeenCalled();
    expect(lastAudit()[1]).toMatchObject({ outcome: "denied", entityId: "trial_balance" });
    expect(lastAudit()[1].details).toContain("403 FORBIDDEN");
  });

  it("409 when the owner's session has expired: same error, audited as failed", async () => {
    m.viewLoad.mockResolvedValue({ kind: "expired" });
    await expect(clientJournlView(staff, CLIENT, "trial_balance", q, ctx)).rejects.toMatchObject({ status: 409 });
    expect(lastAudit()[1]).toMatchObject({ action: "JournL data access failed", outcome: "failed" });
  });

  it("an audit failure on a denied read doesn't replace the original error", async () => {
    m.myClientPermissions.mockResolvedValue(grant([]));
    m.recordAudit.mockRejectedValue(new Error("audit db down"));
    await expect(clientJournlView(staff, CLIENT, "trial_balance", q, ctx)).rejects.toMatchObject({ status: 403 });
    expect(m.loggerError).toHaveBeenCalledTimes(1);
  });
});

describe("clientJournlData (overview) read-audit", () => {
  it("records one success row for the overview", async () => {
    await clientJournlData(staff, CLIENT, { from: "2026-04-01", to: "2026-11-18" }, ctx);
    expect(m.recordAudit).toHaveBeenCalledTimes(1);
    expect(lastAudit()[1]).toMatchObject({ entityId: "overview", clientId: CLIENT, outcome: "success" });
    expect(JSON.stringify(lastAudit()[1])).not.toContain("secret");
  });

  it("403 when the assignment has no JournL access: audited as denied", async () => {
    m.hasJournlAccess.mockResolvedValue(false);
    await expect(clientJournlData(staff, CLIENT, { from: "2026-04-01", to: "2026-11-18" }, ctx)).rejects.toMatchObject({ status: 403 });
    expect(m.getJournlOverview).not.toHaveBeenCalled();
    expect(lastAudit()[1]).toMatchObject({ entityId: "overview", outcome: "denied" });
  });
});
