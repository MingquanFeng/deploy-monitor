import { beforeEach, describe, expect, it } from "vitest";
import { getDb, query } from "@/lib/db";
import { DELETE, GET, PUT } from "@/app/api/services/[id]/route";
import {
  jsonRequest,
  malformedRequest,
  plainRequest,
  resetDb,
  routeCtx,
  seedDeployment,
  seedService,
  captureEvents,
} from "@/test/helpers";

const URL_BASE = "http://localhost:3000/api/services";

beforeEach(async () => {
  await resetDb();
});

describe("GET /api/services/[id]", () => {
  it("200 返回指定服务", async () => {
    const id = await seedService({ name: "svc-one", owner: "alice" });
    const res = await GET(plainRequest("GET", `${URL_BASE}/${id}`), routeCtx(id));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id,
      name: "svc-one",
      owner: "alice",
    });
  });

  it("404 服务不存在", async () => {
    const res = await GET(plainRequest("GET", `${URL_BASE}/9999`), routeCtx(9999));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "服务不存在" });
  });

  it.each(["abc", "", "not-a-number", "x12"])(
    "400 无效 id %j(parseInt 得 NaN)",
    async (bad) => {
      const res = await GET(plainRequest("GET", `${URL_BASE}/${bad}`), routeCtx(bad));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "无效的 id" });
    }
  );

  it("已知宽松行为:以数字开头的脏 id 被 parseInt 截断后当作合法 id", async () => {
    // parseInt("12abc-x", 10) === 12,所以脏输入不会走 400 分支,
    // 而是按 id=12 查库(此处不存在 => 404)。
    // 记录当前行为;若将来改为严格校验,这条应改为断言 400。
    const res = await GET(plainRequest("GET", `${URL_BASE}/12abc-x`), routeCtx("12abc-x"));
    expect(res.status).toBe(404);
  });

  it.each(["0", "-1", "-999"])("400 非正数 id %s", async (bad) => {
    const res = await GET(plainRequest("GET", `${URL_BASE}/${bad}`), routeCtx(bad));
    expect(res.status).toBe(400);
  });

  it("id 前后有空格仍能解析(parseInt 宽松行为)", async () => {
    const id = await seedService({ name: "spaced" });
    const res = await GET(plainRequest("GET", URL_BASE), routeCtx(` ${id} `));
    expect(res.status).toBe(200);
  });
});

describe("PUT /api/services/[id]", () => {
  it("200 更新全部字段", async () => {
    const id = await seedService({ name: "old", description: "od", owner: "oo" });
    const res = await PUT(
      jsonRequest("PUT", `${URL_BASE}/${id}`, {
        name: "new",
        description: "nd",
        owner: "no",
      }),
      routeCtx(id)
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id,
      name: "new",
      description: "nd",
      owner: "no",
    });
  });

  it("200 更新真的落库", async () => {
    const id = await seedService({ name: "old" });
    await PUT(jsonRequest("PUT", URL_BASE, { name: "renamed" }), routeCtx(id));
    const db = await getDb();
    const [row] = query<{ name: string }>(db, "SELECT name FROM services WHERE id = ?", [id]);
    expect(row.name).toBe("renamed");
  });

  it("部分更新:未传的字段通过 COALESCE 保持原值", async () => {
    const id = await seedService({ name: "keep-me", description: "keep-d", owner: "keep-o" });
    const res = await PUT(jsonRequest("PUT", URL_BASE, { owner: "changed" }), routeCtx(id));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      name: "keep-me",
      description: "keep-d",
      owner: "changed",
    });
  });

  it("空 body 时所有字段保持原值", async () => {
    const id = await seedService({ name: "untouched", owner: "same" });
    const res = await PUT(jsonRequest("PUT", URL_BASE, {}), routeCtx(id));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ name: "untouched", owner: "same" });
  });

  it("可以把 description 显式改成空串", async () => {
    const id = await seedService({ name: "clr", description: "had-text" });
    const res = await PUT(jsonRequest("PUT", URL_BASE, { description: "" }), routeCtx(id));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ description: "" });
  });

  it("404 服务不存在", async () => {
    const res = await PUT(jsonRequest("PUT", URL_BASE, { name: "x" }), routeCtx(9999));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "服务不存在" });
  });

  it("400 无效 id", async () => {
    const res = await PUT(jsonRequest("PUT", URL_BASE, { name: "x" }), routeCtx("abc"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "无效的 id" });
  });

  it("400 请求体不是合法 JSON", async () => {
    const id = await seedService({ name: "svc" });
    const res = await PUT(malformedRequest("PUT", URL_BASE), routeCtx(id));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "请求体不是合法 JSON" });
  });

  it("id 校验先于 body 解析(坏 id + 坏 body 时返回 id 错误)", async () => {
    const res = await PUT(malformedRequest("PUT", URL_BASE), routeCtx("abc"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "无效的 id" });
  });

  it("改名撞上已有服务名返回 409", async () => {
    await seedService({ name: "occupied" });
    const id = await seedService({ name: "mover" });
    const res = await PUT(
      jsonRequest("PUT", URL_BASE, { name: "occupied" }),
      routeCtx(id)
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "服务名已存在" });
  });
});

describe("DELETE /api/services/[id]", () => {
  it("200 删除成功", async () => {
    const id = await seedService({ name: "doomed" });
    const res = await DELETE(plainRequest("DELETE", URL_BASE), routeCtx(id));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("删除后记录真的不见了", async () => {
    const id = await seedService({ name: "doomed" });
    await DELETE(plainRequest("DELETE", URL_BASE), routeCtx(id));
    const db = await getDb();
    expect(query(db, "SELECT * FROM services WHERE id = ?", [id])).toEqual([]);
  });

  it("级联删除该服务的所有部署记录", async () => {
    const id = await seedService({ name: "with-deploys" });
    await seedDeployment(id, { environment: "test" });
    await seedDeployment(id, { environment: "staging" });
    await seedDeployment(id, { environment: "prod" });
    const db = await getDb();
    expect(query(db, "SELECT * FROM deployments")).toHaveLength(3);

    const res = await DELETE(plainRequest("DELETE", URL_BASE), routeCtx(id));
    expect(res.status).toBe(200);

    // 回归守卫:sql.js 时期 save()/export() 会把 PRAGMA foreign_keys 重置为 0,
    // 导致这里留下孤儿部署记录。换驱动后 PRAGMA 是连接级一次性设置,
    // 但级联行为本身仍必须成立,这条断言继续守着。
    expect(query(db, "SELECT * FROM deployments")).toEqual([]);
  });

  it("级联不影响其他服务的部署记录", async () => {
    const keep = await seedService({ name: "keep" });
    const drop = await seedService({ name: "drop" });
    await seedDeployment(keep, { environment: "prod" });
    await seedDeployment(drop, { environment: "prod" });

    await DELETE(plainRequest("DELETE", URL_BASE), routeCtx(drop));

    const db = await getDb();
    const rows = query<{ service_id: number }>(db, "SELECT service_id FROM deployments");
    expect(rows).toHaveLength(1);
    expect(rows[0].service_id).toBe(keep);
  });

  it("404 服务不存在", async () => {
    const res = await DELETE(plainRequest("DELETE", URL_BASE), routeCtx(9999));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "服务不存在" });
  });

  it("400 无效 id", async () => {
    const res = await DELETE(plainRequest("DELETE", URL_BASE), routeCtx("abc"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "无效的 id" });
  });

  it("重复删除第二次返回 404", async () => {
    const id = await seedService({ name: "twice" });
    const first = await DELETE(plainRequest("DELETE", URL_BASE), routeCtx(id));
    const second = await DELETE(plainRequest("DELETE", URL_BASE), routeCtx(id));
    expect(first.status).toBe(200);
    expect(second.status).toBe(404);
  });

  it("删除后可以重用同名创建新服务", async () => {
    const id = await seedService({ name: "recycled" });
    await DELETE(plainRequest("DELETE", URL_BASE), routeCtx(id));
    await expect(seedService({ name: "recycled" })).resolves.toEqual(expect.any(Number));
  });
});

describe("变更事件广播", () => {
  it("PUT 200 后广播 service.updated", async () => {
    const id = await seedService({ name: "evt-upd" });
    const cap = captureEvents();
    try {
      const res = await PUT(jsonRequest("PUT", URL_BASE, { owner: "bob" }), routeCtx(id));
      expect(res.status).toBe(200);
      expect(cap.events).toEqual([{ type: "service.updated", serviceId: id }]);
    } finally {
      cap.stop();
    }
  });

  it("PUT 404 不广播", async () => {
    const cap = captureEvents();
    try {
      const res = await PUT(jsonRequest("PUT", URL_BASE, { owner: "x" }), routeCtx(9999));
      expect(res.status).toBe(404);
      expect(cap.events).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it("PUT 409（改成已存在的名字）不广播", async () => {
    await seedService({ name: "taken-evt" });
    const id = await seedService({ name: "mine-evt" });
    const cap = captureEvents();
    try {
      const res = await PUT(jsonRequest("PUT", URL_BASE, { name: "taken-evt" }), routeCtx(id));
      expect(res.status).toBe(409);
      expect(cap.events).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it("PUT 400（无效 id）不广播", async () => {
    const cap = captureEvents();
    try {
      const res = await PUT(jsonRequest("PUT", URL_BASE, { owner: "x" }), routeCtx("abc"));
      expect(res.status).toBe(400);
      expect(cap.events).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it("PUT 400（body 非法 JSON）不广播", async () => {
    const id = await seedService({ name: "bad-json-evt" });
    const cap = captureEvents();
    try {
      const res = await PUT(malformedRequest("PUT", URL_BASE), routeCtx(id));
      expect(res.status).toBe(400);
      expect(cap.events).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it("DELETE 200 后广播 service.deleted", async () => {
    const id = await seedService({ name: "evt-del" });
    const cap = captureEvents();
    try {
      const res = await DELETE(plainRequest("DELETE", URL_BASE), routeCtx(id));
      expect(res.status).toBe(200);
      expect(cap.events).toEqual([{ type: "service.deleted", serviceId: id }]);
    } finally {
      cap.stop();
    }
  });

  it("DELETE 级联删掉多条部署记录时仍只广播一条 service.deleted（事件数不随数据量增长）", async () => {
    const id = await seedService({ name: "evt-cascade" });
    for (let i = 0; i < 5; i++) await seedDeployment(id, { environment: "prod" });
    const cap = captureEvents();
    try {
      await DELETE(plainRequest("DELETE", URL_BASE), routeCtx(id));
      expect(cap.events).toEqual([{ type: "service.deleted", serviceId: id }]);
      // 记录确实被级联删了(客户端据 service.deleted 刷新部署列表是有依据的)
      const db = await getDb();
      expect(query(db, "SELECT id FROM deployments WHERE service_id = ?", [id])).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it("DELETE 404 不广播", async () => {
    const cap = captureEvents();
    try {
      const res = await DELETE(plainRequest("DELETE", URL_BASE), routeCtx(9999));
      expect(res.status).toBe(404);
      expect(cap.events).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it("DELETE 400（无效 id）不广播", async () => {
    const cap = captureEvents();
    try {
      const res = await DELETE(plainRequest("DELETE", URL_BASE), routeCtx("xyz"));
      expect(res.status).toBe(400);
      expect(cap.events).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it("GET 不广播事件（只读操作）", async () => {
    const id = await seedService({ name: "evt-get" });
    const cap = captureEvents();
    try {
      await GET(plainRequest("GET", `${URL_BASE}/${id}`), routeCtx(id));
      expect(cap.events).toEqual([]);
    } finally {
      cap.stop();
    }
  });
});
