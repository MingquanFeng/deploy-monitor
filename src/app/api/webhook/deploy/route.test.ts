import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, query } from "@/lib/db";
import { POST } from "@/app/api/webhook/deploy/route";
import {
  jsonRequest,
  malformedRequest,
  resetDb,
  seedService,
  TIMESTAMP_RE,
} from "@/test/helpers";

const URL = "http://localhost:3000/api/webhook/deploy";
const TOKEN = "test-token-abc123";

/** 带正确 Bearer token 的请求 */
function authed(body: unknown) {
  return jsonRequest("POST", URL, body, { authorization: `Bearer ${TOKEN}` });
}

beforeEach(async () => {
  await resetDb();
  // 用 stubEnv 而不是直接赋值,vi.unstubAllEnvs() 能保证测试间不泄漏
  vi.stubEnv("WEBHOOK_TOKEN", TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/webhook/deploy — 鉴权", () => {
  it("503 服务端未配置 WEBHOOK_TOKEN", async () => {
    vi.stubEnv("WEBHOOK_TOKEN", "");
    const res = await POST(authed({ service: "x", environment: "prod" }));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "服务未配置 WEBHOOK_TOKEN，拒绝接入",
    });
  });

  it("401 完全没有 authorization 头", async () => {
    const res = await POST(jsonRequest("POST", URL, { service: "x", environment: "prod" }));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "鉴权失败" });
  });

  it("401 token 错误", async () => {
    const res = await POST(
      jsonRequest(
        "POST",
        URL,
        { service: "x", environment: "prod" },
        { authorization: "Bearer wrong-token" }
      )
    );
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "鉴权失败" });
  });

  it("401 authorization 为空串", async () => {
    const res = await POST(
      jsonRequest("POST", URL, { service: "x", environment: "prod" }, { authorization: "" })
    );
    expect(res.status).toBe(401);
  });

  it("401 Bearer 前缀但 token 为空", async () => {
    const res = await POST(
      jsonRequest(
        "POST",
        URL,
        { service: "x", environment: "prod" },
        { authorization: "Bearer " }
      )
    );
    expect(res.status).toBe(401);
  });

  it("裸 token(不带 Bearer 前缀)也被接受", async () => {
    const name = "bare-token-svc";
    await seedService({ name });
    const res = await POST(
      jsonRequest("POST", URL, { service: name, environment: "prod" }, { authorization: TOKEN })
    );
    expect(res.status).toBe(201);
  });

  it.each(["bearer", "BEARER", "Bearer", "BeArEr"])(
    "Bearer 前缀大小写不敏感(%s)",
    async (prefix) => {
      const name = `case-${prefix.toLowerCase()}-${prefix}`;
      await seedService({ name });
      const res = await POST(
        jsonRequest(
          "POST",
          URL,
          { service: name, environment: "prod" },
          { authorization: `${prefix} ${TOKEN}` }
        )
      );
      expect(res.status).toBe(201);
    }
  );

  it("已知行为:token 本身大小写不敏感会被拒(token 比较是精确匹配)", async () => {
    const res = await POST(
      jsonRequest(
        "POST",
        URL,
        { service: "x", environment: "prod" },
        { authorization: `Bearer ${TOKEN.toUpperCase()}` }
      )
    );
    expect(res.status).toBe(401);
  });

  it("鉴权失败时不写库", async () => {
    const name = "no-write";
    await seedService({ name });
    await POST(
      jsonRequest(
        "POST",
        URL,
        { service: name, environment: "prod" },
        { authorization: "Bearer nope" }
      )
    );
    const db = await getDb();
    expect(query(db, "SELECT * FROM deployments")).toEqual([]);
  });

  it("鉴权先于 body 解析(坏 token + 坏 body 返回 401)", async () => {
    const res = await POST(
      malformedRequest("POST", URL, { authorization: "Bearer wrong" })
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /api/webhook/deploy — 入参校验", () => {
  it("400 请求体不是合法 JSON", async () => {
    const res = await POST(
      malformedRequest("POST", URL, { authorization: `Bearer ${TOKEN}` })
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "请求体不是合法 JSON" });
  });

  it("400 service 缺失", async () => {
    const res = await POST(authed({ environment: "prod" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "service 必填" });
  });

  it("400 service 为空串", async () => {
    const res = await POST(authed({ service: "", environment: "prod" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "service 必填" });
  });

  it("400 service 只有空白字符(被 trim 后为空)", async () => {
    const res = await POST(authed({ service: "   ", environment: "prod" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "service 必填" });
  });

  it("400 service 类型非字符串", async () => {
    const res = await POST(authed({ service: 123, environment: "prod" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "service 必填" });
  });

  it.each(["dev", "production", "PROD", "", "staging "])(
    "400 非法环境 %j",
    async (environment) => {
      await seedService({ name: "svc" });
      const res = await POST(authed({ service: "svc", environment }));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: "environment 必须为 test/staging/prod",
      });
    }
  );

  it("400 environment 缺失", async () => {
    await seedService({ name: "svc" });
    const res = await POST(authed({ service: "svc" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "environment 必须为 test/staging/prod",
    });
  });

  it.each(["running", "ok", "SUCCESS", "cancelled"])(
    "400 非法 status %j",
    async (status) => {
      await seedService({ name: "svc" });
      const res = await POST(authed({ service: "svc", environment: "prod", status }));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: "status 必须为 pending/success/failed",
      });
    }
  );

  it("校验顺序:service 缺失优先于环境非法", async () => {
    const res = await POST(authed({ environment: "bogus" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "service 必填" });
  });

  it("校验顺序:环境非法优先于状态非法", async () => {
    await seedService({ name: "svc" });
    const res = await POST(
      authed({ service: "svc", environment: "bogus", status: "bogus" })
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "environment 必须为 test/staging/prod",
    });
  });

  it("入参校验失败时不写库", async () => {
    await seedService({ name: "svc" });
    await POST(authed({ service: "svc", environment: "bogus" }));
    const db = await getDb();
    expect(query(db, "SELECT * FROM deployments")).toEqual([]);
  });
});

describe("POST /api/webhook/deploy — 服务查找", () => {
  it("404 服务不存在,错误信息带上服务名", async () => {
    const res = await POST(authed({ service: "ghost-svc", environment: "prod" }));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "服务不存在: ghost-svc" });
  });

  it("404 服务名大小写不匹配(按名精确匹配)", async () => {
    await seedService({ name: "lower-case-svc" });
    const res = await POST(authed({ service: "LOWER-CASE-SVC", environment: "prod" }));
    expect(res.status).toBe(404);
  });

  it("404 时不写库", async () => {
    await POST(authed({ service: "ghost", environment: "prod" }));
    const db = await getDb();
    expect(query(db, "SELECT * FROM deployments")).toEqual([]);
  });

  it("service 两侧空白被 trim 后仍能匹配到服务", async () => {
    await seedService({ name: "trimmed-svc" });
    const res = await POST(authed({ service: "  trimmed-svc  ", environment: "prod" }));
    expect(res.status).toBe(201);
  });
});

describe("POST /api/webhook/deploy — 成功写入", () => {
  it("201 创建部署记录,默认 status 为 success", async () => {
    const serviceId = await seedService({ name: "web-svc" });
    const res = await POST(
      authed({
        service: "web-svc",
        environment: "prod",
        version: "v2.0.0",
        deployed_by: "ci-bot",
        note: "自动发布",
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      service_id: serviceId,
      environment: "prod",
      version: "v2.0.0",
      status: "success",
      deployed_by: "ci-bot",
      note: "自动发布",
    });
  });

  it("201 数据真的落库", async () => {
    const serviceId = await seedService({ name: "web-svc" });
    await POST(authed({ service: "web-svc", environment: "staging" }));
    const db = await getDb();
    expect(
      query(db, "SELECT * FROM deployments WHERE service_id = ?", [serviceId])
    ).toHaveLength(1);
  });

  it("终态(默认 success)时 started_at 与 finished_at 都写入且相等", async () => {
    await seedService({ name: "web-svc" });
    const body = await (await POST(authed({ service: "web-svc", environment: "prod" }))).json();
    expect(body.started_at).toMatch(TIMESTAMP_RE);
    expect(body.finished_at).toMatch(TIMESTAMP_RE);
    expect(body.finished_at).toBe(body.started_at);
  });

  it("status=failed 时也写入 finished_at", async () => {
    await seedService({ name: "web-svc" });
    const body = await (
      await POST(authed({ service: "web-svc", environment: "prod", status: "failed" }))
    ).json();
    expect(body.status).toBe("failed");
    expect(body.finished_at).toMatch(TIMESTAMP_RE);
  });

  it("status=pending 时 finished_at 为 null", async () => {
    await seedService({ name: "web-svc" });
    const body = await (
      await POST(authed({ service: "web-svc", environment: "prod", status: "pending" }))
    ).json();
    expect(body.status).toBe("pending");
    expect(body.finished_at).toBeNull();
  });

  it.each(["test", "staging", "prod"])("201 接受合法环境 %s", async (environment) => {
    await seedService({ name: `svc-${environment}` });
    const res = await POST(authed({ service: `svc-${environment}`, environment }));
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ environment });
  });

  it("可选字段缺省时落库为空串", async () => {
    await seedService({ name: "web-svc" });
    const body = await (await POST(authed({ service: "web-svc", environment: "prod" }))).json();
    expect(body.version).toBe("");
    expect(body.deployed_by).toBe("");
    expect(body.note).toBe("");
  });

  it("非字符串的可选字段被忽略为空串,而不是写进脏数据", async () => {
    await seedService({ name: "web-svc" });
    const body = await (
      await POST(
        authed({
          service: "web-svc",
          environment: "prod",
          version: 123,
          deployed_by: null,
          note: { a: 1 },
        })
      )
    ).json();
    expect(body.version).toBe("");
    expect(body.deployed_by).toBe("");
    expect(body.note).toBe("");
  });

  it("重复调用产生多条记录,返回的是最新那条", async () => {
    await seedService({ name: "web-svc" });
    await POST(authed({ service: "web-svc", environment: "prod", version: "v1" }));
    const second = await (
      await POST(authed({ service: "web-svc", environment: "prod", version: "v2" }))
    ).json();
    expect(second.version).toBe("v2");
    const db = await getDb();
    expect(query(db, "SELECT * FROM deployments")).toHaveLength(2);
  });

  it("多个服务互不干扰", async () => {
    const a = await seedService({ name: "svc-a" });
    const b = await seedService({ name: "svc-b" });
    await POST(authed({ service: "svc-a", environment: "prod" }));
    await POST(authed({ service: "svc-b", environment: "test" }));
    const db = await getDb();
    const rows = query<{ service_id: number; environment: string }>(
      db,
      "SELECT service_id, environment FROM deployments ORDER BY id"
    );
    expect(rows).toEqual([
      { service_id: a, environment: "prod" },
      { service_id: b, environment: "test" },
    ]);
  });
});
