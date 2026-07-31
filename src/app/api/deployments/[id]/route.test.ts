import { beforeEach, describe, expect, it } from "vitest";
import { getDb, query } from "@/lib/db";
import { PUT } from "@/app/api/deployments/[id]/route";
import {
  jsonRequest,
  malformedRequest,
  resetDb,
  routeCtx,
  seedDeployment,
  seedService,
  TIMESTAMP_RE,
} from "@/test/helpers";

const URL_BASE = "http://localhost:3000/api/deployments";

beforeEach(async () => {
  await resetDb();
});

async function seedPending(): Promise<number> {
  const serviceId = await seedService({ name: `svc-${Math.random().toString(36).slice(2, 8)}` });
  return seedDeployment(serviceId, { environment: "prod", status: "pending" });
}

describe("PUT /api/deployments/[id]", () => {
  it("200 更新为 success", async () => {
    const id = await seedPending();
    const res = await PUT(jsonRequest("PUT", URL_BASE, { status: "success" }), routeCtx(id));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id, status: "success" });
  });

  it("200 更新为 failed", async () => {
    const id = await seedPending();
    const res = await PUT(jsonRequest("PUT", URL_BASE, { status: "failed" }), routeCtx(id));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "failed" });
  });

  it("200 更新为 pending", async () => {
    const id = await seedPending();
    const res = await PUT(jsonRequest("PUT", URL_BASE, { status: "pending" }), routeCtx(id));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "pending" });
  });

  it("状态变更真的落库", async () => {
    const id = await seedPending();
    await PUT(jsonRequest("PUT", URL_BASE, { status: "success" }), routeCtx(id));
    const db = await getDb();
    const [row] = query<{ status: string }>(
      db,
      "SELECT status FROM deployments WHERE id = ?",
      [id]
    );
    expect(row.status).toBe("success");
  });

  it("终态 success 会写入 finished_at", async () => {
    const id = await seedPending();
    const body = await (
      await PUT(jsonRequest("PUT", URL_BASE, { status: "success" }), routeCtx(id))
    ).json();
    expect(body.finished_at).toMatch(TIMESTAMP_RE);
  });

  it("终态 failed 会写入 finished_at", async () => {
    const id = await seedPending();
    const body = await (
      await PUT(jsonRequest("PUT", URL_BASE, { status: "failed" }), routeCtx(id))
    ).json();
    expect(body.finished_at).toMatch(TIMESTAMP_RE);
  });

  it("改回 pending 时 finished_at 保持原值(COALESCE 语义)", async () => {
    const id = await seedPending();
    const done = await (
      await PUT(jsonRequest("PUT", URL_BASE, { status: "success" }), routeCtx(id))
    ).json();
    const back = await (
      await PUT(jsonRequest("PUT", URL_BASE, { status: "pending" }), routeCtx(id))
    ).json();
    expect(back.status).toBe("pending");
    // COALESCE(null, finished_at) => 保留既有值,不会被清空
    expect(back.finished_at).toBe(done.finished_at);
  });

  it("首次置为 pending 时 finished_at 仍为 null", async () => {
    const id = await seedPending();
    const body = await (
      await PUT(jsonRequest("PUT", URL_BASE, { status: "pending" }), routeCtx(id))
    ).json();
    expect(body.finished_at).toBeNull();
  });

  it.each(["running", "ok", "SUCCESS", "Failed", "cancelled", ""])(
    "400 无效状态 %j",
    async (status) => {
      const id = await seedPending();
      const res = await PUT(jsonRequest("PUT", URL_BASE, { status }), routeCtx(id));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "无效状态" });
    }
  );

  it("400 status 缺失", async () => {
    const id = await seedPending();
    const res = await PUT(jsonRequest("PUT", URL_BASE, {}), routeCtx(id));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "无效状态" });
  });

  it.each([
    ["数字", 1],
    ["null", null],
    ["布尔", true],
    ["数组", ["success"]],
    ["对象", { value: "success" }],
  ])("400 status 类型非字符串(%s)", async (_label, status) => {
    const id = await seedPending();
    const res = await PUT(jsonRequest("PUT", URL_BASE, { status }), routeCtx(id));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "无效状态" });
  });

  it("400 无效状态时不改动数据库", async () => {
    const id = await seedPending();
    await PUT(jsonRequest("PUT", URL_BASE, { status: "bogus" }), routeCtx(id));
    const db = await getDb();
    const [row] = query<{ status: string }>(
      db,
      "SELECT status FROM deployments WHERE id = ?",
      [id]
    );
    expect(row.status).toBe("pending");
  });

  it("404 部署记录不存在", async () => {
    const res = await PUT(jsonRequest("PUT", URL_BASE, { status: "success" }), routeCtx(9999));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "部署记录不存在" });
  });

  it.each(["abc", "", "not-a-number"])("400 无效 id %j", async (bad) => {
    const res = await PUT(
      jsonRequest("PUT", URL_BASE, { status: "success" }),
      routeCtx(bad)
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "无效的 id" });
  });

  it.each(["0", "-1"])("400 非正数 id %s", async (bad) => {
    const res = await PUT(
      jsonRequest("PUT", URL_BASE, { status: "success" }),
      routeCtx(bad)
    );
    expect(res.status).toBe(400);
  });

  it("400 请求体不是合法 JSON", async () => {
    const id = await seedPending();
    const res = await PUT(malformedRequest("PUT", URL_BASE), routeCtx(id));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "请求体不是合法 JSON" });
  });

  it("校验顺序:无效 id 优先于无效状态", async () => {
    const res = await PUT(jsonRequest("PUT", URL_BASE, { status: "bogus" }), routeCtx("abc"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "无效的 id" });
  });

  it("校验顺序:无效状态优先于记录不存在(状态错时不查库)", async () => {
    const res = await PUT(jsonRequest("PUT", URL_BASE, { status: "bogus" }), routeCtx(9999));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "无效状态" });
  });

  it("只影响目标记录,不动其他记录", async () => {
    const serviceId = await seedService({ name: "multi" });
    const a = await seedDeployment(serviceId, { environment: "test", status: "pending" });
    const b = await seedDeployment(serviceId, { environment: "prod", status: "pending" });

    await PUT(jsonRequest("PUT", URL_BASE, { status: "success" }), routeCtx(a));

    const db = await getDb();
    const rows = query<{ id: number; status: string }>(
      db,
      "SELECT id, status FROM deployments ORDER BY id"
    );
    expect(rows).toEqual([
      { id: a, status: "success" },
      { id: b, status: "pending" },
    ]);
  });

  it("连续两次更新为终态,后一次覆盖状态", async () => {
    const id = await seedPending();
    await PUT(jsonRequest("PUT", URL_BASE, { status: "success" }), routeCtx(id));
    const body = await (
      await PUT(jsonRequest("PUT", URL_BASE, { status: "failed" }), routeCtx(id))
    ).json();
    expect(body.status).toBe("failed");
  });
});
