import type { PoolConnection } from "mysql2/promise";
import { execute, pool, queryOne, type Param } from "../../database/connection.js";
import type { AppSettings } from "./settings.types.js";
import type { UpdateSettingsInput } from "./settings.validation.js";

type Db = PoolConnection | typeof pool;
const BOOLEAN_KEYS = ["remind_document_due", "remind_task_overdue", "remind_invoice_overdue"] as const;
const WRITABLE = ["company_name", "legal_name", "gstin", "pan", "address", "email", "phone", "gst_rate", ...BOOLEAN_KEYS] as const;

/** The singleton row is created on first read so the app never runs without settings. */
export async function getSettings(db: Db = pool): Promise<AppSettings> {
  await execute(`INSERT IGNORE INTO app_settings (id) VALUES (1)`, [], db);
  const row = (await queryOne<Record<string, unknown>>(
    `SELECT company_name, legal_name, gstin, pan, address, email, phone, gst_rate,
            remind_document_due, remind_task_overdue, remind_invoice_overdue, updated_at
       FROM app_settings WHERE id = 1`,
    [],
    db,
  ))!;
  for (const k of BOOLEAN_KEYS) row[k] = Boolean(row[k]);
  return row as unknown as AppSettings;
}

export async function updateSettings(input: UpdateSettingsInput, db: Db) {
  await execute(`INSERT IGNORE INTO app_settings (id) VALUES (1)`, [], db);
  const keys = WRITABLE.filter((k) => k in input);
  await execute(
    `UPDATE app_settings SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = 1`,
    keys.map((k) => (input[k] ?? null) as Param),
    db,
  );
}
