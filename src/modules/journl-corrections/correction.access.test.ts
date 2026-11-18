import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser, PortalRole } from "../../types/auth.types.js";

const m = vi.hoisted(() => ({ activeTeamRoles: vi.fn(), myClientPermissions: vi.fn(), findClientById: vi.fn() }));

vi.mock("../access/client-access.js", async (orig) => ({
  ...(await orig<typeof import("../access/client-access.js")>()),
  activeTeamRoles: m.activeTeamRoles,
}));
vi.mock("../journl-permissions/permission.service.js", () => ({ myClientPermissions: m.myClientPermissions }));
vi.mock("../clients/client.repository.js", () => ({ findClientById: m.findClientById }));

const { featureFor, requirePrepare, canApprove, requireApprove } = await import("./correction.access.js");

const user = (id: number, role: PortalRole): AuthUser => ({ id, role }) as AuthUser;
const perms = (module_key: string, effective_actions: string[]) => [{ modules: [{ module_key, effective_actions }] }];

beforeEach(() => {
  vi.resetAllMocks();
  m.findClientById.mockResolvedValue({ id: 5 });
  m.activeTeamRoles.mockResolvedValue([]);
  m.myClientPermissions.mockResolvedValue([]);
});

describe("featureFor", () => {
  it("maps kind and ledger kind to a feature key", () => {
    expect(featureFor("journal_entry", "general")).toBe("f_journal");
    expect(featureFor("opening_balance", "general")).toBe("f_general_ledgers");
    expect(featureFor("opening_balance", "customer")).toBe("f_customers");
    expect(featureFor("opening_balance", "supplier")).toBe("f_suppliers");
  });
});

describe("requirePrepare", () => {
  it("allows when effective actions include correct", async () => {
    m.myClientPermissions.mockResolvedValue(perms("f_journal", ["read", "correct"]));
    await expect(requirePrepare(user(1, "accountant" as PortalRole), 5, "f_journal")).resolves.toBeUndefined();
  });
  it("refuses without correct, with the feature name", async () => {
    m.myClientPermissions.mockResolvedValue(perms("f_journal", ["read"]));
    await expect(requirePrepare(user(1, "accountant" as PortalRole), 5, "f_journal")).rejects.toMatchObject({
      status: 403,
      message: "You don't have Correct access for Journal on this client. It needs both Accountanz's grant and the client's.",
    });
  });
  it("refuses when correct is on a different feature", async () => {
    m.myClientPermissions.mockResolvedValue(perms("f_customers", ["correct"]));
    await expect(requirePrepare(user(1, "accountant" as PortalRole), 5, "f_journal")).rejects.toMatchObject({ status: 403 });
  });
  it("refuses with no assignments", async () => {
    await expect(requirePrepare(user(1, "accountant" as PortalRole), 5, "f_journal")).rejects.toMatchObject({ status: 403 });
  });
  it("refuses admins even if permissions would be returned", async () => {
    m.myClientPermissions.mockResolvedValue(perms("f_journal", ["correct"]));
    await expect(requirePrepare(user(1, "super_admin"), 5, "f_journal")).rejects.toMatchObject({ status: 403 });
    await expect(requirePrepare(user(2, "ops_admin"), 5, "f_journal")).rejects.toMatchObject({ status: 403 });
  });
  it("falls back to the key for an unknown feature", async () => {
    await expect(requirePrepare(user(1, "accountant" as PortalRole), 5, "f_nope")).rejects.toThrow("Correct access for f_nope on");
  });
});

describe("admin rulings (explicit)", () => {
  it("super_admin calling requirePrepare is refused with 403", async () => {
    await expect(requirePrepare(user(9, "super_admin"), 5, "f_journal")).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  });
  it("super_admin approving someone else's correction succeeds", async () => {
    await expect(requireApprove(user(9, "super_admin"), 5, 1)).resolves.toBeUndefined();
    expect(await canApprove(user(9, "super_admin"), 5, 1)).toBe(true);
  });
  it("ops_admin approving is refused with 403", async () => {
    await expect(requireApprove(user(8, "ops_admin"), 5, 1)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  });
});

describe("canApprove / requireApprove", () => {
  it("super_admin approves", async () => {
    expect(await canApprove(user(9, "super_admin"), 5, 1)).toBe(true);
    await expect(requireApprove(user(9, "super_admin"), 5, 1)).resolves.toBeUndefined();
  });
  it("ops_admin is refused", async () => {
    m.activeTeamRoles.mockResolvedValue(["cfo"]);
    expect(await canApprove(user(9, "ops_admin"), 5, 1)).toBe(false);
    await expect(requireApprove(user(9, "ops_admin"), 5, 1)).rejects.toThrow("Only a finance manager, reviewer or CFO on this client, or a super admin, can approve");
  });
  it.each(["finance_manager", "reviewer", "cfo"])("%s on the client approves", async (role) => {
    m.activeTeamRoles.mockResolvedValue([role]);
    expect(await canApprove(user(2, "accountant" as PortalRole), 5, 1)).toBe(true);
    expect(m.activeTeamRoles).toHaveBeenCalledWith(2, 5);
  });
  it("bookkeeper is refused", async () => {
    m.activeTeamRoles.mockResolvedValue(["bookkeeper"]);
    expect(await canApprove(user(2, "accountant" as PortalRole), 5, 1)).toBe(false);
    await expect(requireApprove(user(2, "accountant" as PortalRole), 5, 1)).rejects.toMatchObject({ status: 403 });
  });
  it("initiator is refused even when they also hold cfo on the client", async () => {
    m.activeTeamRoles.mockResolvedValue(["bookkeeper", "cfo"]);
    expect(await canApprove(user(1, "accountant" as PortalRole), 5, 1)).toBe(false);
    await expect(requireApprove(user(1, "accountant" as PortalRole), 5, 1)).rejects.toMatchObject({
      status: 403,
      message: "You can't approve your own correction",
    });
  });
  it("super_admin who initiated is refused", async () => {
    expect(await canApprove(user(9, "super_admin"), 5, 9)).toBe(false);
  });
  it("reviewer on a different client is refused (no active roles here)", async () => {
    m.activeTeamRoles.mockResolvedValue([]);
    expect(await canApprove(user(2, "accountant" as PortalRole), 6, 1)).toBe(false);
    expect(m.activeTeamRoles).toHaveBeenCalledWith(2, 6);
  });
  it("is refused when the client doesn't exist, even for super_admin", async () => {
    m.findClientById.mockResolvedValue(null);
    m.activeTeamRoles.mockResolvedValue(["cfo"]);
    expect(await canApprove(user(9, "super_admin"), 5, 1)).toBe(false);
    expect(await canApprove(user(2, "accountant" as PortalRole), 5, 1)).toBe(false);
  });
});
