import { NextRequest, NextResponse } from "next/server";
import { getDb, nowLocal, query, run } from "@/lib/db";
import type { DeploymentStatus } from "@/lib/events";
import { publish } from "@/lib/events";
// 副作用 import：模块顶层注册部署失败的 Telegram 通知监听器。
// 订阅方必须与 publish 方在同一个模块图里，否则事件传不过去 ——
// 详见 src/lib/notify.ts 末尾对 instrumentation 方案为何失败的说明。
import "@/lib/notify";

const STATUSES: DeploymentStatus[] = ["pending", "success", "failed"];

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const idNum = parseInt(id, 10);
  if (Number.isNaN(idNum) || idNum <= 0) {
    return NextResponse.json({ error: "无效的 id" }, { status: 400 });
  }
  const db = await getDb();
  const rows = query(
    db,
    "SELECT d.*, s.name AS service_name FROM deployments d JOIN services s ON d.service_id = s.id WHERE d.id = ?",
    [idNum]
  );
  if (!rows.length) {
    return NextResponse.json({ error: "部署记录不存在" }, { status: 404 });
  }
  return NextResponse.json(rows[0]);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const idNum = parseInt(id, 10);
  if (Number.isNaN(idNum) || idNum <= 0) {
    return NextResponse.json({ error: "无效的 id" }, { status: 400 });
  }
  let body: { status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const { status } = body;

  if (typeof status !== "string" || !STATUSES.includes(status as DeploymentStatus)) {
    return NextResponse.json({ error: "无效状态" }, { status: 400 });
  }
  const statusStr = status as DeploymentStatus;

  const db = await getDb();
  const existing = query<{ status: string }>(
    db,
    "SELECT * FROM deployments WHERE id = ?",
    [idNum]
  );
  if (!existing.length) {
    return NextResponse.json({ error: "部署记录不存在" }, { status: 404 });
  }
  // 必须在 UPDATE 之前取。事件里的 previousStatus 是失败通知判定
  // 「pending → failed」的唯一依据，UPDATE 之后库里就只剩新状态了。
  const previousStatus = existing[0].status as DeploymentStatus;

  const finishedAt =
    statusStr === "success" || statusStr === "failed" ? nowLocal() : null;

  run(
    db,
    "UPDATE deployments SET status = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?",
    [statusStr, finishedAt, idNum]
  );

  const updated = query(db, "SELECT * FROM deployments WHERE id = ?", [idNum]);
  // service_id 从库里读，而非从请求体 —— PUT 只接受 status 字段，服务归属不可变
  publish({
    type: "deployment.updated",
    deploymentId: idNum,
    serviceId: updated[0].service_id as number,
    status: statusStr,
    previousStatus,
  });
  return NextResponse.json(updated[0]);
}
