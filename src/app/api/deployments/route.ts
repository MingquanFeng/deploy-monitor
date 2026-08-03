import { NextRequest, NextResponse } from "next/server";
import { getDb, nowLocal, query, runInfo } from "@/lib/db";
import { publish } from "@/lib/events";

export async function GET(req: NextRequest) {
  const db = await getDb();
  const { searchParams } = new URL(req.url);
  const serviceId = searchParams.get("service_id");
  const env = searchParams.get("env");

  let sql = `
    SELECT d.*, s.name AS service_name
    FROM deployments d
    JOIN services s ON d.service_id = s.id
    WHERE 1=1
  `;
  const params: (string | number)[] = [];

  if (serviceId) {
    sql += " AND d.service_id = ?";
    params.push(Number(serviceId));
  }
  if (env) {
    sql += " AND d.environment = ?";
    params.push(env);
  }

  sql += " ORDER BY d.started_at DESC";
  const rows = query(db, sql, params);
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const db = await getDb();
  let body: { service_id?: number | string; environment?: string; version?: string; deployed_by?: string; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const { service_id, environment, version, deployed_by, note } = body;

  if (!service_id || !environment) {
    return NextResponse.json({ error: "service_id 和 environment 必填" }, { status: 400 });
  }

  if (!["test", "staging", "prod"].includes(environment)) {
    return NextResponse.json({ error: "environment 必须为 test/staging/prod" }, { status: 400 });
  }

  const serviceIdNum = Number(service_id);
  const found = query(db, "SELECT id FROM services WHERE id = ?", [serviceIdNum]);
  if (!found.length) {
    return NextResponse.json({ error: "服务不存在" }, { status: 404 });
  }

  const info = runInfo(
    db,
    "INSERT INTO deployments (service_id, environment, version, deployed_by, note, started_at) VALUES (?, ?, ?, ?, ?, ?)",
    [serviceIdNum, environment, version || "", deployed_by || "", note || "", nowLocal()]
  );

  // 直接用新插入行的 id 精确回读。此前依赖 "ORDER BY id DESC LIMIT 1" 反查,
  // 是因为 sql.js 拿不到 last_insert_rowid();并发写入同一 service+env 时会读串行。
  const rows = query(db, "SELECT * FROM deployments WHERE id = ?", [
    Number(info.lastInsertRowid),
  ]);
  publish({
    type: "deployment.created",
    deploymentId: Number(info.lastInsertRowid),
    serviceId: serviceIdNum,
  });
  return NextResponse.json(rows[0], { status: 201 });
}
