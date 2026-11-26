/**
 * One-off backfill: creates the primary client space (and syncs the client team into it) for every client
 * that has an active engagement but no primary space yet. Safe to re-run: provisioning is idempotent.
 *
 *   npx tsx scripts/backfill-primary-spaces.mts            # dry run, lists the clients
 *   npx tsx scripts/backfill-primary-spaces.mts --apply    # creates the spaces
 */
import { pool, query, queryOne, withTransaction } from "../src/database/connection.js";
import { onEngagementActivated } from "../src/modules/projects/client-space-hooks.js";
import type { AuthUser } from "../src/types/auth.types.js";

const apply = process.argv.includes("--apply");

const actorRow = await queryOne<{ id: number; email: string; full_name: string }>(
  `SELECT id, email, full_name FROM users WHERE portal_role = 'super_admin' AND status = 'active' ORDER BY id LIMIT 1`,
);
if (!actorRow) throw new Error("No active super admin to record as the creator");
const actor: AuthUser = { id: actorRow.id, email: actorRow.email, fullName: actorRow.full_name, role: "super_admin" };

const clients = await query<{ id: number; name: string }>(
  `SELECT DISTINCT c.id, COALESCE(c.trade_name, c.legal_name) AS name
     FROM clients c JOIN engagements e ON e.client_id = c.id AND e.status = 'active'
    WHERE NOT EXISTS (SELECT 1 FROM project_spaces s WHERE s.client_id = c.id AND s.kind = 'client_primary')
    ORDER BY c.id`,
);

console.log(`${clients.length} client(s) with an active engagement and no primary space${apply ? "" : " (dry run)"}:`);
for (const c of clients) {
  if (!apply) {
    console.log(`  - ${c.name} (#${c.id})`);
    continue;
  }
  await withTransaction((conn) => onEngagementActivated(actor, c.id, conn));
  const s = await queryOne<{ space_key: string }>(`SELECT space_key FROM project_spaces WHERE client_id = ? AND kind = 'client_primary'`, [c.id]);
  console.log(`  - ${c.name} (#${c.id}): ${s ? `created ${s.space_key}` : "FAILED (see the audit log: Workspace sync failed)"}`);
}
await pool.end();
