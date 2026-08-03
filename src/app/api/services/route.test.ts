import { beforeEach, describe, expect, it } from "vitest";
import { getDb, query } from "@/lib/db";
import { GET, POST } from "@/app/api/services/route";
import {
  jsonRequest,
  malformedRequest,
  plainRequest,
  resetDb,
  seedService,
  TIMESTAMP_RE,
  captureEvents,
} from "@/test/helpers";

const URL_BASE = "http://localhost:3000/api/services";

/**
 * 直接 import route handler 调用,不起 HTTP server。
 * 数据库由 src/test/setup.ts 重定向到本进程私有临时目录,
 * 每个测试前 resetDb() 清空 => 测试之间零共享状态、顺序无关。
 */

beforeEach(async () => {
  await resetDb();
});

describe("GET /api/services", () => {
  it("无数据时返回空数组", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([]);
  });

  it("返回全部服务", async () => {
    await seedService({ name: "svc-a" });
    await seedService({ name: "svc-b" });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body.map((s: { name: string }) => s.name).sort()).toEqual(["svc-a", "svc-b"]);
  });

  it("返回完整字段", async () => {
    await seedService({ name: "svc-full", description: "d", owner: "alice" });
    const [svc] = await (await GET()).json();
    expect(svc).toMatchObject({
      id: expect.any(Number),
      name: "svc-full",
      description: "d",
      owner: "alice",
    });
  });
});

describe("POST /api/services", () => {
  it("201 创建成功并返回新建对象", async () => {
    const res = await POST(jsonRequest("POST", URL_BASE, { name: "new-svc" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      id: expect.any(Number),
      name: "new-svc",
      description: "",
      owner: "",
    });
    expect(body.created_at).toMatch(TIMESTAMP_RE);
  });

  it("201 时数据真的落库了", async () => {
    await POST(jsonRequest("POST", URL_BASE, { name: "persisted" }));
    const db = await getDb();
    const rows = query(db, "SELECT * FROM services WHERE name = ?", ["persisted"]);
    expect(rows).toHaveLength(1);
  });

  it("201 保存 description 与 owner", async () => {
    const res = await POST(
      jsonRequest("POST", URL_BASE, {
        name: "with-meta",
        description: "订单服务",
        owner: "bob",
      })
    );
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      description: "订单服务",
      owner: "bob",
    });
  });

  it("缺省的 description / owner 落库为空串而非 null", async () => {
    await POST(jsonRequest("POST", URL_BASE, { name: "bare" }));
    const db = await getDb();
    const [row] = query<{ description: string; owner: string }>(
      db,
      "SELECT description, owner FROM services WHERE name = ?",
      ["bare"]
    );
    expect(row.description).toBe("");
    expect(row.owner).toBe("");
  });

  it("400 服务名缺失", async () => {
    const res = await POST(jsonRequest("POST", URL_BASE, { owner: "nobody" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "服务名不能为空" });
  });

  it("400 服务名为空串", async () => {
    const res = await POST(jsonRequest("POST", URL_BASE, { name: "" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "服务名不能为空" });
  });

  it("400 时不写库", async () => {
    await POST(jsonRequest("POST", URL_BASE, { name: "" }));
    const db = await getDb();
    expect(query(db, "SELECT * FROM services")).toEqual([]);
  });

  it("409 服务名重复", async () => {
    await seedService({ name: "taken" });
    const res = await POST(jsonRequest("POST", URL_BASE, { name: "taken" }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "服务名已存在" });
  });

  it("409 时不产生第二行", async () => {
    await seedService({ name: "taken" });
    await POST(jsonRequest("POST", URL_BASE, { name: "taken" }));
    const db = await getDb();
    expect(query(db, "SELECT * FROM services WHERE name = ?", ["taken"])).toHaveLength(1);
  });

  it("400 请求体不是合法 JSON", async () => {
    const res = await POST(malformedRequest("POST", URL_BASE));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "请求体不是合法 JSON" });
  });

  it("400 请求体为空", async () => {
    const res = await POST(
      new (await import("next/server")).NextRequest(URL_BASE, { method: "POST" })
    );
    expect(res.status).toBe(400);
  });

  it("服务名区分大小写(Foo 与 foo 视为不同)", async () => {
    const a = await POST(jsonRequest("POST", URL_BASE, { name: "Foo" }));
    const b = await POST(jsonRequest("POST", URL_BASE, { name: "foo" }));
    expect([a.status, b.status]).toEqual([201, 201]);
  });

  it("服务名里的 SQL 元字符被安全处理", async () => {
    const nasty = "svc'; DROP TABLE services; --";
    const res = await POST(jsonRequest("POST", URL_BASE, { name: nasty }));
    expect(res.status).toBe(201);
    const db = await getDb();
    // 表还在,且名字被当作普通字面量存下
    expect(query(db, "SELECT * FROM services WHERE name = ?", [nasty])).toHaveLength(1);
  });

  it("GET 能读到 POST 刚创建的服务(读写闭环)", async () => {
    await POST(jsonRequest("POST", URL_BASE, { name: "roundtrip" }));
    const body = await (await GET()).json();
    expect(body.map((s: { name: string }) => s.name)).toContain("roundtrip");
  });

  it("plainRequest 形态的 GET 不影响结果", async () => {
    await seedService({ name: "x" });
    // GET handler 不接收参数,这里只是确认 helper 可用性与 handler 稳定
    expect(plainRequest("GET", URL_BASE).method).toBe("GET");
    expect(await (await GET()).json()).toHaveLength(1);
  });

  it("500 非 UNIQUE 的数据库错误被兜底捕获并返回错误信息", async () => {
    // 覆盖 catch 里的通用分支:不是 UNIQUE 冲突时应返回 500 而不是崩溃。
    // 通过临时删表制造一个真实的 SQL 错误(no such table)。
    const db = await getDb();
    db.exec("DROP TABLE deployments");
    db.exec("DROP TABLE services");
    try {
      const res = await POST(jsonRequest("POST", URL_BASE, { name: "boom" }));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toMatch(/no such table/i);
    } finally {
      // 复原 schema,避免影响 afterEach 之后的其他测试
      // (本文件每个测试前都会 resetDb,resetDb 依赖表存在)
      db.exec(`CREATE TABLE IF NOT EXISTS services (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT DEFAULT '',
        owner TEXT DEFAULT '',
        created_at TEXT DEFAULT NULL)`);
      db.exec(`CREATE TABLE IF NOT EXISTS deployments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        environment TEXT NOT NULL CHECK(environment IN ('test','staging','prod')),
        version TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','success','failed')),
        deployed_by TEXT DEFAULT '',
        note TEXT DEFAULT '',
        started_at TEXT DEFAULT NULL,
        finished_at TEXT)`);
    }
  });
});

describe("POST /api/services — 变更事件广播", () => {
  it("201 后广播 service.created，serviceId 为新建服务的 id", async () => {
    const cap = captureEvents();
    try {
      const body = await (
        await POST(jsonRequest("POST", URL_BASE, { name: "evt-created" }))
      ).json();
      expect(cap.events).toEqual([{ type: "service.created", serviceId: body.id }]);
    } finally {
      cap.stop();
    }
  });

  it("400（名称为空）不广播任何事件", async () => {
    const cap = captureEvents();
    try {
      expect((await POST(jsonRequest("POST", URL_BASE, {}))).status).toBe(400);
      expect(cap.events).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it("400（body 非法 JSON）不广播任何事件", async () => {
    const cap = captureEvents();
    try {
      expect((await POST(malformedRequest("POST", URL_BASE))).status).toBe(400);
      expect(cap.events).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it("409（重名）不广播任何事件", async () => {
    await seedService({ name: "dup-evt" });
    const cap = captureEvents();
    try {
      expect((await POST(jsonRequest("POST", URL_BASE, { name: "dup-evt" }))).status).toBe(409);
      expect(cap.events).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it("GET 不广播事件（只读操作）", async () => {
    await seedService({ name: "read-only" });
    const cap = captureEvents();
    try {
      await GET();
      expect(cap.events).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it("连续创建两个服务广播两条事件，serviceId 各自对应", async () => {
    const cap = captureEvents();
    try {
      const a = await (await POST(jsonRequest("POST", URL_BASE, { name: "e1" }))).json();
      const b = await (await POST(jsonRequest("POST", URL_BASE, { name: "e2" }))).json();
      expect(cap.events).toEqual([
        { type: "service.created", serviceId: a.id },
        { type: "service.created", serviceId: b.id },
      ]);
    } finally {
      cap.stop();
    }
  });
});
