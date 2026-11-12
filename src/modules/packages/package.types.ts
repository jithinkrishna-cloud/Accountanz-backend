export const BILLING_CYCLES = ["monthly", "quarterly", "yearly"] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export interface PackageRow {
  id: number;
  name: string;
  description: string | null;
  monthly_fee: number;
  billing_cycle: BillingCycle;
  scope_notes: string | null;
  is_active: 0 | 1;
}

export interface PackageWithServices extends Omit<PackageRow, "is_active"> {
  is_active: boolean;
  services: { id: number; code: string; name: string }[];
}
