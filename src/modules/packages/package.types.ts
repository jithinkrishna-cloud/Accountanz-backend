export const BILLING_CYCLES = ["monthly", "quarterly", "yearly"] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

/** Roles a package can include. A reviewer assignment also covers finance_manager (both review the work). */
export const PACKAGE_ROLES = ["bookkeeper", "finance_manager", "cfo"] as const;
export type PackageRole = (typeof PACKAGE_ROLES)[number];

export interface PackageRow {
  id: number;
  name: string;
  description: string | null;
  monthly_fee: number;
  billing_cycle: BillingCycle;
  scope_notes: string | null;
  team_roles: PackageRole[];
  is_active: 0 | 1;
}

export interface PackageWithServices extends Omit<PackageRow, "is_active"> {
  is_active: boolean;
  services: { id: number; code: string; name: string }[];
}
