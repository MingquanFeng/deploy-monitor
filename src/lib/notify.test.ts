import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeEvent } from "@/lib/events";
import { publish, subscriberCount } from "@/lib/events";
import { isNewFailure, startFailureNotifier } from "@/lib/notify";
import { resetDb, seedDeployment, seedService } from "@/test/helpers";

/**
 * 通知模块的测试策略：桩掉 `fetch`，断言「有没有发、发了什么」。
 *
 * 不去碰真实的 Server酱 API 是显然的；但更关键的是**不桩掉事件总线** —
 * 这套用例走的是完整链路 publish() → listener → 读库 → fetch，
 * 因为本次改动最容易坏的地方恰恰是链路的接缝（listener 没挂上、
 * 前态没带进事件、读库拿不到行），而不是消息拼接。
 *
 * 注意：import 本模块即会注册 listener（notify.ts 末尾有模块级副作用，
 * 那是生产环境的注册方式）。beforeEach 里拿到那个退订函数，
 * 用例结束后能把总线恢复干净。幂等：不会挂上第二个 listener。
 */

type FetchCall = { url: string; body: Record<string, unknown> };

function stubFetch(impl?: () => Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      if (impl) return impl();
      return new Response("{}", { status: 200 });
    })
  );
  return calls;
}

/** 等待 handle() 里的微任务排空。 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

let stopNotifier: (() => void) | null = null;

beforeEach(async () => {
  await resetDb();
  process.env.SERVERCHAN_KEY = "test-sendkey";
  // import 本模块时已注册（模块级副作用），这里复用那一个退订函数
  stopNotifier = startFailureNotifier();
});

afterEach(() => {
  stopNotifier?.();
  stopNotifier = null;
  vi.unstubAllGlobals();
  delete process.env.SERVERCHAN_KEY;
  // 每个用例结束时总线必须干净
  expect(subscriberCount()).toBe(0);
});

/** 造一条 pending 记录并广播 pending → failed 迁移事件。 */
async function failDeployment(
  overrides: {
    environment?: string;
    version?: string;
    deployed_by?: string;
    serviceName?: string;
  } = {}
): Promise<void> {
  const serviceId = await seedService({
    name: overrides.serviceName ?? `svc-${Math.random().toString(36).slice(2, 8)}`,
  });
  const deploymentId = await seedDeployment(serviceId, {
    environment: overrides.environment ?? "prod",
    version: overrides.version ?? "v1.2.3",
    status: "pending",
    deployed_by: overrides.deployed_by ?? "alice",
  });
  publish({
    type: "deployment.updated",
    deploymentId,
    serviceId,
    status: "failed",
    previousStatus: "pending",
  });
}

describe("isNewFailure — 状态迁移判定", () => {
  it("pending → failed 是新故障", () => {
    expect(
      isNewFailure({
        type: "deployment.updated",
        deploymentId: 1,
        serviceId: 1,
        status: "failed",
        previousStatus: "pending",
      })
    ).toBe(true);
  });

  it("failed → failed 不是", () => {
    expect(
      isNewFailure({
        type: "deployment.updated",
        deploymentId: 1,
        serviceId: 1,
        status: "failed",
        previousStatus: "failed",
      })
    ).toBe(false);
  });

  it("success → failed 不是（人工纠正记录）", () => {
    expect(
      isNewFailure({
        type: "deployment.updated",
        deploymentId: 1,
        serviceId: 1,
        status: "failed",
        previousStatus: "success",
      })
    ).toBe(false);
  });

  it.each(["pending", "success"] as const)("迁移到 %s 不是故障", (s) => {
    expect(
      isNewFailure({
        type: "deployment.updated",
        deploymentId: 1,
        serviceId: 1,
        status: s,
        previousStatus: "pending",
      })
    ).toBe(false);
  });

  it("deployment.created 不推", () => {
    expect(
      isNewFailure({ type: "deployment.created", deploymentId: 1, serviceId: 1, status: "failed" })
    ).toBe(false);
  });

  it.each([
    ["service.created", { type: "service.created", serviceId: 1 }],
    ["service.updated", { type: "service.updated", serviceId: 1 }],
    ["service.deleted", { type: "service.deleted", serviceId: 1 }],
  ] as Array<[string, ChangeEvent]>)("服务事件 %s 不推", (_label, event) => {
    expect(isNewFailure(event)).toBe(false);
  });

  it("缺 previousStatus 时不推（宁可少推不误推）", () => {
    expect(
      isNewFailure({
        type: "deployment.updated",
        deploymentId: 1,
        serviceId: 1,
        status: "failed",
      })
    ).toBe(false);
  });
});

describe("推送触发条件", () => {
  it("pending → failed 会调用 Server酱 send", async () => {
    const calls = stubFetch();
    await failDeployment();
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://sctapi.ftqq.com/test-sendkey.send");
    expect(calls[0].body).toHaveProperty("title");
    expect(calls[0].body).toHaveProperty("desp");
  });

  it("非故障迁移不发请求", async () => {
    const calls = stubFetch();
    const serviceId = await seedService({ name: "no-push" });
    const deploymentId = await seedDeployment(serviceId, { status: "pending" });
    publish({
      type: "deployment.updated",
      deploymentId,
      serviceId,
      status: "success",
      previousStatus: "pending",
    });
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("重复标记 failed 只在首次迁移时推一次", async () => {
    const calls = stubFetch();
    const serviceId = await seedService({ name: "dedup" });
    const deploymentId = await seedDeployment(serviceId, { status: "pending" });

    publish({
      type: "deployment.updated",
      deploymentId,
      serviceId,
      status: "failed",
      previousStatus: "pending",
    });
    publish({
      type: "deployment.updated",
      deploymentId,
      serviceId,
      status: "failed",
      previousStatus: "failed",
    });
    publish({
      type: "deployment.updated",
      deploymentId,
      serviceId,
      status: "failed",
      previousStatus: "failed",
    });
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("记录已被删除时静默跳过", async () => {
    const calls = stubFetch();
    publish({
      type: "deployment.updated",
      deploymentId: 99999,
      serviceId: 1,
      status: "failed",
      previousStatus: "pending",
    });
    await flush();
    expect(calls).toHaveLength(0);
  });
});

describe("环境变量未配置时静默跳过", () => {
  it.each([
    ["缺 key", undefined],
    ["空串", ""],
    ["纯空白", "   "],
  ])("%s 不发请求", async (_label, key) => {
    if (key === undefined) delete process.env.SERVERCHAN_KEY;
    else process.env.SERVERCHAN_KEY = key;
    const calls = stubFetch();
    await failDeployment();
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("空白会被 trim（隐形空格是最常见的配置错）", async () => {
    process.env.SERVERCHAN_KEY = "  real-key  ";
    const calls = stubFetch();
    await failDeployment();
    await flush();
    expect(calls[0].url).toContain("/real-key.send");
  });
});

describe("消息内容", () => {
  it("标题含服务名与环境标识", async () => {
    const calls = stubFetch();
    await failDeployment({ serviceName: "user-service", environment: "prod" });
    await flush();
    expect(String(calls[0].body.title)).toContain("user-service");
    expect(String(calls[0].body.title)).toContain("生产");
  });

  it("生产标题带 [生产] 前缀", async () => {
    const calls = stubFetch();
    await failDeployment({ environment: "prod" });
    await flush();
    expect(String(calls[0].body.title)).toMatch(/^\[生产\]/);
  });

  it("非生产标题不含 [生产]", async () => {
    const calls = stubFetch();
    await failDeployment({ environment: "test" });
    await flush();
    expect(String(calls[0].body.title)).not.toMatch(/^\[生产\]/);
  });

  it("正文含全部字段", async () => {
    const calls = stubFetch();
    await failDeployment({
      serviceName: "order-service",
      environment: "staging",
      version: "v3.0.0",
      deployed_by: "bob",
    });
    await flush();
    const desp = String(calls[0].body.desp);
    expect(desp).toContain("order-service");
    expect(desp).toContain("预发");
    expect(desp).toContain("v3.0.0");
    expect(desp).toContain("bob");
    expect(desp).toContain("2026-01-01 00:00:00");
  });

  it("空 version / deployed_by 显示为 -", async () => {
    const calls = stubFetch();
    await failDeployment({ version: "", deployed_by: "" });
    await flush();
    const desp = String(calls[0].body.desp);
    expect(desp).toContain("版本：-");
    expect(desp).toContain("部署人：-");
  });
});

describe("发送失败不影响主流程", () => {
  it("HTTP 4xx/5xx 时只 warn，不抛错", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(async () => new Response("{}", { status: 400 }));
    await failDeployment();
    await flush();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("网络异常时只 warn，不抛错", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(async () => { throw new Error("ECONNREFUSED"); });
    await failDeployment();
    await flush();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("未配置时不打日志", async () => {
    delete process.env.SERVERCHAN_KEY;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch();
    await failDeployment();
    await flush();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("startFailureNotifier — 注册", () => {
  it("仅 import 即已注册（不需要显式调用）", async () => {
    // beforeEach 已拿到模块级副作用注册的那个，subscriberCount 应该是 1
    expect(subscriberCount()).toBe(1);
    const calls = stubFetch();
    await failDeployment();
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("重复调用只挂一个 listener", async () => {
    const before = subscriberCount();
    const second = startFailureNotifier();
    const third = startFailureNotifier();
    expect(subscriberCount()).toBe(before);
    expect(second).toBe(third);
  });

  it("退订后不再推送", async () => {
    stopNotifier?.();
    stopNotifier = null;
    const calls = stubFetch();
    await failDeployment();
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("退订后可重新注册", async () => {
    stopNotifier?.();
    stopNotifier = startFailureNotifier();
    const calls = stubFetch();
    await failDeployment();
    await flush();
    expect(calls).toHaveLength(1);
  });
});
