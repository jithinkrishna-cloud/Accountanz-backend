import type { JournlFeature } from "../integrations/journl-features.js";
export const MODULE_POLICIES = ["limited", "configurable", "restricted"] as const;
export type ModulePolicy = (typeof MODULE_POLICIES)[number];

export interface ModuleAction {
  action_key: string;
  label: string;
  journl_action_id: string | null;
  verified: boolean;
}

/** One entry of the JournL module catalogue (database-configured, not code; mapped to JournL's user-permission feature ids). */
export interface CatalogModule {
  module_key: string;
  label: string;
  /** The area this JournL feature belongs to (Sales, Purchases, ...): display group and staff workspace page. */
  group_key: string;
  group_label: string;
  default_policy: ModulePolicy;
  journl_module_id: string | null;
  /** journl_module_id resolved to JournL feature names (what this module actually opens in JournL). */
  features: JournlFeature[];
  verified: boolean;
  actions: ModuleAction[];
}

export interface Catalog {
  /** False in production: unverified modules and actions can't be granted or take effect. */
  allow_unverified: boolean;
  modules: CatalogModule[];
}

export type GrantSource = "accountanz" | "client";

export interface ModuleGrant {
  module_key: string;
  grant_source: GrantSource;
  allowed_actions: string[];
  status: "active" | "revoked";
  granted_by_name: string | null;
  granted_at: string;
  revoked_at: string | null;
}

/** The Accountanz side of an assignment's state; JournL decides the client's own grant. */
export interface AssignmentGates {
  assignment_id: number;
  client_id: number;
  user_id: number;
  assignment_active: boolean;
  engagement_active: boolean;
  journl_access: boolean;
}

export interface ModuleAccess {
  module_key: string;
  label: string;
  default_policy: ModulePolicy;
  verified: boolean;
  grant: ModuleGrant | null;
  /** The client's own grant for this module (client-set ceiling; JournL enforces this side). */
  client_grant: ModuleGrant | null;
  /** Granted actions that pass every Accountanz gate; JournL still applies the client's grant. */
  effective_actions: string[];
  /** Accountanz's side of the grant (the client's side is client_grant); effective needs both. */
  accountanz_actions: string[];
  /** Why granted actions don't take effect, when they don't. */
  blocked_reason: string | null;
}

export interface AssignmentPermissions extends AssignmentGates {
  /** JournL enforces the client's access ceiling; Accountanz doesn't know it, so it's reported as unknown. */
  client_grant: "unknown";
  allow_unverified: boolean;
  modules: ModuleAccess[];
}
