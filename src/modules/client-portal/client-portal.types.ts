/** The signed-in client user's company and what they may do there. Resolved on every request. */
export interface ClientContext {
  userId: number;
  clientId: number;
  clientName: string;
  clientStatus: string;
  role: "owner" | "member";
  canApprove: boolean;
}

export const NOTIFICATION_PREFS = ["document_requests", "approvals", "reports", "monthly_summary"] as const;
export type NotificationPrefs = Record<(typeof NOTIFICATION_PREFS)[number], boolean>;
