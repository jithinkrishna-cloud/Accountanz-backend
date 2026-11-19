/**
 * Bizpole Books Integration API (/integration/v1) types. Field names are taken from the Bizpole server code
 * (src/integration/*) and the Partner Quick Start; nothing here is guessed.
 */

/** POST /auth/token answer (connection_code and refresh_token grants). `companies` holds numeric company ids. */
export interface BizpoleTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope?: string;
  grant_id: string;
  companies: number[];
}

/** One entry of GET /companies (`{ data: BizpoleCompany[] }`). `gstin` is null when the company has none. */
export interface BizpoleCompany {
  id: string;
  name: string;
  gstin: string | null;
  booksStartDate?: string | null;
}

/** List endpoints: keyset pages. Pass `cursor = nextCursor` until `hasMore` is false. */
export interface BizpolePage<T = unknown> {
  data: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

/** What Accountanz keeps for the owner's company choice while a connection is pending. */
export interface CompanyChoice {
  id: string;
  name: string;
  gstin: string | null;
}

export type BizpoleStatus = "pending" | "connected" | "error" | "disconnected" | "revoked";

/** A bizpole_books row of integration_connections (sealed token columns stay inside the repository/token service). */
export interface BizpoleConnectionRow {
  id: number;
  client_id: number;
  status: BizpoleStatus;
  external_org_id: string | null;
  external_org_name: string | null;
  external_gstin: string | null;
  grant_id: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  available_companies: CompanyChoice[] | string | null;
  authorized_at: string | null;
  last_health_check: string | null;
  last_error: string | null;
  disconnected_at: string | null;
}

/** The client-portal view of the connection: never contains tokens or the grant id. */
export interface BizpoleConnectionView {
  available: boolean;
  connection: {
    status: BizpoleStatus;
    company_id: string | null;
    company_name: string | null;
    gstin: string | null;
    connected_at: string | null;
    last_checked_at: string | null;
    last_error: string | null;
    /** Only while pending: the companies the owner shared, to choose from. */
    companies: CompanyChoice[];
    /** Set when only one side (Accountanz client or Bizpole company) has a GSTIN. */
    gstin_warning: string | null;
  } | null;
}

/**
 * Read-only resources staff may read, with the query parameters each accepts (the Bizpole server's own list) and
 * whether it is a keyset-paged list. `limit` is Bizpole's maximum page size for that list.
 */
export const BIZPOLE_RESOURCES = {
  company: { path: "", params: [], paged: false, limit: 0 },
  accounts: { path: "accounts", params: [], paged: true, limit: 1000 },
  parties: { path: "parties", params: [], paged: true, limit: 1000 },
  "account-groups": { path: "account-groups", params: [], paged: true, limit: 1000 },
  "stock-items": { path: "stock-items", params: [], paged: true, limit: 1000 },
  units: { path: "units", params: [], paged: true, limit: 1000 },
  "stock-groups": { path: "stock-groups", params: [], paged: true, limit: 1000 },
  vouchers: { path: "vouchers", params: ["from", "to", "updatedSince", "include"], paged: true, limit: 500 },
  "bill-allocations": { path: "bill-allocations", params: ["scope", "includeDeleted"], paged: true, limit: 1000 },
  totals: { path: "totals", params: ["asOf"], paged: false, limit: 0 },
  "stock-valuation": { path: "stock-valuation", params: ["asOf"], paged: false, limit: 0 },
} as const satisfies Record<string, { path: string; params: readonly string[]; paged: boolean; limit: number }>;

export type BizpoleResource = keyof typeof BIZPOLE_RESOURCES;
