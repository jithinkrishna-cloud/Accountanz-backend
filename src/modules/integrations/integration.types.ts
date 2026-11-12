export const PROVIDERS = ["journl", "zoho_books"] as const;
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
}
