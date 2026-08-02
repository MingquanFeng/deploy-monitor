import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publish, subscriberCount } from "@/lib/events";
import { GET } from "@/app/api/events/route";
import { plainRequest } from "@/test/helpers";

/**
 * 直接调用 route handler 拿到 Response，再手工读它的 body stream。
 * 不起 HTTP server —— SSE 的行为（响应头 / 帧格式 / 断开清理）全都在
 * ReadableStream 与 req.signal 这一层，本地构造就能完整覆盖。
 */

const URL_EVENTS = "http://localhost:3000/api/events";

/** 带 AbortSignal 的 GET 请求：模拟客户端断开。 */
function sseRequest(signal?: AbortSignal) {
  if (!signal) return plainRequest("GET", URL_EVENTS);
  return new Request(URL_EVENTS, { method: "GET", signal }) as never;
}

/** 读取流中的下一个 chunk 并解码成字符串。 */
async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const { value, done } = await reader.read();
  if (done) return null;
  return new TextDecoder().decode(value);
}

/** 收集已到达的所有 chunk（读到没有立即可用数据时靠调用方控制次数）。 */
async function readChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number
) {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const c = await readChunk(reader);
    if (c === null) break;
    out.push(c);
  }
  return out;
}

const openReaders: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
const controllers: AbortController[] = [];

function newController() {
  const ac = new AbortController();
  controllers.push(ac);
  return ac;
}

beforeEach(() => {
  // 事件总线是模块级单例，进入用例前必须是干净的（否则上个用例泄漏会被算到这个用例头上）
  expect(subscriberCount()).toBe(0);
});

afterEach(async () => {
  // 兜底清理：abort 所有连接、取消所有 reader，保证下个用例的前置断言成立
  controllers.forEach((ac) => !ac.signal.aborted && ac.abort());
  controllers.length = 0;
  await Promise.all(openReaders.map((r) => r.cancel().catch(() => {})));
  openReaders.length = 0;
  vi.useRealTimers();
});

describe("GET /api/events 响应头", () => {
  it("Content-Type 是 text/event-stream", async () => {
    const res = await GET(sseRequest(newController().signal));
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  });

  it("Cache-Control 禁止缓存与转换", async () => {
    const res = await GET(sseRequest(newController().signal));
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
  });

  it("Connection: keep-alive", async () => {
    const res = await GET(sseRequest(newController().signal));
    expect(res.headers.get("connection")).toBe("keep-alive");
  });

  it("X-Accel-Buffering: no（关闭 Nginx 响应缓冲，否则事件被扣在代理里）", async () => {
    const res = await GET(sseRequest(newController().signal));
    expect(res.headers.get("x-accel-buffering")).toBe("no");
  });

  it("status 200 且 body 非空", async () => {
    const res = await GET(sseRequest(newController().signal));
    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();
  });

  it("路由导出 force-dynamic，避免被静态化成已关闭的空流", async () => {
    const mod = await import("@/app/api/events/route");
    expect(mod.dynamic).toBe("force-dynamic");
  });

  it("路由跑在 nodejs runtime（要和 better-sqlite3 的写入点同进程）", async () => {
    const mod = await import("@/app/api/events/route");
    expect(mod.runtime).toBe("nodejs");
  });
});

describe("流内容", () => {
  it("连接建立后立即发一帧 connected 注释", async () => {
    const res = await GET(sseRequest(newController().signal));
    const reader = res.body!.getReader();
    openReaders.push(reader);
    expect(await readChunk(reader)).toBe(": connected\n\n");
  });

  it("publish 的事件以 SSE data 帧到达", async () => {
    const res = await GET(sseRequest(newController().signal));
    const reader = res.body!.getReader();
    openReaders.push(reader);
    await readChunk(reader); // connected

    publish({ type: "service.created", serviceId: 42 });
    const frame = await readChunk(reader);
    expect(frame).toBe(
      `event: service.created\ndata: {"type":"service.created","serviceId":42}\n\n`
    );
  });

  it("帧格式符合 SSE 规范：data: 行 + 空行结尾，payload 可 JSON.parse", async () => {
    const res = await GET(sseRequest(newController().signal));
    const reader = res.body!.getReader();
    openReaders.push(reader);
    await readChunk(reader);

    publish({ type: "deployment.created", deploymentId: 9, serviceId: 3 });
    const frame = (await readChunk(reader))!;
    expect(frame.endsWith("\n\n")).toBe(true);
    const dataLine = frame.split("\n").find((l) => l.startsWith("data: "))!;
    expect(JSON.parse(dataLine.slice(6))).toEqual({
      type: "deployment.created",
      deploymentId: 9,
      serviceId: 3,
    });
  });

  it("event: 行与事件 type 一致（客户端可 addEventListener 按类型分流）", async () => {
    const res = await GET(sseRequest(newController().signal));
    const reader = res.body!.getReader();
    openReaders.push(reader);
    await readChunk(reader);

    publish({ type: "deployment.updated", deploymentId: 5, serviceId: 1 });
    const frame = (await readChunk(reader))!;
    expect(frame.split("\n")[0]).toBe("event: deployment.updated");
  });

  it("多条事件按 publish 顺序到达", async () => {
    const res = await GET(sseRequest(newController().signal));
    const reader = res.body!.getReader();
    openReaders.push(reader);
    await readChunk(reader);

    publish({ type: "service.created", serviceId: 1 });
    publish({ type: "service.updated", serviceId: 1 });
    publish({ type: "service.deleted", serviceId: 1 });

    const frames = await readChunks(reader, 3);
    expect(frames.map((f) => f.split("\n")[0])).toEqual([
      "event: service.created",
      "event: service.updated",
      "event: service.deleted",
    ]);
  });

  it("两个并发连接都收到同一条事件", async () => {
    const r1 = (await GET(sseRequest(newController().signal))).body!.getReader();
    const r2 = (await GET(sseRequest(newController().signal))).body!.getReader();
    openReaders.push(r1, r2);
    await readChunk(r1);
    await readChunk(r2);
    expect(subscriberCount()).toBe(2);

    publish({ type: "service.created", serviceId: 77 });
    expect((await readChunk(r1))!).toContain(`"serviceId":77`);
    expect((await readChunk(r2))!).toContain(`"serviceId":77`);
  });
});

describe("订阅生命周期（防泄漏）", () => {
  it("连接建立后订阅者 +1", async () => {
    const before = subscriberCount();
    const res = await GET(sseRequest(newController().signal));
    openReaders.push(res.body!.getReader());
    expect(subscriberCount()).toBe(before + 1);
  });

  it("abort 后 listener 被退订（核心：不泄漏）", async () => {
    const ac = newController();
    const res = await GET(sseRequest(ac.signal));
    const reader = res.body!.getReader();
    openReaders.push(reader);
    expect(subscriberCount()).toBe(1);

    ac.abort();
    expect(subscriberCount()).toBe(0);
  });

  it("reader.cancel() 后 listener 被退订（第二条清理路径）", async () => {
    const res = await GET(sseRequest(newController().signal));
    const reader = res.body!.getReader();
    expect(subscriberCount()).toBe(1);

    await reader.cancel();
    expect(subscriberCount()).toBe(0);
  });

  it("abort 与 cancel 同时发生时清理是幂等的", async () => {
    const ac = newController();
    const res = await GET(sseRequest(ac.signal));
    const reader = res.body!.getReader();
    expect(subscriberCount()).toBe(1);

    ac.abort();
    await reader.cancel().catch(() => {});
    expect(subscriberCount()).toBe(0);
  });

  it("请求在 handler 执行前就已 abort：不留下订阅者", async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await GET(sseRequest(ac.signal));
    // 流会被立刻关闭，且不残留 listener
    expect(subscriberCount()).toBe(0);
    await res.body!.getReader().cancel().catch(() => {});
  });

  it("断开后 publish 不再往该连接写（也不抛错）", async () => {
    const ac = newController();
    const res = await GET(sseRequest(ac.signal));
    const reader = res.body!.getReader();
    await readChunk(reader);
    ac.abort();

    expect(() => publish({ type: "service.created", serviceId: 1 })).not.toThrow();
    // 流已关闭：读到 done
    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  it("20 次建立/断开循环后订阅者数量回到 0", async () => {
    for (let i = 0; i < 20; i++) {
      const ac = new AbortController();
      const res = await GET(sseRequest(ac.signal));
      const reader = res.body!.getReader();
      await readChunk(reader); // 确认通道真的打开过
      expect(subscriberCount()).toBe(1);
      ac.abort();
      expect(subscriberCount()).toBe(0);
      await reader.cancel().catch(() => {});
    }
    expect(subscriberCount()).toBe(0);
  });

  it("混合断开方式（abort / cancel 交替）20 次后仍为 0", async () => {
    for (let i = 0; i < 20; i++) {
      const ac = new AbortController();
      const res = await GET(sseRequest(ac.signal));
      const reader = res.body!.getReader();
      await readChunk(reader);
      if (i % 2 === 0) {
        ac.abort();
        await reader.cancel().catch(() => {});
      } else {
        await reader.cancel();
      }
      expect(subscriberCount()).toBe(0);
    }
  });

  it("多个连接分别断开，互不影响", async () => {
    const a = newController();
    const b = newController();
    const ra = (await GET(sseRequest(a.signal))).body!.getReader();
    const rb = (await GET(sseRequest(b.signal))).body!.getReader();
    openReaders.push(ra, rb);
    await readChunk(ra);
    await readChunk(rb);
    expect(subscriberCount()).toBe(2);

    a.abort();
    expect(subscriberCount()).toBe(1);
    // b 仍然收得到
    publish({ type: "service.updated", serviceId: 5 });
    expect((await readChunk(rb))!).toContain(`"serviceId":5`);

    b.abort();
    expect(subscriberCount()).toBe(0);
  });
});

describe("心跳", () => {
  it("25s 后发出 heartbeat 注释帧", async () => {
    vi.useFakeTimers();
    const ac = newController();
    const res = await GET(sseRequest(ac.signal));
    const reader = res.body!.getReader();
    expect(await readChunk(reader)).toBe(": connected\n\n");

    await vi.advanceTimersByTimeAsync(25_000);
    expect(await readChunk(reader)).toBe(": heartbeat\n\n");
    ac.abort();
  });

  it("心跳周期性重复发出", async () => {
    vi.useFakeTimers();
    const ac = newController();
    const res = await GET(sseRequest(ac.signal));
    const reader = res.body!.getReader();
    await readChunk(reader);

    await vi.advanceTimersByTimeAsync(75_000);
    const frames = await readChunks(reader, 3);
    expect(frames).toEqual([": heartbeat\n\n", ": heartbeat\n\n", ": heartbeat\n\n"]);
    ac.abort();
  });

  it("心跳间隔在 15-30s 之间（代理 60s idle 超时窗口内至少两次）", async () => {
    vi.useFakeTimers();
    const ac = newController();
    const res = await GET(sseRequest(ac.signal));
    const reader = res.body!.getReader();
    await readChunk(reader);

    // 挂一个 read 并记录它是否已 settle。fake timers 下不能用 setTimeout 做超时竞速
    // （setTimeout 本身也被冻结），改用「推进时钟后 promise 是否已完成」来判断。
    let settled = false;
    const pending = reader.read().then((r) => {
      settled = true;
      return r;
    });

    // 14s 时不该有心跳（证明间隔不小于 15s，不是过密的轮询）
    await vi.advanceTimersByTimeAsync(14_000);
    expect(settled).toBe(false);

    // 30s 内必须有（证明不超过代理 60s 超时窗口的一半）
    await vi.advanceTimersByTimeAsync(16_000);
    const { value } = await pending;
    expect(new TextDecoder().decode(value)).toBe(": heartbeat\n\n");
    ac.abort();
  });

  it("abort 后心跳定时器被清理（不再有新帧）", async () => {
    vi.useFakeTimers();
    const ac = newController();
    const res = await GET(sseRequest(ac.signal));
    const reader = res.body!.getReader();
    await readChunk(reader);
    ac.abort();

    await vi.advanceTimersByTimeAsync(120_000);
    // 定时器若没清掉，会往已关闭的 controller enqueue；
    // 这里读到 done 即证明流已终结且没有后续心跳帧。
    const { done } = await reader.read();
    expect(done).toBe(true);
    expect(subscriberCount()).toBe(0);
  });
});
