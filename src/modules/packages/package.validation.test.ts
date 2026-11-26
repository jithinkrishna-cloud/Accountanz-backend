import { describe, expect, it } from "vitest";
import { packageBodySchema, packageUpdateSchema } from "./package.validation.js";

const base = { name: "Growth", monthly_fee: 500, service_ids: [1] };

describe("package limits validation", () => {
  it("accepts a null workspace limit with a staff limit", () => {
    const r = packageBodySchema.safeParse({ ...base, workspace_limit: null, staff_per_workspace: 5 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.workspace_limit).toBeNull();
      expect(r.data.staff_per_workspace).toBe(5);
    }
  });

  it("rejects a negative workspace limit", () => {
    expect(packageBodySchema.safeParse({ ...base, workspace_limit: -1, staff_per_workspace: 5 }).success).toBe(false);
  });

  it("rejects a fractional workspace limit", () => {
    expect(packageBodySchema.safeParse({ ...base, workspace_limit: 1.5, staff_per_workspace: 5 }).success).toBe(false);
  });

  it("rejects a workspace limit above 999", () => {
    expect(packageBodySchema.safeParse({ ...base, workspace_limit: 1000 }).success).toBe(false);
  });

  it("allows the limits to be omitted on update", () => {
    expect(packageUpdateSchema.safeParse({ staff_per_workspace: null }).success).toBe(true);
    expect(packageUpdateSchema.safeParse({ workspace_limit: 0 }).success).toBe(true);
    expect(packageUpdateSchema.safeParse({ workspace_limit: -1 }).success).toBe(false);
  });
  it("defaults the limits on create when omitted", () => {
    const r = packageBodySchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.workspace_limit).toBe(1);
      expect(r.data.staff_per_workspace).toBeNull();
    }
  });

  it("keeps an explicit null workspace limit as Unlimited on create", () => {
    const r = packageBodySchema.safeParse({ ...base, workspace_limit: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.workspace_limit).toBeNull();
  });

  it("does not inject limit defaults on update", () => {
    const r = packageUpdateSchema.safeParse({ name: "Growth" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect("workspace_limit" in r.data).toBe(false);
      expect("staff_per_workspace" in r.data).toBe(false);
    }
  });
});
