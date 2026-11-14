import type { PoolConnection } from "mysql2/promise";
import { execute, pool, query, type Param } from "../../database/connection.js";
import type { PackageRow, PackageWithServices } from "./package.types.js";
import type { PackageInput, PackageUpdateInput } from "./package.validation.js";

type Db = PoolConnection | typeof pool;
const WRITABLE = ["name", "description", "monthly_fee", "billing_cycle", "scope_notes", "team_roles", "is_active"] as const;
/** team_roles is stored as JSON. */
const toDb = (k: (typeof WRITABLE)[number], v: unknown) => (k === "team_roles" ? JSON.stringify(v ?? []) : (v ?? null)) as Param;

export async function listPackages(id?: number): Promise<PackageWithServices[]> {
  const rows = await query<PackageRow>(
    `SELECT id, name, description, monthly_fee, billing_cycle, scope_notes, team_roles, is_active FROM packages ${id ? "WHERE id = ?" : ""} ORDER BY monthly_fee DESC, name`,
    id ? [id] : [],
  );
  if (!rows.length) return [];
  const links = await query<{ package_id: number; id: number; code: string; name: string }>(
    `SELECT ps.package_id, s.id, s.code, s.name
       FROM package_services ps JOIN services s ON s.id = ps.service_id
      WHERE ps.package_id IN (${rows.map(() => "?").join(",")})
      ORDER BY s.name`,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({
    ...r,
    is_active: Boolean(r.is_active),
    services: links.filter((l) => l.package_id === r.id).map(({ id, code, name }) => ({ id, code, name })),
  }));
}

export async function findPackageById(id: number) {
  return (await listPackages(id))[0] ?? null;
}

export async function insertPackage(input: PackageInput, db: Db): Promise<number> {
  const r = await execute(
    `INSERT INTO packages (${WRITABLE.join(", ")}) VALUES (${WRITABLE.map(() => "?").join(", ")})`,
    WRITABLE.map((k) => toDb(k, input[k])),
    db,
  );
  return r.insertId;
}

export async function updatePackage(id: number, input: PackageUpdateInput, db: Db) {
  const keys = WRITABLE.filter((k) => k in input);
  if (!keys.length) return;
  await execute(`UPDATE packages SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...keys.map((k) => toDb(k, input[k])), id], db);
}

export async function replacePackageServices(packageId: number, serviceIds: number[], db: Db) {
  await execute(`DELETE FROM package_services WHERE package_id = ?`, [packageId], db);
  for (const sid of serviceIds) {
    await execute(`INSERT INTO package_services (package_id, service_id) VALUES (?, ?)`, [packageId, sid], db);
  }
}
