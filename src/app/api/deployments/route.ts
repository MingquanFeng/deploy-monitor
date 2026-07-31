import { NextRequest, NextResponse } from "next/server";
import { getDb, nowLocal, query, run } from "@/lib/db";

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
  const { service_id, environment, version, deployed_by, note } = await req.json();

  if (!service_id || !environment) {
    return NextResponse.json({ error: "service_id 和 environment 必填" }, { status: 400 });
  }

  run(
    db,
    "INSERT INTO deployments (service_id, environment, version, deployed_by, note, started_at) VALUES (?, ?, ?, ?, ?, ?)",
    [service_id, environment, version || "", deployed_by || "", note || "", nowLocal()]
  );

  const rows = query(
    db,
    "SELECT * FROM deployments WHERE service_id = ? AND environment = ? ORDER BY id DESC LIMIT 1",
    [service_id, environment]
  );
  return NextResponse.json(rows[0], { status: 201 });
}
