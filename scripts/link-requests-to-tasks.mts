/**
 * One-off: links document requests made before requests required a task to the client's best-matching task in the
 * same period (by shared words, e.g. "Bank statements…" → "Bank reconciliation"), and files the request's folder
 * under "<Mon YYYY> / <task>" like new requests. Requests with no confident match are listed and left alone.
 *
 *   npx tsx scripts/link-requests-to-tasks.mts            # dry run
 *   npx tsx scripts/link-requests-to-tasks.mts --apply
 */
import { pool, query, queryOne, withTransaction, execute } from "../src/database/connection.js";
import { createRequestFolder, monthFolderName, requestFolderName } from "../src/modules/document-folders/document-folder.service.js";

const apply = process.argv.includes("--apply");
const STOP = new Set(["for", "all", "the", "and", "of", "to", "a", "an", "in", "on", "current", "accounts", "account", "monthly", "month"]);
// Words that mean the same job ("statements" are what a "reconciliation" needs).
const ALIASES: Record<string, string[]> = { bank: ["bank"], statement: ["bank"], statements: ["bank"], invoice: ["sales", "purchase"], invoices: ["sales", "purchase"], salary: ["payroll"], payslip: ["payroll"], gst: ["gst"], tds: ["tds"] };
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
const expand = (ws: string[]) => new Set(ws.flatMap((w) => [w, ...(ALIASES[w] ?? [])]));

const actor = await queryOne<{ id: number }>(`SELECT id FROM users WHERE portal_role = 'super_admin' AND status = 'active' ORDER BY id LIMIT 1`);
const requests = await query<{ id: number; client_id: number; description: string; period: string | null; folder_id: number | null; requested_by: number | null; created_at: string }>(
  `SELECT id, client_id, description, period, folder_id, requested_by, created_at FROM document_requests WHERE task_id IS NULL ORDER BY id`,
);

console.log(`${requests.length} request(s) without a task${apply ? "" : " (dry run)"}:`);
for (const r of requests) {
  const period = r.period ?? String(r.created_at).slice(0, 7);
  const tasks = await query<{ id: number; title: string; creation_source: string }>(
    `SELECT id, title, creation_source FROM tasks WHERE client_id = ? AND period = ? ORDER BY id`,
    [r.client_id, period],
  );
  const want = expand(words(r.description));
  // Ties: the routine (template) task over one-offs, then the plainest title, then the oldest.
  const scored = tasks
    .map((t) => ({ t, score: words(t.title).filter((w) => want.has(w)).length }))
    .sort((a, b) => b.score - a.score || Number(a.t.creation_source !== "template") - Number(b.t.creation_source !== "template") || a.t.title.length - b.t.title.length || a.t.id - b.t.id);
  const best = scored[0];
  if (!best || best.score === 0) {
    console.log(`  - #${r.id} "${r.description}" (${period}): no clear task match, left alone`);
    continue;
  }
  if (!apply) {
    console.log(`  - #${r.id} "${r.description}" → task #${best.t.id} "${best.t.title}"`);
    continue;
  }
  await withTransaction(async (conn) => {
    const userId = r.requested_by ?? actor!.id;
    if (r.folder_id) {
      // Move the existing request folder under "<Mon YYYY> / <task>" (creating the task folder when needed).
      const month = await queryOne<{ id: number }>(`SELECT id FROM document_folders WHERE client_id = ? AND parent_id IS NULL AND name = ?`, [r.client_id, monthFolderName(period)], conn);
      const monthId = month?.id ?? (await execute(`INSERT INTO document_folders (client_id, parent_id, name, created_by, staff_folder) VALUES (?, NULL, ?, ?, TRUE)`, [r.client_id, monthFolderName(period), userId], conn)).insertId;
      const taskName = requestFolderName(best.t.title);
      const tf = await queryOne<{ id: number }>(`SELECT id FROM document_folders WHERE client_id = ? AND parent_id = ? AND name = ?`, [r.client_id, monthId, taskName], conn);
      const taskFolderId = tf?.id ?? (await execute(`INSERT INTO document_folders (client_id, parent_id, name, created_by, staff_folder) VALUES (?, ?, ?, ?, TRUE)`, [r.client_id, monthId, taskName, userId], conn)).insertId;
      if (taskFolderId !== r.folder_id) await execute(`UPDATE document_folders SET parent_id = ? WHERE id = ?`, [taskFolderId, r.folder_id], conn);
      await execute(`UPDATE document_requests SET task_id = ? WHERE id = ?`, [best.t.id, r.id], conn);
    } else {
      const folderId = await createRequestFolder({ clientId: r.client_id, period, taskTitle: best.t.title, description: r.description, userId }, conn);
      await execute(`UPDATE document_requests SET task_id = ?, folder_id = ? WHERE id = ?`, [best.t.id, folderId, r.id], conn);
      // Files already sent for it go into the new folder (unless the client filed them somewhere).
      await execute(`UPDATE documents SET folder_id = ? WHERE request_id = ? AND folder_id IS NULL`, [folderId, r.id], conn);
    }
  });
  console.log(`  - #${r.id} "${r.description}" → task #${best.t.id} "${best.t.title}" (linked, folder filed)`);
}
await pool.end();
