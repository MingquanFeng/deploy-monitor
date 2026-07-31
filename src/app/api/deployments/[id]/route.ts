import { NextRequest, NextResponse } from "next/server";
import { getDb, query, run } from "@/lib/db";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await getDb();
  const { status } = await req.json();

  if (!["pending", "success", "failed"].includes(status)) {
    return NextResponse.json({ error: "无效状态" }, { status: 400 });
  }

  const existing = query(db, "SELECT * FROM deployments WHERE id = ?", [Number(id)]);
  if (!existing.length) {
    return NextResponse.json({ error: "部署记录不存在" }, { status: 404 });
  }

  const finishedAt =
    status === "success" || status === "failed"
      ? new Date().toISOString().replace("T", " ").slice(0, 19)
      : null;

  run(
    db,
    "UPDATE deployments SET status = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?",
    [status, finishedAt, Number(id)]
  );

  const updated = query(db, "SELECT * FROM deployments WHERE id = ?", [Number(id)]);
  return NextResponse.json(updated[0]);
}
