import { NextRequest, NextResponse } from "next/server";
import { getDb, nowLocal, query, run } from "@/lib/db";

export async function GET() {
  const db = await getDb();
  const services = query(db, "SELECT * FROM services ORDER BY created_at DESC");
  return NextResponse.json(services);
}

export async function POST(req: NextRequest) {
  const db = await getDb();
  let body: { name?: string; description?: string; owner?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const { name, description, owner } = body;
  if (!name) {
    return NextResponse.json({ error: "服务名不能为空" }, { status: 400 });
  }
  try {
    run(db, "INSERT INTO services (name, description, owner, created_at) VALUES (?, ?, ?, ?)", [
      name,
      description || "",
      owner || "",
      nowLocal(),
    ]);
    const rows = query(db, "SELECT * FROM services WHERE name = ?", [name]);
    return NextResponse.json(rows[0], { status: 201 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE constraint failed")) {
      return NextResponse.json({ error: "服务名已存在" }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
