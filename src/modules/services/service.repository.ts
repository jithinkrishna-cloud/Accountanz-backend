import type { PoolConnection } from "mysql2/promise";
import { execute, pool, query, queryOne } from "../../database/connection.js";
import type { ServiceRow } from "./service.types.js";
import type { ServiceInput, ServiceUpdateInput } from "./service.validation.js";

type Db = PoolConnection | typeof pool;
const WRITABLE = ["code", "name", "description"] as const;

export const listServices = () => query<ServiceRow>(`SELECT id, code, name, description FROM services ORDER BY name`);

export const findServiceById = (id: number) => queryOne<ServiceRow>(`SELECT id, code, name, description FROM services WHERE id = ?`, [id]);

export const findServiceByCode = (code: string) => queryOne<{ id: number }>(`SELECT id FROM services WHERE code = ?`, [code]);

export async function countExistingServices(ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const row = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM services WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
  return row?.n ?? 0;
}

export async function insertService(input: ServiceInput, db: Db = pool) {
  const r = await execute(`INSERT INTO services (code, name, description) VALUES (?, ?, ?)`, [input.code, input.name, input.description], db);
  return r.insertId;
}

export async function updateService(id: number, input: ServiceUpdateInput, db: Db = pool) {
  const keys = WRITABLE.filter((k) => k in input);
  await execute(`UPDATE services SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...keys.map((k) => input[k] ?? null), id], db);
}
