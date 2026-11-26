import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import type { AuthUser } from "../../types/auth.types.js";

const m = vi.hoisted(() => ({
  findPrimarySpace: vi.fn(),
  findPrimarySpaceLocking: vi.fn(),
  setArchived: vi.fn(),
  clientDisplayName: vi.fn(),
  insertSpace: vi.fn(),
  keyTaken: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("../audit/audit.service.js", () => ({ recordAudit: m.recordAudit }));
vi.mock("./project.repository.js", () => ({
  findPrimarySpace: m.findPrimarySpace,
  findPrimarySpaceLocking: m.findPrimarySpaceLocking,
  setArchived: m.setArchived,
  clientDisplayName: m.clientDisplayName,
  insertSpace: m.insertSpace,
  keyTaken: m.keyTaken,
}));

const cs = await import("./client-spaces.js");

const conn = { tag: "tx" } as unknown as PoolConnection;
const admin = { id: 7, role: "super_admin" } as unknown as AuthUser;
const staff = { id: 8, role: "accountant" } as unknown as AuthUser;

beforeEach(() => {
  vi.resetAllMocks();
  m.clientDisplayName.mockResolvedValue("Green Leaf Pvt Ltd");
  m.keyTaken.mockResolvedValue(false);
});

describe("deriveSpaceKey", () => {
  it("derives keys like the wizard", () => {
    expect(cs.deriveSpaceKey("Green Leaf Pvt Ltd")).toBe("GLPL");
    expect(cs.deriveSpaceKey("X")).toBe("XX");
    expect(cs.deriveSpaceKey("123 Traders")).toBe("P1T");
  });
});

describe("nextFreeKey", () => {
  it("appends a counter", async () => {
    const taken = new Set(["GL", "GL2"]);
    expect(await cs.nextFreeKey("GL", async (k) => taken.has(k))).toBe("GL3");
  });
  it("truncates the base to stay within 10 chars", async () => {
    expect(await cs.nextFreeKey("ABCDEFGHIJ", async (k) => k === "ABCDEFGHIJ")).toBe("ABCDEFGHI2");
  });
});

describe("ensurePrimarySpace", () => {
  it("returns an existing live primary untouched", async () => {
    m.findPrimarySpace.mockResolvedValue({ id: 5, archived_at: null });
    expect(await cs.ensurePrimarySpace(admin, 1, conn)).toEqual({ spaceId: 5, created: false, restored: false });
    expect(m.insertSpace).not.toHaveBeenCalled();
    expect(m.setArchived).not.toHaveBeenCalled();
  });

  it("restores an archived primary", async () => {
    m.findPrimarySpace.mockResolvedValue({ id: 5, archived_at: new Date() });
    expect(await cs.ensurePrimarySpace(admin, 1, conn)).toEqual({ spaceId: 5, created: false, restored: true });
    expect(m.setArchived).toHaveBeenCalledWith(5, false, conn);
  });

  it("creates a primary with the admin actor as first member and audits it", async () => {
    m.findPrimarySpace.mockResolvedValue(undefined);
    m.insertSpace.mockResolvedValue(9);
    expect(await cs.ensurePrimarySpace(admin, 1, conn)).toEqual({ spaceId: 9, created: true, restored: false });
    expect(m.insertSpace).toHaveBeenCalledWith(expect.objectContaining({ space_key: "GLPL", name: "Green Leaf Pvt Ltd", template: "kanban", client_id: 1 }), "client_primary", 7, 7, conn);
    expect(m.recordAudit).toHaveBeenCalledWith(admin, expect.objectContaining({ action: "Workspace client space created", entityId: 9 }), conn);
  });

  it("records the creator but adds no member when the actor is not a portal admin", async () => {
    m.findPrimarySpace.mockResolvedValue(undefined);
    m.insertSpace.mockResolvedValue(9);
    await cs.ensurePrimarySpace(staff, 1, conn);
    expect(m.insertSpace).toHaveBeenCalledWith(expect.anything(), "client_primary", 8, null, conn);
  });

  it("slices long names to 80 chars", async () => {
    m.findPrimarySpace.mockResolvedValue(undefined);
    m.insertSpace.mockResolvedValue(9);
    m.clientDisplayName.mockResolvedValue("N".repeat(120));
    await cs.ensurePrimarySpace(admin, 1, conn);
    expect(m.insertSpace.mock.calls[0][0].name).toHaveLength(80);
  });

  it("returns the existing space when a concurrent primary wins the race", async () => {
    m.findPrimarySpace.mockResolvedValue(undefined);
    m.findPrimarySpaceLocking.mockResolvedValue({ id: 11, archived_at: null });
    m.insertSpace.mockRejectedValue({ code: "ER_DUP_ENTRY", message: "Duplicate entry '1' for key 'project_spaces.uq_project_space_primary'" });
    expect(await cs.ensurePrimarySpace(admin, 1, conn)).toEqual({ spaceId: 11, created: false, restored: false });
    expect(m.findPrimarySpaceLocking).toHaveBeenCalledWith(1, conn);
    expect(m.findPrimarySpace).toHaveBeenCalledTimes(1);
    expect(m.recordAudit).not.toHaveBeenCalled();
  });

  it("rethrows a dup-primary error when the locking re-read finds nothing", async () => {
    const err = { code: "ER_DUP_ENTRY", message: "Duplicate entry for key 'project_spaces.uq_project_space_primary'" };
    m.findPrimarySpace.mockResolvedValue(undefined);
    m.findPrimarySpaceLocking.mockResolvedValue(undefined);
    m.insertSpace.mockRejectedValue(err);
    await expect(cs.ensurePrimarySpace(admin, 1, conn)).rejects.toBe(err);
  });

  it("does not revisit keys already tried and throws when retries are exhausted", async () => {
    m.findPrimarySpace.mockResolvedValue(undefined);
    m.insertSpace.mockRejectedValue({ code: "ER_DUP_ENTRY", message: "for key 'project_spaces.uq_project_space_key'" });
    await expect(cs.ensurePrimarySpace(admin, 1, conn)).rejects.toThrow();
    const keys = m.insertSpace.mock.calls.map((c) => c[0].space_key);
    expect(keys).toHaveLength(20);
    expect(new Set(keys).size).toBe(20);
  });

  it("retries with the next free key on a key collision", async () => {
    m.findPrimarySpace.mockResolvedValue(undefined);
    m.insertSpace
      .mockRejectedValueOnce({ code: "ER_DUP_ENTRY", message: "Duplicate entry 'GLPL' for key 'project_spaces.uq_project_space_key'" })
      .mockResolvedValueOnce(12);
    expect(await cs.ensurePrimarySpace(admin, 1, conn)).toEqual({ spaceId: 12, created: true, restored: false });
    expect(m.insertSpace.mock.calls[1][0].space_key).toBe("GLPL2");
  });

  it("rethrows unrelated errors", async () => {
    m.findPrimarySpace.mockResolvedValue(undefined);
    m.insertSpace.mockRejectedValue(new Error("boom"));
    await expect(cs.ensurePrimarySpace(admin, 1, conn)).rejects.toThrow("boom");
  });
});

describe("archivePrimaryForClient", () => {
  it("archives and audits", async () => {
    m.findPrimarySpace.mockResolvedValue({ id: 5, archived_at: null });
    await cs.archivePrimaryForClient(admin, 1, conn);
    expect(m.setArchived).toHaveBeenCalledWith(5, true, conn);
    expect(m.recordAudit).toHaveBeenCalledWith(admin, expect.objectContaining({ entityId: 5, clientId: 1 }), conn);
  });
  it("is a no-op without a primary", async () => {
    m.findPrimarySpace.mockResolvedValue(undefined);
    await cs.archivePrimaryForClient(admin, 1, conn);
    expect(m.setArchived).not.toHaveBeenCalled();
    expect(m.recordAudit).not.toHaveBeenCalled();
  });
});
