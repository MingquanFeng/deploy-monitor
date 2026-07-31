import { NextRequest, NextResponse } from "next/server";
import { getDb, query, run } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await getDb();
  const rows = query(db, "SELECT * FROM services WHERE id = ?", [Number(id)]);
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
  const db = await getDb();
  const { name, description, owner } = await req.json();
  const existing = query(db, "SELECT * FROM services WHERE id = ?", [Number(id)]);
  if (!existing.length) {
    return NextResponse.json({ error: "服务不存在" }, { status: 404 });
  }
  run(
    db,
    "UPDATE services SET name = COALESCE(?, name), description = COALESCE(?, description), owner = COALESCE(?, owner) WHERE id = ?",
    [name ?? null, description ?? null, owner ?? null, Number(id)]
  );
  const updated = query(db, "SELECT * FROM services WHERE id = ?", [Number(id)]);
  return NextResponse.json(updated[0]);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await getDb();
  const existing = query(db, "SELECT * FROM services WHERE id = ?", [Number(id)]);
  if (!existing.length) {
    return NextResponse.json({ error: "服务不存在" }, { status: 404 });
  }
  run(db, "DELETE FROM services WHERE id = ?", [Number(id)]);
  return NextResponse.json({ ok: true });
}
