import { beforeEach, describe, expect, it } from "vitest";
import { getDb, query } from "@/lib/db";
import { GET, PUT } from "@/app/api/deployments/[id]/route";
import {
  jsonRequest,
  malformedRequest,
  plainRequest,
  resetDb,
  routeCtx,
  seedDeployment,
  seedService,
  TIMESTAMP_RE,
  captureEvents,
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

describe("PUT /api/deployments/[id] — 变更事件广播", () => {
  it("200 后广播 deployment.updated，带 deploymentId 与 serviceId", async () => {
    const serviceId = await seedService({ name: "evt-dep-upd" });
    const id = await seedDeployment(serviceId, { environment: "prod", status: "pending" });
    const cap = captureEvents();
    try {
      const res = await PUT(jsonRequest("PUT", URL_BASE, { status: "success" }), routeCtx(id));
      expect(res.status).toBe(200);
      expect(cap.events).toEqual([
        {
          type: "deployment.updated",
          deploymentId: id,
          serviceId,
          status: "success",
          previousStatus: "pending",
        },
      ]);
    } finally {
      cap.stop();
    }
  });

  it("事件里的 serviceId 从库中读取（不来自请求体）", async () => {
    const serviceId = await seedService({ name: "evt-dep-svcid" });
    const id = await seedDeployment(serviceId, { environment: "test", status: "pending" });
    const cap = captureEvents();
    try {
      // 请求体里塞一个假的 service_id，事件必须无视它
      await PUT(
        jsonRequest("PUT", URL_BASE, { status: "failed", service_id: 99999 }),
        routeCtx(id)
      );
      expect(cap.events).toEqual([
        {
          type: "deployment.updated",
          deploymentId: id,
          serviceId,
          status: "failed",
          previousStatus: "pending",
        },
      ]);
    } finally {
      cap.stop();
    }
  });

  it("404 不广播", async () => {
    const cap = captureEvents();
    try {
      const res = await PUT(jsonRequest("PUT", URL_BASE, { status: "success" }), routeCtx(9999));
      expect(res.status).toBe(404);
      expect(cap.events).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it("400（无效状态）不广播", async () => {
    const id = await seedPending();
    const cap = captureEvents();
    try {
      const res = await PUT(jsonRequest("PUT", URL_BASE, { status: "canceled" }), routeCtx(id));
      expect(res.status).toBe(400);
      expect(cap.events).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it("400（无效 id）不广播", async () => {
    const cap = captureEvents();
    try {
      const res = await PUT(jsonRequest("PUT", URL_BASE, { status: "success" }), routeCtx("abc"));
      expect(res.status).toBe(400);
      expect(cap.events).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it("400（body 非法 JSON）不广播", async () => {
    const id = await seedPending();
    const cap = captureEvents();
    try {
      const res = await PUT(malformedRequest("PUT", URL_BASE), routeCtx(id));
      expect(res.status).toBe(400);
      expect(cap.events).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it("连续两次更新广播两条事件", async () => {
    const id = await seedPending();
    const cap = captureEvents();
    try {
      await PUT(jsonRequest("PUT", URL_BASE, { status: "success" }), routeCtx(id));
      await PUT(jsonRequest("PUT", URL_BASE, { status: "failed" }), routeCtx(id));
      expect(cap.events).toHaveLength(2);
      expect(cap.events.every((e) => e.type === "deployment.updated")).toBe(true);
    } finally {
      cap.stop();
    }
  });

  it("previousStatus 是改动前的状态，不是改动后的", async () => {
    const id = await seedPending();
    const cap = captureEvents();
    try {
      // pending → success → failed，第二条事件的前态必须是 success
      await PUT(jsonRequest("PUT", URL_BASE, { status: "success" }), routeCtx(id));
      await PUT(jsonRequest("PUT", URL_BASE, { status: "failed" }), routeCtx(id));
      expect(cap.events).toMatchObject([
        { previousStatus: "pending", status: "success" },
        { previousStatus: "success", status: "failed" },
      ]);
    } finally {
      cap.stop();
    }
  });

  it("状态未变时前后态相同（失败通知据此避免重复推送）", async () => {
    const serviceId = await seedService({ name: "evt-same-status" });
    const id = await seedDeployment(serviceId, { status: "failed" });
    const cap = captureEvents();
    try {
      await PUT(jsonRequest("PUT", URL_BASE, { status: "failed" }), routeCtx(id));
      expect(cap.events).toMatchObject([
        { previousStatus: "failed", status: "failed" },
      ]);
    } finally {
      cap.stop();
    }
  });
});

describe("GET /api/deployments/[id]", () => {
  it("200 返回正确字段", async () => {
    const serviceId = await seedService({ name: "svc-get" });
    const id = await seedDeployment(serviceId, {
      environment: "prod",
      version: "v2.0.0",
      deployed_by: "alice",
    });
    const res = await GET(plainRequest("GET", `${URL_BASE}/${id}`), routeCtx(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.service_name).toBe("svc-get");
    expect(body).toMatchObject({
      id,
      service_id: serviceId,
      environment: "prod",
      version: "v2.0.0",
      deployed_by: "alice",
    });
  });

  it("200 字段类型完整", async () => {
    const serviceId = await seedService({ name: "svc-get" });
    const id = await seedDeployment(serviceId, {
      status: "pending",
      started_at: "2026-06-01 12:00:00",
    });
    const body = await (await GET(plainRequest("GET", `${URL_BASE}/${id}`), routeCtx(id))).json();
    expect(body).toEqual({
      id,
      service_id: serviceId,
      service_name: "svc-get",
      environment: "prod",
      version: "v1.0.0",
      status: "pending",
      deployed_by: "",
      note: "",
      started_at: "2026-06-01 12:00:00",
      finished_at: null,
    });
  });

  it("200 终态记录 finished_at 匹配 TIMESTAMP_RE", async () => {
    const serviceId = await seedService({ name: "get-finished-svc" });
    const id = await seedDeployment(serviceId, {
      status: "success",
      started_at: "2026-06-01 10:00:00",
    });
    const db = await getDb();
    db.prepare("UPDATE deployments SET finished_at = ? WHERE id = ?").run([
      "2026-06-01 10:05:00",
      id,
    ]);
    const body = await (await GET(plainRequest("GET", `${URL_BASE}/${id}`), routeCtx(id))).json();
    expect(body.finished_at).toMatch(TIMESTAMP_RE);
  });

  it("200 待处理记录 finished_at 为 null", async () => {
    const serviceId = await seedService({ name: "get-pending-svc" });
    const id = await seedDeployment(serviceId, { status: "pending" });
    const body = await (await GET(plainRequest("GET", `${URL_BASE}/${id}`), routeCtx(id))).json();
    expect(body.finished_at).toBeNull();
  });

  it("JOIN 语义：服务改名后 GET 返回新名", async () => {
    const serviceId = await seedService({ name: "svc-old" });
    const id = await seedDeployment(serviceId, { environment: "prod" });
    const db = await getDb();
    db.prepare("UPDATE services SET name = ? WHERE id = ?").run(["svc-new", serviceId]);
    const body = await (await GET(plainRequest("GET", `${URL_BASE}/${id}`), routeCtx(id))).json();
    expect(body.service_name).toBe("svc-new");
  });

  it("JOIN 语义：服务被删后返回 404（INNER JOIN）", async () => {
    const serviceId = await seedService({ name: "get-orphan-svc" });
    const id = await seedDeployment(serviceId, { environment: "staging" });
    const db = await getDb();
    db.prepare("DELETE FROM services WHERE id = ?").run([serviceId]);
    const res = await GET(plainRequest("GET", `${URL_BASE}/${id}`), routeCtx(id));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "部署记录不存在" });
  });

  it("404 部署记录不存在", async () => {
    const res = await GET(plainRequest("GET", `${URL_BASE}/9999`), routeCtx(9999));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "部署记录不存在" });
  });

  it.each(["abc", "", "not-a-number"])("400 无效 id %j", async (bad) => {
    const res = await GET(plainRequest("GET", `${URL_BASE}/${bad}`), routeCtx(bad));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "无效的 id" });
  });

  it("400 id 空串", async () => {
    const res = await GET(plainRequest("GET", `${URL_BASE}/`), routeCtx(""));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "无效的 id" });
  });

  it.each(["0", "-1"])("400 非正数 id %s", async (bad) => {
    const res = await GET(plainRequest("GET", `${URL_BASE}/${bad}`), routeCtx(bad));
    expect(res.status).toBe(400);
  });

  it("GET 不广播事件（只读操作）", async () => {
    const serviceId = await seedService({ name: "evt-get-no-broadcast" });
    const id = await seedDeployment(serviceId, { environment: "prod" });
    const cap = captureEvents();
    try {
      await GET(plainRequest("GET", `${URL_BASE}/${id}`), routeCtx(id));
      expect(cap.events).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it("GET 与 PUT 闭环：PUT 更新后 GET 能读到新状态", async () => {
    const id = await seedPending();
    await PUT(jsonRequest("PUT", URL_BASE, { status: "success" }), routeCtx(id));
    const body = await (
      await GET(plainRequest("GET", `${URL_BASE}/${id}`), routeCtx(id))
    ).json();
    expect(body.status).toBe("success");
    expect(body.finished_at).toMatch(TIMESTAMP_RE);
  });

  it("能查到不同环境的部署记录", async () => {
    const serviceId = await seedService({ name: "get-multi-env" });
    const testId = await seedDeployment(serviceId, { environment: "test", status: "success" });
    const prodId = await seedDeployment(serviceId, { environment: "prod", status: "failed" });
    const stagingId = await seedDeployment(serviceId, { environment: "staging", status: "pending" });

    const testBody = await (
      await GET(plainRequest("GET", `${URL_BASE}/${testId}`), routeCtx(testId))
    ).json();
    const prodBody = await (
      await GET(plainRequest("GET", `${URL_BASE}/${prodId}`), routeCtx(prodId))
    ).json();
    const stagingBody = await (
      await GET(plainRequest("GET", `${URL_BASE}/${stagingId}`), routeCtx(stagingId))
    ).json();

    expect(testBody.environment).toBe("test");
    expect(prodBody.environment).toBe("prod");
    expect(stagingBody.environment).toBe("staging");
  });

  it("GET 不依赖 query string，同一 service 两条 deployment 按 id 返回目标记录", async () => {
    const serviceId = await seedService({ name: "get-query-independent" });
    const firstId = await seedDeployment(serviceId, { environment: "test", version: "v1" });
    const secondId = await seedDeployment(serviceId, { environment: "prod", version: "v2" });
    const body = await (
      await GET(
        plainRequest("GET", `${URL_BASE}/${firstId}?service_id=${serviceId}&env=prod`),
        routeCtx(firstId)
      )
    ).json();
    expect(body.id).toBe(firstId);
    expect(body.version).toBe("v1");
    expect(body.id).not.toBe(secondId);
  });

  it("数据真的从数据库读取（绕过 API 直接验库）", async () => {
    const serviceId = await seedService({ name: "get-db-read" });
    const id = await seedDeployment(serviceId, {
      environment: "staging",
      version: "v9.9.9",
      note: "hotfix-on-call",
    });
    const body = await (
      await GET(plainRequest("GET", `${URL_BASE}/${id}`), routeCtx(id))
    ).json();
    // 直接读库验证数据一致
    const db = await getDb();
    const [row] = query<{ version: string; note: string }>(
      db,
      "SELECT version, note FROM deployments WHERE id = ?",
      [id]
    );
    expect(body.version).toBe(row.version);
    expect(body.note).toBe(row.note);
  });
});
