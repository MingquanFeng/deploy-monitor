import { NextRequest, NextResponse } from "next/server";
import { getDb, isUniqueViolation, nowLocal, query, run } from "@/lib/db";
import { publish } from "@/lib/events";

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
    // 落库成功后才广播。publish() 契约上不抛错（见 src/lib/events.ts），
    // 所以这里不包 try/catch —— 推送失败不该把一次成功的写变成 500。
    publish({ type: "service.created", serviceId: rows[0].id as number });
    return NextResponse.json(rows[0], { status: 201 });
  } catch (e: unknown) {
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: "服务名已存在" }, { status: 409 });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
