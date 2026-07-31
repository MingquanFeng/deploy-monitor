import { NextRequest } from "next/server";
import type { Database as SqlJsDatabase } from "sql.js";
import { getDb, query, run } from "@/lib/db";

/**
 * 构造一个带 JSON body 的 NextRequest。
 * route handler 只用到 req.json() / req.url / req.headers,
 * 直接 new NextRequest 就能覆盖,不需要起 HTTP server。
 */
export function jsonRequest(
  method: string,
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(url, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * 构造一个 body 不是合法 JSON 的请求,用来测 400 分支。
 */
export function malformedRequest(
  method: string,
  url: string,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(url, {
    method,
    body: "{ this is not json",
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * 无 body 的请求(GET / DELETE)。
 */
export function plainRequest(method: string, url: string): NextRequest {
  return new NextRequest(url, { method });
}

/**
 * Next.js 15 的动态路由 params 是 Promise。
 */
export function routeCtx(id: string | number) {
  return { params: Promise.resolve({ id: String(id) }) };
}

/**
 * 把数据库清空并重置自增序列,让每个测试从 id=1 开始。
 * 在 beforeEach 里调用 => 测试之间零共享状态,顺序无关。
 */
export async function resetDb(): Promise<SqlJsDatabase> {
  const db = await getDb();
  db.run("DELETE FROM deployments");
  db.run("DELETE FROM services");
  db.run("DELETE FROM sqlite_sequence WHERE name IN ('services','deployments')");
  return db;
}

/**
 * 数据工厂:直接走 SQL 建服务,不经过被测的 API。
 * 让「测 A 接口」不依赖「B 接口是好的」。
 */
export async function seedService(
  overrides: { name?: string; description?: string; owner?: string } = {}
): Promise<number> {
  const db = await getDb();
  const name = overrides.name ?? `svc-${Math.random().toString(36).slice(2, 10)}`;
  run(
    db,
    "INSERT INTO services (name, description, owner, created_at) VALUES (?, ?, ?, ?)",
    [name, overrides.description ?? "", overrides.owner ?? "", "2026-01-01 00:00:00"]
  );
  return query<{ id: number }>(db, "SELECT id FROM services WHERE name = ?", [name])[0].id;
}

/**
 * 数据工厂:直接走 SQL 建部署记录。
 */
export async function seedDeployment(
  serviceId: number,
  overrides: {
    environment?: string;
    version?: string;
    status?: string;
    deployed_by?: string;
    note?: string;
    started_at?: string;
  } = {}
): Promise<number> {
  const db = await getDb();
  run(
    db,
    `INSERT INTO deployments
       (service_id, environment, version, status, deployed_by, note, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      serviceId,
      overrides.environment ?? "prod",
      overrides.version ?? "v1.0.0",
      overrides.status ?? "pending",
      overrides.deployed_by ?? "",
      overrides.note ?? "",
      overrides.started_at ?? "2026-01-01 00:00:00",
    ]
  );
  return query<{ id: number }>(
    db,
    "SELECT id FROM deployments ORDER BY id DESC LIMIT 1"
  )[0].id;
}

/**
 * 断言时间戳是 nowLocal() 的格式:YYYY-MM-DD HH:MM:SS
 */
export const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
