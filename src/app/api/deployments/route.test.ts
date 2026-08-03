import { beforeEach, describe, expect, it } from "vitest";
import { getDb, query } from "@/lib/db";
import { GET, POST } from "@/app/api/deployments/route";
import {
  jsonRequest,
  malformedRequest,
  plainRequest,
  resetDb,
  seedDeployment,
  seedService,
  TIMESTAMP_RE,
  captureEvents,
} from "@/test/helpers";

const URL_BASE = "http://localhost:3000/api/deployments";

beforeEach(async () => {
  await resetDb();
});

describe("GET /api/deployments", () => {
  it("无数据时返回空数组", async () => {
    const res = await GET(plainRequest("GET", URL_BASE));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([]);
  });

  it("JOIN 出 service_name", async () => {
    const id = await seedService({ name: "svc-join" });
    await seedDeployment(id, { environment: "prod" });
    const body = await (await GET(plainRequest("GET", URL_BASE))).json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ service_id: id, service_name: "svc-join" });
  });

  it("按 service_id 过滤", async () => {
    const a = await seedService({ name: "svc-a" });
    const b = await seedService({ name: "svc-b" });
    await seedDeployment(a, { environment: "prod" });
    await seedDeployment(b, { environment: "prod" });

    const res = await GET(plainRequest("GET", `${URL_BASE}?service_id=${a}`));
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].service_id).toBe(a);
  });

  it("按 env 过滤", async () => {
    const id = await seedService({ name: "svc" });
    await seedDeployment(id, { environment: "test" });
    await seedDeployment(id, { environment: "prod" });

    const body = await (await GET(plainRequest("GET", `${URL_BASE}?env=prod`))).json();
    expect(body).toHaveLength(1);
    expect(body[0].environment).toBe("prod");
  });

  it("service_id 与 env 组合过滤", async () => {
    const a = await seedService({ name: "svc-a" });
    const b = await seedService({ name: "svc-b" });
    await seedDeployment(a, { environment: "prod" });
    await seedDeployment(a, { environment: "test" });
    await seedDeployment(b, { environment: "prod" });

    const body = await (
      await GET(plainRequest("GET", `${URL_BASE}?service_id=${a}&env=prod`))
    ).json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ service_id: a, environment: "prod" });
  });

  it("过滤条件无匹配时返回空数组", async () => {
    const id = await seedService({ name: "svc" });
    await seedDeployment(id, { environment: "prod" });
    const body = await (await GET(plainRequest("GET", `${URL_BASE}?env=test`))).json();
    expect(body).toEqual([]);
  });

  it("按 started_at 倒序返回", async () => {
    const id = await seedService({ name: "svc" });
    await seedDeployment(id, { environment: "test", started_at: "2026-01-01 00:00:00" });
    await seedDeployment(id, { environment: "staging", started_at: "2026-03-01 00:00:00" });
    await seedDeployment(id, { environment: "prod", started_at: "2026-02-01 00:00:00" });

    const body = await (await GET(plainRequest("GET", URL_BASE))).json();
    expect(body.map((d: { started_at: string }) => d.started_at)).toEqual([
      "2026-03-01 00:00:00",
      "2026-02-01 00:00:00",
      "2026-01-01 00:00:00",
    ]);
  });

  it("非法 env 过滤值不报错,只是查不到", async () => {
    const id = await seedService({ name: "svc" });
    await seedDeployment(id, { environment: "prod" });
    const res = await GET(plainRequest("GET", `${URL_BASE}?env=bogus`));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([]);
  });

  it("JOIN 语义:服务被删后其部署记录不再出现", async () => {
    const id = await seedService({ name: "gone" });
    await seedDeployment(id, { environment: "prod" });
    const db = await getDb();
    db.prepare("DELETE FROM services WHERE id = ?").run([id]);
    const body = await (await GET(plainRequest("GET", URL_BASE))).json();
    expect(body).toEqual([]);
  });
});

describe("POST /api/deployments", () => {
  it("201 创建成功", async () => {
    const id = await seedService({ name: "svc" });
    const res = await POST(
      jsonRequest("POST", URL_BASE, {
        service_id: id,
        environment: "prod",
        version: "v1.2.3",
        deployed_by: "alice",
        note: "hotfix",
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      service_id: id,
      environment: "prod",
      version: "v1.2.3",
      deployed_by: "alice",
      note: "hotfix",
      status: "pending",
    });
    expect(body.started_at).toMatch(TIMESTAMP_RE);
  });

  it("201 新建记录初始状态为 pending、finished_at 为 null", async () => {
    const id = await seedService({ name: "svc" });
    const body = await (
      await POST(jsonRequest("POST", URL_BASE, { service_id: id, environment: "test" }))
    ).json();
    expect(body.status).toBe("pending");
    expect(body.finished_at).toBeNull();
  });

  it("201 数据真的落库", async () => {
    const id = await seedService({ name: "svc" });
    await POST(jsonRequest("POST", URL_BASE, { service_id: id, environment: "staging" }));
    const db = await getDb();
    expect(query(db, "SELECT * FROM deployments WHERE service_id = ?", [id])).toHaveLength(1);
  });

  it("可选字段缺省时落库为空串", async () => {
    const id = await seedService({ name: "svc" });
    const body = await (
      await POST(jsonRequest("POST", URL_BASE, { service_id: id, environment: "prod" }))
    ).json();
    expect(body.version).toBe("");
    expect(body.deployed_by).toBe("");
    expect(body.note).toBe("");
  });

  it.each(["test", "staging", "prod"])("201 接受合法环境 %s", async (env) => {
    const id = await seedService({ name: `svc-${env}` });
    const res = await POST(
      jsonRequest("POST", URL_BASE, { service_id: id, environment: env })
    );
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ environment: env });
  });

  it("400 缺少 service_id", async () => {
    const res = await POST(jsonRequest("POST", URL_BASE, { environment: "prod" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "service_id 和 environment 必填",
    });
  });

  it("400 缺少 environment", async () => {
    const id = await seedService({ name: "svc" });
    const res = await POST(jsonRequest("POST", URL_BASE, { service_id: id }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "service_id 和 environment 必填",
    });
  });

  it("400 两者都缺", async () => {
    const res = await POST(jsonRequest("POST", URL_BASE, {}));
    expect(res.status).toBe(400);
  });

  it("400 service_id 为 0(falsy 被当作缺失)", async () => {
    const res = await POST(
      jsonRequest("POST", URL_BASE, { service_id: 0, environment: "prod" })
    );
    expect(res.status).toBe(400);
  });

  it("400 environment 为空串", async () => {
    const id = await seedService({ name: "svc" });
    const res = await POST(
      jsonRequest("POST", URL_BASE, { service_id: id, environment: "" })
    );
    expect(res.status).toBe(400);
  });

  it("400 时不写库", async () => {
    await POST(jsonRequest("POST", URL_BASE, { environment: "prod" }));
    const db = await getDb();
    expect(query(db, "SELECT * FROM deployments")).toEqual([]);
  });

  it("400 请求体不是合法 JSON", async () => {
    const res = await POST(malformedRequest("POST", URL_BASE));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "请求体不是合法 JSON" });
  });

  it("service_id 传字符串数字也能工作", async () => {
    const id = await seedService({ name: "svc" });
    const res = await POST(
      jsonRequest("POST", URL_BASE, { service_id: String(id), environment: "prod" })
    );
    expect(res.status).toBe(201);
  });

  it("非法 environment 返回 400", async () => {
    const id = await seedService({ name: "svc" });
    const res = await POST(
      jsonRequest("POST", URL_BASE, { service_id: id, environment: "dev" })
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "environment 必须为 test/staging/prod",
    });
  });

  it("service_id 指向不存在的服务返回 404", async () => {
    const res = await POST(
      jsonRequest("POST", URL_BASE, { service_id: 99999, environment: "prod" })
    );
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "服务不存在" });
  });

  it("同服务同环境可重复部署,GET 能拿到多条", async () => {
    const id = await seedService({ name: "svc" });
    await POST(jsonRequest("POST", URL_BASE, { service_id: id, environment: "prod" }));
    await POST(jsonRequest("POST", URL_BASE, { service_id: id, environment: "prod" }));
    const body = await (await GET(plainRequest("GET", URL_BASE))).json();
    expect(body).toHaveLength(2);
  });

  it("返回的是最新插入的那条(同服务同环境按 id 倒序取 1)", async () => {
    const id = await seedService({ name: "svc" });
    await POST(
      jsonRequest("POST", URL_BASE, { service_id: id, environment: "prod", version: "v1" })
    );
    const second = await (
      await POST(
        jsonRequest("POST", URL_BASE, { service_id: id, environment: "prod", version: "v2" })
      )
    ).json();
    expect(second.version).toBe("v2");
  });

  it("POST 后 GET 能读到(读写闭环)", async () => {
    const id = await seedService({ name: "loop" });
    await POST(
      jsonRequest("POST", URL_BASE, { service_id: id, environment: "prod", version: "v9" })
    );
    const body = await (await GET(plainRequest("GET", URL_BASE))).json();
    expect(body[0]).toMatchObject({ version: "v9", service_name: "loop" });
  });
});

describe("POST /api/deployments — 变更事件广播", () => {
  it("201 后广播 deployment.created，带 deploymentId 与 serviceId", async () => {
    const serviceId = await seedService({ name: "evt-dep" });
    const cap = captureEvents();
    try {
      const body = await (
        await POST(jsonRequest("POST", URL_BASE, { service_id: serviceId, environment: "prod" }))
      ).json();
      expect(cap.events).toEqual([
        { type: "deployment.created", deploymentId: body.id, serviceId },
      ]);
    } finally {
      cap.stop();
    }
  });

  it("400（缺 service_id / environment）不广播", async () => {
    const cap = captureEvents();
    try {
      expect((await POST(jsonRequest("POST", URL_BASE, {}))).status).toBe(400);
      expect(cap.events).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it("400（非法 environment）不广播", async () => {
    const serviceId = await seedService({ name: "evt-badenv" });
    const cap = captureEvents();
    try {
      const res = await POST(
        jsonRequest("POST", URL_BASE, { service_id: serviceId, environment: "qa" })
      );
      expect(res.status).toBe(400);
      expect(cap.events).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it("400（body 非法 JSON）不广播", async () => {
    const cap = captureEvents();
    try {
      expect((await POST(malformedRequest("POST", URL_BASE))).status).toBe(400);
      expect(cap.events).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it("404（服务不存在）不广播", async () => {
    const cap = captureEvents();
    try {
      const res = await POST(
        jsonRequest("POST", URL_BASE, { service_id: 9999, environment: "prod" })
      );
      expect(res.status).toBe(404);
      expect(cap.events).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it("GET 不广播事件（只读操作）", async () => {
    const serviceId = await seedService({ name: "evt-dep-get" });
    await seedDeployment(serviceId, { environment: "prod" });
    const cap = captureEvents();
    try {
      await GET(plainRequest("GET", URL_BASE));
      expect(cap.events).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it("并发创建两条部署，两条事件的 deploymentId 各不相同", async () => {
    const serviceId = await seedService({ name: "evt-concurrent" });
    const cap = captureEvents();
    try {
      await Promise.all([
        POST(jsonRequest("POST", URL_BASE, { service_id: serviceId, environment: "prod" })),
        POST(jsonRequest("POST", URL_BASE, { service_id: serviceId, environment: "prod" })),
      ]);
      expect(cap.events).toHaveLength(2);
      const ids = cap.events.map((e) => (e as { deploymentId: number }).deploymentId);
      expect(new Set(ids).size).toBe(2);
      expect(cap.events.every((e) => e.type === "deployment.created")).toBe(true);
    } finally {
      cap.stop();
    }
  });
});
