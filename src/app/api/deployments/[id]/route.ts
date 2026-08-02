import { NextRequest, NextResponse } from "next/server";
import { getDb, nowLocal, query, run } from "@/lib/db";
import { publish } from "@/lib/events";

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

  if (typeof status !== "string" || !["pending", "success", "failed"].includes(status)) {
    return NextResponse.json({ error: "无效状态" }, { status: 400 });
  }

  const db = await getDb();
  const existing = query(db, "SELECT * FROM deployments WHERE id = ?", [idNum]);
  if (!existing.length) {
    return NextResponse.json({ error: "部署记录不存在" }, { status: 404 });
  }

  const finishedAt =
    status === "success" || status === "failed" ? nowLocal() : null;

  run(
    db,
    "UPDATE deployments SET status = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?",
    [status, finishedAt, idNum]
  );

  const updated = query(db, "SELECT * FROM deployments WHERE id = ?", [idNum]);
  // service_id 从库里读，而非从请求体 —— PUT 只接受 status 字段，服务归属不可变
  publish({
    type: "deployment.updated",
    deploymentId: idNum,
    serviceId: updated[0].service_id as number,
  });
  return NextResponse.json(updated[0]);
}
