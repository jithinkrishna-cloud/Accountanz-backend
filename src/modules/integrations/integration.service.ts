import * as repo from "./integration.repository.js";
import type { IntegrationListQuery } from "./integration.validation.js";

/**
 * Each client's JournL connection, read-only for admins. Connections are made only by the client owner with
 * "Sign in with JournL" in their portal (JournL confirms the company); admins can't add or verify them by hand.
 */
export const listConnections = (q: IntegrationListQuery) => repo.listConnections(q);
