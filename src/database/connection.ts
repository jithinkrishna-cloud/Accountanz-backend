import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import { env } from "../config/env.js";

export const pool: Pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  connectionLimit: 10,
  dateStrings: true, // DATE / DATETIME come back as strings; no timezone shifting
  decimalNumbers: true,
  namedPlaceholders: false,
  timezone: "Z",
});

type Executor = Pool | PoolConnection;
export type Param = string | number | boolean | null | Date;

export async function query<T>(sql: string, params: Param[] = [], db: Executor = pool): Promise<T[]> {
  const [rows] = await db.query<RowDataPacket[]>(sql, params);
  return rows as T[];
}

export async function queryOne<T>(sql: string, params: Param[] = [], db: Executor = pool): Promise<T | null> {
  const rows = await query<T>(sql, params, db);
  return rows[0] ?? null;
}

export async function execute(sql: string, params: Param[] = [], db: Executor = pool): Promise<ResultSetHeader> {
  const [result] = await db.execute<ResultSetHeader>(sql, params);
  return result;
}

/** Runs `fn` inside a transaction; commits on success, rolls back on any error. */
export async function withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
