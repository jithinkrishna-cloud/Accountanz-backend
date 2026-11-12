import type { AuditLogRow } from "../audit/audit.types.js";

export interface AdminDashboard {
  period: string; // YYYY-MM
  clients: { active: number; onboarding: number; paused: number };
  engagements: { active: number; draft: number; sent: number };
  tasks: { overdue: number; approved: number; total: number };
  reviews: { waiting: number; overTwoDays: number };
  revenue: { billed: number; outstanding: number; openInvoices: number };
  behindOnClosing: { client_id: number; client_name: string; approved: number; total: number }[];
  /** True once the period is past day 20, when "behind on closing" starts to apply. */
  closingCheckActive: boolean;
  latestAudit: AuditLogRow[];
}
