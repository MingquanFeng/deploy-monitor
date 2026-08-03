import { NextRequest, NextResponse } from "next/server";
import { getDb, isUniqueViolation, query, run } from "@/lib/db";
import { publish } from "@/lib/events";

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
  const rows = query(db, "SELECT * FROM services WHERE id = ?", [idNum]);
  if (!rows.length) {
    return NextResponse.json({ error: "服务不存在" }, { status: 404 });
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
  let body: { name?: string; description?: string; owner?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const { name, description, owner } = body;
  const db = await getDb();
  const existing = query(db, "SELECT * FROM services WHERE id = ?", [idNum]);
  if (!existing.length) {
    return NextResponse.json({ error: "服务不存在" }, { status: 404 });
  }
  try {
    run(
      db,
      "UPDATE services SET name = COALESCE(?, name), description = COALESCE(?, description), owner = COALESCE(?, owner) WHERE id = ?",
      [name ?? null, description ?? null, owner ?? null, idNum]
    );
  } catch (e: unknown) {
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: "服务名已存在" }, { status: 409 });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
  const updated = query(db, "SELECT * FROM services WHERE id = ?", [idNum]);
  // UPDATE 未抛错才走到这里（异常分支已在上面 return），此时变更确实落库
  publish({ type: "service.updated", serviceId: idNum });
  return NextResponse.json(updated[0]);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const idNum = parseInt(id, 10);
  if (Number.isNaN(idNum) || idNum <= 0) {
    return NextResponse.json({ error: "无效的 id" }, { status: 400 });
  }
  const db = await getDb();
  const existing = query(db, "SELECT * FROM services WHERE id = ?", [idNum]);
  if (!existing.length) {
    return NextResponse.json({ error: "服务不存在" }, { status: 404 });
  }
  run(db, "DELETE FROM services WHERE id = ?", [idNum]);
  /**
   * 只发一个 service.deleted，不为被级联删掉的每条部署记录补发 deployment.* 事件。
   *
   * 理由：
   *   1. 语义已经完备。`service.deleted` 蕴含「该服务的部署记录全部消失」——
   *      这是 schema 上的外键 ON DELETE CASCADE 保证的事实，不是需要额外通知的信息。
   *      客户端收到它去刷新部署列表即可，不需要知道具体删了哪几条。
   *   2. 事件数量不能由数据量决定。一个服务可能挂着几千条部署记录，
   *      逐条发事件会在一次 DELETE 上给每个连接推几千帧，把 SSE 通道打满，
   *      而客户端拿到第一帧就已经要全量重新拉取了，后面几千帧全是浪费。
   *   3. 没有 deployment.deleted 这个类型。要逐条发就得先 SELECT 出所有 id
   *      （删除前多一次全表扫描），再引入一个只有级联场景才用的事件类型 ——
   *      为一个已被涵盖的语义增加两处复杂度。
   */
  publish({ type: "service.deleted", serviceId: idNum });
  return NextResponse.json({ ok: true });
}
