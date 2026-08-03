import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publish, subscriberCount } from "@/lib/events";
import { isNewFailure, startFailureNotifier } from "@/lib/notify";
import { resetDb, seedDeployment, seedService } from "@/test/helpers";

/** 把 fetch 桩成一个收集器：每条请求记下 URL + body。 */
function stubFetch(): { url: string; body: Record<string, unknown> }[] {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response("{}", { status: 200 });
  }));
  return calls;
}

/** 等 microtask + setImmediate 排空,让异步 listener 跑完。 */
const flush = () => new Promise((r) => setImmediate(r));

let stop: (() => void) | null = null;

beforeEach(async () => {
  await resetDb();
  process.env.SERVERCHAN_KEY = "k";
  stop = startFailureNotifier();
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.unstubAllGlobals();
  delete process.env.SERVERCHAN_KEY;
  expect(subscriberCount()).toBe(0);
});

async function fail(overrides: {
  environment?: string;
  serviceName?: string;
  deployed_by?: string;
  version?: string;
} = {}) {
  const serviceId = await seedService({ name: overrides.serviceName ?? `svc-${Math.random().toString(36).slice(2, 8)}` });
  const deploymentId = await seedDeployment(serviceId, {
    environment: overrides.environment ?? "prod",
    version: overrides.version ?? "v1",
    deployed_by: overrides.deployed_by ?? "alice",
    status: "pending",
  });
  publish({
    type: "deployment.updated",
    deploymentId,
    serviceId,
    status: "failed",
    previousStatus: "pending",
  });
}

describe("isNewFailure", () => {
  it("pending→failed 是新故障", () => {
    expect(
      isNewFailure({ type: "deployment.updated", deploymentId: 1, serviceId: 1, status: "failed", previousStatus: "pending" })
    ).toBe(true);
  });
  it.each([
    ["failed→failed", "failed", "failed"],
    ["success→failed", "failed", "success"],
    ["pending→success", "success", "pending"],
    ["pending→pending", "pending", "pending"],
    ["deployment.created", undefined, undefined],
    ["service.deleted", undefined, undefined],
  ] as const)("%s 不是", (_label, status, prev) => {
    const event = prev === undefined
      ? { type: "deployment.created", deploymentId: 1, serviceId: 1 } as const
      : { type: "deployment.updated" as const, deploymentId: 1, serviceId: 1, status, previousStatus: prev };
    expect(isNewFailure(event)).toBe(false);
  });
  it("缺 previousStatus 不推", () => {
    expect(isNewFailure({ type: "deployment.updated", deploymentId: 1, serviceId: 1, status: "failed" })).toBe(false);
  });
});

describe("推送触发", () => {
  it("pending→failed 调一次 Server酱,带正确 URL 和字段", async () => {
    const calls = stubFetch();
    await fail({ serviceName: "svc", environment: "prod", version: "v1", deployed_by: "alice" });
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://sctapi.ftqq.com/k.send");
    expect(String(calls[0].body.title)).toBe("[生产] svc 部署失败");
    expect(calls[0].body.desp).toContain("服务：svc");
    expect(calls[0].body.desp).toContain("环境：生产");
    expect(calls[0].body.desp).toContain("版本：v1");
    expect(calls[0].body.desp).toContain("部署人：alice");
  });
  it("同条记录重复标记 failed 只推一次", async () => {
    const calls = stubFetch();
    const serviceId = await seedService({ name: "dedup" });
    const deploymentId = await seedDeployment(serviceId, { status: "pending" });
    // 第一次:pending→failed 必推
    publish({ type: "deployment.updated", deploymentId, serviceId, status: "failed", previousStatus: "pending" });
    // 之后两次:failed→failed 不推
    publish({ type: "deployment.updated", deploymentId, serviceId, status: "failed", previousStatus: "failed" });
    publish({ type: "deployment.updated", deploymentId, serviceId, status: "failed", previousStatus: "failed" });
    await flush();
    expect(calls).toHaveLength(1);
  });
  it("记录被删后静默跳过", async () => {
    const calls = stubFetch();
    publish({ type: "deployment.updated", deploymentId: 99999, serviceId: 1, status: "failed", previousStatus: "pending" });
    await flush();
    expect(calls).toHaveLength(0);
  });
});

describe("未配置", () => {
  it.each([undefined, "", "   "])("SERVERCHAN_KEY=%j 不推", async (v) => {
    if (v === undefined) delete process.env.SERVERCHAN_KEY;
    else process.env.SERVERCHAN_KEY = v;
    const calls = stubFetch();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await fail();
    await flush();
    expect(calls).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("发送失败不抛错", () => {
  it("HTTP 4xx 只 warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 500 })));
    await fail();
    await flush();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it("网络异常只 warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    await fail();
    await flush();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("注册幂等", () => {
  it("import 即已注册,重复调用只挂一个 listener", async () => {
    expect(subscriberCount()).toBe(1);
    const calls = stubFetch();
    await fail();
    await flush();
    expect(calls).toHaveLength(1);
    const s1 = startFailureNotifier();
    const s2 = startFailureNotifier();
    expect(s1).toBe(s2);
  });
});