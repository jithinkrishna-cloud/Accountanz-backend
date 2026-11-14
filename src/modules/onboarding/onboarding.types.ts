export const ONBOARDING_STAGES = ["registered", "assessment", "proposal_sent", "accepted", "rejected"] as const;
export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];

export const COMPLEXITIES = ["low", "medium", "high"] as const;
export type Complexity = (typeof COMPLEXITIES)[number];

/** registered → assessment → proposal_sent → accepted; any open stage can be rejected; a rejection can be reopened. */
export const STAGE_TRANSITIONS: Record<OnboardingStage, OnboardingStage[]> = {
  registered: ["assessment", "rejected"],
  assessment: ["proposal_sent", "rejected"],
  proposal_sent: ["accepted", "assessment", "rejected"],
  accepted: [],
  rejected: ["assessment"],
};

export interface OnboardingCaseRow {
  id: number;
  client_id: number;
  client_name: string;
  legal_name: string;
  client_status: string;
  gstin: string | null;
  state: string | null;
  stage: OnboardingStage;
  monthly_transaction_volume: number | null;
  complexity: Complexity | null;
  notes: string | null;
  assessed_by_name: string | null;
  suggested_package_id: number | null;
  suggested_package_name: string | null;
  suggested_monthly_fee: number | null;
  /** What the client reads with the proposal (notes stay internal). */
  proposal_message: string | null;
  proposal_sent_at: string | null;
  accepted_at: string | null;
  accepted_by_name: string | null;
  /** "client" = accepted in the portal; "team" = marked accepted by staff. */
  accepted_via: "client" | "team" | null;
  /** Active owner logins: without one, the client can't see or accept the proposal online. */
  owner_logins: number;
  /** Latest engagement for the client, so an accepted case can link straight to it. */
  engagement_id: number | null;
  engagement_status: string | null;
  created_at: string;
  updated_at: string;
}

export type StageCounts = Record<OnboardingStage, number>;
