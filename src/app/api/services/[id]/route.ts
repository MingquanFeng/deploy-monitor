import { NextRequest, NextResponse } from "next/server";
import { getDb, isUniqueViolation, query, run } from "@/lib/db";

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
  return NextResponse.json({ ok: true });
}
