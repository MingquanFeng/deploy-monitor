import { NextRequest, NextResponse } from "next/server";
import { getDb, nowLocal, query, run } from "@/lib/db";

function unauthorized(msg: string) {
  return NextResponse.json({ error: msg }, { status: 401 });
}

export async function POST(req: NextRequest) {
  const expected = process.env.WEBHOOK_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: "服务未配置 WEBHOOK_TOKEN，拒绝接入" },
      { status: 503 }
    );
  }

  const auth = req.headers.get("authorization") ?? "";
  const got = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : auth;
  if (got !== expected) {
    return unauthorized("鉴权失败");
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const service = typeof body.service === "string" ? body.service.trim() : "";
  const environment = body.environment as string;
  const version = typeof body.version === "string" ? body.version : "";
  const deployedBy = typeof body.deployed_by === "string" ? body.deployed_by : "";
  const note = typeof body.note === "string" ? body.note : "";
  const status = (body.status ?? "success") as string;

  if (!service) return NextResponse.json({ error: "service 必填" }, { status: 400 });
  if (!["test", "staging", "prod"].includes(environment)) {
    return NextResponse.json({ error: "environment 必须为 test/staging/prod" }, { status: 400 });
  }
  if (!["pending", "success", "failed"].includes(status)) {
    return NextResponse.json({ error: "status 必须为 pending/success/failed" }, { status: 400 });
  }
  const statusStr = status as "pending" | "success" | "failed";

  const db = await getDb();
  const found = query(db, "SELECT id FROM services WHERE name = ?", [service]);
  if (!found.length) {
    return NextResponse.json({ error: `服务不存在: ${service}` }, { status: 404 });
  }
  const serviceId = found[0].id as number;

  const startedAt = nowLocal();
  const finishedAt = status === "success" || status === "failed" ? startedAt : null;

  run(
    db,
    `INSERT INTO deployments
       (service_id, environment, version, status, deployed_by, note, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [serviceId, environment, version, statusStr, deployedBy, note, startedAt, finishedAt]
  );

  const rows = query(
    db,
    "SELECT * FROM deployments WHERE service_id = ? AND environment = ? ORDER BY id DESC LIMIT 1",
    [serviceId, environment]
  );
  return NextResponse.json(rows[0], { status: 201 });
}
