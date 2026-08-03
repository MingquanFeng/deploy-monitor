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
  let body: {
    service_id?: number | string;
    environment?: string;
    version?: string;
    deployed_by?: string;
    note?: string;
    rollback_from?: number | string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const { service_id, environment, version, deployed_by, note, rollback_from } = body;

  if (!service_id || !environment) {
    return NextResponse.json({ error: "service_id 和 environment 必填" }, { status: 400 });
  }

  if (!["test", "staging", "prod"].includes(environment)) {
    return NextResponse.json({ error: "environment 必须为 test/staging/prod" }, { status: 400 });
  }

  // 形状校验放在读库之前。rollback_from 缺省或显式 null 都表示「这不是一次回滚」;
  // 给了值就必须是正整数 —— 接受数字字符串是为了和 service_id 的处理保持一致
  // (表单提交的字段值都是字符串)。
  let rollbackFrom: number | null = null;
  if (rollback_from !== undefined && rollback_from !== null) {
    const n =
      typeof rollback_from === "number" || typeof rollback_from === "string"
        ? Number(rollback_from)
        : NaN;
    if (!Number.isInteger(n) || n <= 0) {
      return NextResponse.json({ error: "rollback_from 必须是正整数" }, { status: 400 });
    }
    rollbackFrom = n;
  }

  const serviceIdNum = Number(service_id);
  const found = query(db, "SELECT id FROM services WHERE id = ?", [serviceIdNum]);
  if (!found.length) {
    return NextResponse.json({ error: "服务不存在" }, { status: 404 });
  }

  // 存在性与归属校验必须读库。同服务约束是这里的关键安全边界:
  // 没有它,任何人都能把 A 服务的部署标成「B 服务某次失败的回滚」,污染跨服务的因果链。
  if (rollbackFrom !== null) {
    const target = query<{ service_id: number }>(
      db,
      "SELECT service_id FROM deployments WHERE id = ?",
      [rollbackFrom]
    );
    if (!target.length) {
      return NextResponse.json({ error: "被回滚的部署记录不存在" }, { status: 400 });
    }
    if (target[0].service_id !== serviceIdNum) {
      return NextResponse.json({ error: "不能回滚其它服务的部署" }, { status: 400 });
    }
  }

  const info = runInfo(
    db,
    "INSERT INTO deployments (service_id, environment, version, deployed_by, note, started_at, rollback_from) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      serviceIdNum,
      environment,
      version || "",
      deployed_by || "",
      note || "",
      nowLocal(),
      rollbackFrom,
    ]
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
