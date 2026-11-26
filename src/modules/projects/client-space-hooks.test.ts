import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import type { AuthUser } from "../../types/auth.types.js";

const m = vi.hoisted(() => ({
  execute: vi.fn(),
  ensurePrimarySpace: vi.fn(),
  archivePrimaryForClient: vi.fn(),
  syncPrimaryMembers: vi.fn(),
  findPrimarySpace: vi.fn(),
  recordAudit: vi.fn(),
  loggerError: vi.fn(),
}));


vi.mock("../../utils/logger.js", () => ({ logger: { error: m.loggerError } }));
vi.mock("../audit/audit.service.js", () => ({ recordAudit: m.recordAudit }));
vi.mock("./project.repository.js", () => ({ findPrimarySpace: m.findPrimarySpace }));
vi.mock("./client-spaces.js", () => ({
  ensurePrimarySpace: m.ensurePrimarySpace,
  archivePrimaryForClient: m.archivePrimaryForClient,
  syncPrimaryMembers: m.syncPrimaryMembers,
}));

const { onEngagementActivated, onEngagementEnded, onClientTeamChanged } = await import("./client-space-hooks.js");

const actor = { id: 1, role: "super_admin", email: "a@x.com" } as AuthUser;
const conn = { query: m.execute } as unknown as PoolConnection;
const sqls = () => m.execute.mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.clearAllMocks();
  m.execute.mockResolvedValue({});
  m.ensurePrimarySpace.mockResolvedValue({ spaceId: 5, created: true, restored: false });
  m.syncPrimaryMembers.mockResolvedValue({ added: [], removed: [], issues: [] });
});

describe("onEngagementActivated", () => {
  it("ensures the space then syncs, inside a released savepoint", async () => {
    await onEngagementActivated(actor, 7, conn);
    expect(m.ensurePrimarySpace).toHaveBeenCalledWith(actor, 7, conn);
    expect(m.syncPrimaryMembers).toHaveBeenCalledWith(actor, 7, conn);
    expect(m.ensurePrimarySpace.mock.invocationCallOrder[0]).toBeLessThan(m.syncPrimaryMembers.mock.invocationCallOrder[0]);
    expect(sqls()).toEqual(["SAVEPOINT ws_hook", "RELEASE SAVEPOINT ws_hook"]);
  });

  it("swallows a failure, rolls back, logs and audits", async () => {
    m.ensurePrimarySpace.mockRejectedValue(new Error("boom"));
    await expect(onEngagementActivated(actor, 7, conn)).resolves.toBeUndefined();
    expect(m.syncPrimaryMembers).not.toHaveBeenCalled();
    expect(sqls()).toEqual(["SAVEPOINT ws_hook", "ROLLBACK TO SAVEPOINT ws_hook"]);
    expect(m.loggerError).toHaveBeenCalled();
    expect(m.recordAudit).toHaveBeenCalledWith(actor, expect.objectContaining({ action: "Workspace sync failed", entityType: "Client", entityId: 7 }), conn);
  });

  it("still resolves when the failure audit itself fails", async () => {
    m.ensurePrimarySpace.mockRejectedValue(new Error("boom"));
    m.recordAudit.mockRejectedValue(new Error("audit down"));
    await expect(onEngagementActivated(actor, 7, conn)).resolves.toBeUndefined();
  });
});

describe("onEngagementEnded", () => {
  it("archives the primary space", async () => {
    await onEngagementEnded(actor, 7, conn);
    expect(m.archivePrimaryForClient).toHaveBeenCalledWith(actor, 7, conn);
  });
});

describe("onClientTeamChanged", () => {
  it("does nothing without a primary", async () => {
    m.findPrimarySpace.mockResolvedValue(undefined);
    await onClientTeamChanged(actor, 7, conn);
    expect(m.syncPrimaryMembers).not.toHaveBeenCalled();
  });

  it("does nothing when the primary is archived", async () => {
    m.findPrimarySpace.mockResolvedValue({ id: 5, archived_at: new Date() });
    await onClientTeamChanged(actor, 7, conn);
    expect(m.syncPrimaryMembers).not.toHaveBeenCalled();
  });

  it("syncs when a live primary exists", async () => {
    m.findPrimarySpace.mockResolvedValue({ id: 5, archived_at: null });
    await onClientTeamChanged(actor, 7, conn);
    expect(m.syncPrimaryMembers).toHaveBeenCalledWith(actor, 7, conn);
  });
});
