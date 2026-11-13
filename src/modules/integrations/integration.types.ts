export const PROVIDERS = ["journl"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const CONNECTION_STATUSES = ["pending", "connected", "error", "disconnected"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export interface IntegrationRow {
  id: number;
  client_id: number;
  client_name: string;
  provider: Provider;
  external_org_id: string | null;
  external_org_name: string | null;
  status: ConnectionStatus;
  last_health_check: string | null;
  last_error: string | null;
  verified_at: string | null;
  verified_by_name: string | null;
  verification_note: string | null;
  disconnected_at: string | null;
  authorized_at: string | null;
  authorized_by_name: string | null;
  /** Set while Accountanz holds a live JournL session (from the owner's sign-in) for reading data. */
  journl_session_until: string | null;
}
