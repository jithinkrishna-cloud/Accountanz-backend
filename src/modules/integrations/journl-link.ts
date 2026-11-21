import { env } from "../../config/env.js";

/**
 * "Open in JournL": a plain link to the client's JournL company. It's navigation only, not sign-in: it never
 * carries Accountanz's stored session, so JournL shows whoever is signed in there (or its sign-in page).
 */
export type JournlLinkState =
  /** Connected and the link format is configured: `url` opens the company. */
  | { state: "ready"; url: string }
  /** Connected, but JOURNL_APP_URL_TEMPLATE isn't set yet. */
  | { state: "not_configured" }
  /** No usable connection: never connected, disconnected, revoked, pending or in error. */
  | { state: "unavailable"; status: string | null };

export function journlLink(conn: { status: string; external_org_id: string | null } | null | undefined, template = env.JOURNL_APP_URL_TEMPLATE): JournlLinkState {
  if (!conn || conn.status !== "connected" || !conn.external_org_id) return { state: "unavailable", status: conn?.status ?? null };
  if (!template) return { state: "not_configured" };
  const url = template.replaceAll("{companyId}", encodeURIComponent(conn.external_org_id));
  try {
    // Only ever hand the browser an https link.
    if (new URL(url).protocol !== "https:") return { state: "not_configured" };
  } catch {
    return { state: "not_configured" };
  }
  return { state: "ready", url };
}
