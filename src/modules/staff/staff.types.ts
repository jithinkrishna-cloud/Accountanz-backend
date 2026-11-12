import type { PortalRole } from "../../types/auth.types.js";
import type { UserStatus } from "../users/user.types.js";

export const STAFF_TYPES = ["accountant", "employee"] as const;
export type StaffType = (typeof STAFF_TYPES)[number];

/** Which portal roles each kind of staff may hold. */
export const ROLES_BY_STAFF_TYPE = {
  accountant: ["bookkeeper", "finance_manager", "cfo"],
  employee: ["ops_admin"],
} as const satisfies Record<StaffType, readonly PortalRole[]>;

export const VERIFICATION_STATUSES = ["pending", "verified", "rejected"] as const;

export interface StaffRow {
  user_id: number;
  email: string;
  full_name: string;
  phone: string | null;
  portal_role: PortalRole;
  status: UserStatus;
  staff_type: StaffType;
  hourly_rate: number | null;
  expertise: string[] | null;
  verification_status: (typeof VERIFICATION_STATUSES)[number];
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_ifsc: string | null;
  active_clients: number;
}

/** API shape: the account number is never returned in full. */
export type StaffView = Omit<StaffRow, "bank_account_number"> & { bank_account_last4: string | null };
