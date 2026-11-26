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
});
