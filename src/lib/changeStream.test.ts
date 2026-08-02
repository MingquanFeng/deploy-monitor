import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeEvent } from "@/lib/events";

/**
 * changeStream.ts 的测试。
 *
 * 为什么不用 jsdom + @testing-library/react：
 * 本次要保证的行为是「按类型分流」「卸载时 close」「引用计数下只有一条连接」
 * 「坏帧不触发刷新」—— 全都在 changeStream.ts 这一层，是纯 JS。
 * 唯一的外部依赖是 EventSource 构造函数，用下面这个 30 行的假实现就能完全驱动，
 * 而且比 jsdom 更强：jsdom 根本没实现 EventSource，引进来还是得自己造假的。
 * 代价是不覆盖 hook 里那几行 ref 赋值 —— 那部分薄到肉眼可验，
 * 换来的是不必给现有 345 个 node 环境测试引入环境分叉。
 *
 * 模块是有状态的单例（source / connected / subscribers），
 * 所以每个用例都 resetModules + 重新 import，拿到干净的实例。
 */

// ---------------------------------------------------------------------------
// 假 EventSource
// ---------------------------------------------------------------------------

type Listener = (e: { data: string }) => void;

class FakeEventSource {
  /** 所有被构造过的实例，按顺序。用来断言「一共开了几条连接」。 */
  static instances: FakeEventSource[] = [];

  static reset() {
    FakeEventSource.instances = [];
  }

  /** 当前未关闭的实例数 —— 泄漏检测的核心断言。 */
  static openCount(): number {
    return FakeEventSource.instances.filter((i) => !i.closed).length;
  }

  static last(): FakeEventSource {
    const last = FakeEventSource.instances.at(-1);
    if (!last) throw new Error("还没有任何 EventSource 实例");
    return last;
  }

  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  /** 真实 EventSource 上存在，用于验证「我们没有依赖它」。 */
  onmessage: ((e: { data: string }) => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close() {
    this.closed = true;
  }

  // --- 测试侧的驱动方法（真实 EventSource 上没有）---

  /** 模拟连接建立。 */
  emitOpen() {
    this.onopen?.();
  }

  /** 模拟连接错误（真实场景下之后 EventSource 会自行重连）。 */
  emitError() {
    this.onerror?.();
  }

  /** 模拟一个带 `event:` 字段的数据帧。 */
  emit(type: string, data: string) {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }

  /** 模拟不带 `event:` 的默认消息（服务端不会发，用于反证）。 */
  emitDefaultMessage(data: string) {
    this.onmessage?.({ data });
  }
}

// ---------------------------------------------------------------------------
// 每个用例一份干净的模块实例
// ---------------------------------------------------------------------------

type StreamModule = typeof import("@/lib/changeStream");

let mod: StreamModule;

beforeEach(async () => {
  FakeEventSource.reset();
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  vi.resetModules();
  mod = await import("@/lib/changeStream");
});

afterEach(() => {
  delete (globalThis as { EventSource?: unknown }).EventSource;
});

/** 收集事件与状态的探针，模拟一个订阅者（页面）。 */
function probe() {
  const events: ChangeEvent[] = [];
  const statuses: boolean[] = [];
  return {
    events,
    statuses,
    subscriber: {
      onEvent: (e: ChangeEvent) => events.push(e),
      onStatus: (c: boolean) => statuses.push(c),
    },
  };
}

const SERVICE_CREATED = '{"type":"service.created","serviceId":1}';
const DEPLOY_CREATED =
  '{"type":"deployment.created","deploymentId":7,"serviceId":3}';

// ---------------------------------------------------------------------------

describe("parseChangeEvent", () => {
  it("解析 service.* 帧", () => {
    expect(mod.parseChangeEvent('{"type":"service.updated","serviceId":5}')).toEqual({
      type: "service.updated",
      serviceId: 5,
    });
  });

  it("解析 deployment.* 帧并保留 deploymentId", () => {
    expect(mod.parseChangeEvent(DEPLOY_CREATED)).toEqual({
      type: "deployment.created",
      deploymentId: 7,
      serviceId: 3,
    });
  });

  it("丢弃 deployment.* 上多余的字段（只取契约里的三个）", () => {
    expect(
      mod.parseChangeEvent(
        '{"type":"deployment.updated","deploymentId":1,"serviceId":2,"extra":"x"}'
      )
    ).toEqual({ type: "deployment.updated", deploymentId: 1, serviceId: 2 });
  });

  it("非法 JSON 返回 null", () => {
    expect(mod.parseChangeEvent("{not json")).toBeNull();
  });

  it("被截断的帧返回 null（代理截断的真实形态）", () => {
    expect(mod.parseChangeEvent('{"type":"service.created","servi')).toBeNull();
  });

  it("未知 type 返回 null（版本偏移：服务端推了新类型）", () => {
    expect(mod.parseChangeEvent('{"type":"service.exploded","serviceId":1}')).toBeNull();
  });

  it("缺少 serviceId 返回 null", () => {
    expect(mod.parseChangeEvent('{"type":"service.created"}')).toBeNull();
  });

  it("serviceId 不是数字返回 null", () => {
    expect(mod.parseChangeEvent('{"type":"service.created","serviceId":"1"}')).toBeNull();
  });

  it("deployment.* 缺少 deploymentId 返回 null", () => {
    expect(mod.parseChangeEvent('{"type":"deployment.created","serviceId":1}')).toBeNull();
  });

  it("null / 数组 / 数字等非对象 JSON 返回 null", () => {
    expect(mod.parseChangeEvent("null")).toBeNull();
    expect(mod.parseChangeEvent("[]")).toBeNull();
    expect(mod.parseChangeEvent("42")).toBeNull();
    expect(mod.parseChangeEvent('"str"')).toBeNull();
  });

  it("非字符串入参返回 null", () => {
    expect(mod.parseChangeEvent(undefined)).toBeNull();
    expect(mod.parseChangeEvent(null)).toBeNull();
    expect(mod.parseChangeEvent({ type: "service.created" })).toBeNull();
  });
});

describe("CHANGE_EVENT_TYPES", () => {
  it("穷尽覆盖 ChangeEvent 联合的全部 5 种类型", () => {
    expect([...mod.CHANGE_EVENT_TYPES].sort()).toEqual([
      "deployment.created",
      "deployment.updated",
      "service.created",
      "service.deleted",
      "service.updated",
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("相关性过滤 —— 服务详情页", () => {
  const of = (e: ChangeEvent, id: number) => mod.affectsService(e, id);

  it("匹配 serviceId 的部署事件相关", () => {
    expect(of({ type: "deployment.created", deploymentId: 1, serviceId: 9 }, 9)).toBe(true);
    expect(of({ type: "deployment.updated", deploymentId: 1, serviceId: 9 }, 9)).toBe(true);
  });

  it("其他服务的部署事件不相关（这是过滤的主要收益）", () => {
    expect(of({ type: "deployment.created", deploymentId: 1, serviceId: 8 }, 9)).toBe(false);
  });

  it("本服务被更新 / 删除都相关", () => {
    expect(of({ type: "service.updated", serviceId: 9 }, 9)).toBe(true);
    // 被别人删掉时本页数据已不存在，也要重拉以反映真相
    expect(of({ type: "service.deleted", serviceId: 9 }, 9)).toBe(true);
  });

  it("其他服务的 service.* 不相关", () => {
    expect(of({ type: "service.created", serviceId: 1 }, 9)).toBe(false);
    expect(of({ type: "service.deleted", serviceId: 1 }, 9)).toBe(false);
  });
});

describe("相关性过滤 —— 部署历史页", () => {
  // 必须惰性取：describe 体在收集阶段执行，那时 beforeEach 还没跑，mod 是 undefined
  const of = (e: ChangeEvent) => mod.affectsDeploymentList(e);

  it("任意服务的 deployment.* 都相关（本页不按服务过滤）", () => {
    expect(of({ type: "deployment.created", deploymentId: 1, serviceId: 1 })).toBe(true);
    expect(of({ type: "deployment.updated", deploymentId: 2, serviceId: 99 })).toBe(true);
  });

  it("service.deleted 相关（级联删除带走了该服务的全部记录）", () => {
    expect(of({ type: "service.deleted", serviceId: 1 })).toBe(true);
  });

  it("service.updated 相关（表格有一列显示 service_name，改名后要跟着变）", () => {
    expect(of({ type: "service.updated", serviceId: 1 })).toBe(true);
  });

  it("service.created 不相关（新服务必然还没有部署记录）", () => {
    expect(of({ type: "service.created", serviceId: 1 })).toBe(false);
  });
});

describe("相关性过滤 —— 服务列表页", () => {
  const of = (e: ChangeEvent) => mod.affectsServiceList(e);

  it("service.* 全部相关", () => {
    expect(of({ type: "service.created", serviceId: 1 })).toBe(true);
    expect(of({ type: "service.updated", serviceId: 1 })).toBe(true);
    expect(of({ type: "service.deleted", serviceId: 1 })).toBe(true);
  });

  it("deployment.* 不相关（这张表不显示部署信息）", () => {
    expect(of({ type: "deployment.created", deploymentId: 1, serviceId: 1 })).toBe(false);
    expect(of({ type: "deployment.updated", deploymentId: 1, serviceId: 1 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("连接建立", () => {
  it("首个订阅者建立一条连接，URL 是 /api/events", () => {
    const p = probe();
    mod.openChangeStream(p.subscriber);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.last().url).toBe("/api/events");
  });

  it("注册了全部 5 种事件类型的 listener", () => {
    mod.openChangeStream(probe().subscriber);
    const es = FakeEventSource.last();
    for (const type of mod.CHANGE_EVENT_TYPES) {
      expect(es.listeners.get(type), `未注册 ${type}`).toHaveLength(1);
    }
  });

  it("不依赖 onmessage —— 服务端每帧都带 event: 字段，onmessage 收不到", () => {
    const p = probe();
    mod.openChangeStream(p.subscriber);
    const es = FakeEventSource.last();
    expect(es.onmessage).toBeNull();
    // 反证：即使有人从默认通道推消息，也不会被当成变更事件
    es.emitDefaultMessage(SERVICE_CREATED);
    expect(p.events).toEqual([]);
  });

  it("EventSource 不存在时（SSR）不建连、不抛错", async () => {
    delete (globalThis as { EventSource?: unknown }).EventSource;
    vi.resetModules();
    const ssrMod = await import("@/lib/changeStream");
    expect(() => ssrMod.openChangeStream(probe().subscriber)).not.toThrow();
  });
});

describe("事件分流", () => {
  it("每种类型的帧都能到达订阅者", () => {
    const p = probe();
    mod.openChangeStream(p.subscriber);
    const es = FakeEventSource.last();
    es.emit("service.created", SERVICE_CREATED);
    es.emit("deployment.created", DEPLOY_CREATED);
    expect(p.events).toEqual([
      { type: "service.created", serviceId: 1 },
      { type: "deployment.created", deploymentId: 7, serviceId: 3 },
    ]);
  });

  it("多个订阅者都收到同一条事件（引用计数下共享一条流）", () => {
    const a = probe();
    const b = probe();
    mod.openChangeStream(a.subscriber);
    mod.openChangeStream(b.subscriber);
    FakeEventSource.last().emit("service.created", SERVICE_CREATED);
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
  });

  it("坏帧被丢弃，不触发任何回调（否则会变成一次无谓的全量刷新）", () => {
    const p = probe();
    mod.openChangeStream(p.subscriber);
    const es = FakeEventSource.last();
    es.emit("service.created", "{broken");
    es.emit("service.created", '{"type":"service.created"}');
    expect(p.events).toEqual([]);
  });

  it("坏帧之后的好帧仍然正常送达", () => {
    const p = probe();
    mod.openChangeStream(p.subscriber);
    const es = FakeEventSource.last();
    es.emit("service.created", "{broken");
    es.emit("service.created", SERVICE_CREATED);
    expect(p.events).toEqual([{ type: "service.created", serviceId: 1 }]);
  });

  it("心跳是注释帧，不走任何 listener（EventSource 原生忽略）", () => {
    const p = probe();
    mod.openChangeStream(p.subscriber);
    // 注释帧不会产生 message 事件，也就没有任何 emit 可做 ——
    // 断言这一点的方式就是：建连后什么都不 emit，回调数为 0
    expect(p.events).toEqual([]);
  });
});

describe("连接状态", () => {
  it("初始未连接，onopen 后为 true", () => {
    const p = probe();
    mod.openChangeStream(p.subscriber);
    expect(mod.changeStreamStatus().connected).toBe(false);
    FakeEventSource.last().emitOpen();
    expect(p.statuses).toEqual([true]);
    expect(mod.changeStreamStatus().connected).toBe(true);
  });

  it("onerror 后回落 false，重连成功后再回到 true（不是一次性报错）", () => {
    const p = probe();
    mod.openChangeStream(p.subscriber);
    const es = FakeEventSource.last();
    es.emitOpen();
    es.emitError();
    es.emitOpen();
    expect(p.statuses).toEqual([true, false, true]);
  });

  it("状态相同时不重复通知（避免无谓 re-render）", () => {
    const p = probe();
    mod.openChangeStream(p.subscriber);
    const es = FakeEventSource.last();
    es.emitOpen();
    es.emitOpen();
    es.emitOpen();
    expect(p.statuses).toEqual([true]);
  });

  it("后加入的订阅者立即拿到当前状态，不必等下一次变化", () => {
    mod.openChangeStream(probe().subscriber);
    FakeEventSource.last().emitOpen();

    const late = probe();
    mod.openChangeStream(late.subscriber);
    // 关键：指示灯不能因为「加入得晚」而错误地停在初始的 false
    expect(late.statuses).toEqual([true]);
  });

  it("不自己实现重连 —— onerror 不会 close 也不会新建连接", () => {
    mod.openChangeStream(probe().subscriber);
    const es = FakeEventSource.last();
    es.emitError();
    expect(es.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

describe("引用计数与连接释放", () => {
  it("多个订阅者只建立一条连接", () => {
    mod.openChangeStream(probe().subscriber);
    mod.openChangeStream(probe().subscriber);
    mod.openChangeStream(probe().subscriber);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(mod.changeStreamStatus().subscribers).toBe(3);
  });

  it("最后一个订阅者退订时 close（卸载必须断开）", () => {
    const off = mod.openChangeStream(probe().subscriber);
    const es = FakeEventSource.last();
    expect(es.closed).toBe(false);
    off();
    expect(es.closed).toBe(true);
    expect(FakeEventSource.openCount()).toBe(0);
  });

  it("还有订阅者时不 close", () => {
    const offA = mod.openChangeStream(probe().subscriber);
    mod.openChangeStream(probe().subscriber);
    offA();
    expect(FakeEventSource.last().closed).toBe(false);
    expect(mod.changeStreamStatus().subscribers).toBe(1);
  });

  it("退订后不再收到事件", () => {
    const p = probe();
    const off = mod.openChangeStream(p.subscriber);
    const es = FakeEventSource.last();
    es.emit("service.created", SERVICE_CREATED);
    off();
    es.emit("service.created", SERVICE_CREATED);
    expect(p.events).toHaveLength(1);
  });

  it("重复退订是幂等的，不会误伤别人", () => {
    const a = probe();
    const b = probe();
    const offA = mod.openChangeStream(a.subscriber);
    mod.openChangeStream(b.subscriber);
    offA();
    offA();
    offA();
    expect(mod.changeStreamStatus().subscribers).toBe(1);
    FakeEventSource.last().emit("service.created", SERVICE_CREATED);
    expect(a.events).toEqual([]);
    expect(b.events).toHaveLength(1);
  });

  it("全部退订后重新订阅会建立新连接", () => {
    const off = mod.openChangeStream(probe().subscriber);
    off();
    mod.openChangeStream(probe().subscriber);
    expect(FakeEventSource.instances).toHaveLength(2);
    // 关键：任一时刻只有一条是活的
    expect(FakeEventSource.openCount()).toBe(1);
  });

  it("close 后 connected 归零（新订阅者不会读到陈旧的 true）", () => {
    const off = mod.openChangeStream(probe().subscriber);
    FakeEventSource.last().emitOpen();
    expect(mod.changeStreamStatus().connected).toBe(true);
    off();
    expect(mod.changeStreamStatus().connected).toBe(false);

    const next = probe();
    mod.openChangeStream(next.subscriber);
    expect(mod.changeStreamStatus().connected).toBe(false);
    expect(next.statuses).toEqual([]);
  });

  it("反复挂载 / 卸载不累积连接（切页泄漏的回归断言）", () => {
    for (let i = 0; i < 20; i++) {
      const off = mod.openChangeStream(probe().subscriber);
      FakeEventSource.last().emitOpen();
      off();
    }
    expect(FakeEventSource.instances).toHaveLength(20);
    expect(FakeEventSource.openCount()).toBe(0);
    expect(mod.changeStreamStatus().subscribers).toBe(0);
  });

  it("切页的重叠窗口（新页先挂载、旧页后卸载）不产生第二条连接", () => {
    // Next.js 客户端路由的真实时序
    const offOld = mod.openChangeStream(probe().subscriber);
    const offNew = mod.openChangeStream(probe().subscriber);
    offOld();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.openCount()).toBe(1);
    offNew();
    expect(FakeEventSource.openCount()).toBe(0);
  });

  it("StrictMode 的 mount→unmount→mount 双调用后仍只有一条活连接", () => {
    const off1 = mod.openChangeStream(probe().subscriber);
    off1();
    mod.openChangeStream(probe().subscriber);
    expect(FakeEventSource.openCount()).toBe(1);
  });

  it("订阅者在 onEvent 里退订自己不会打乱本次派发", () => {
    const other = probe();
    let off: () => void = () => {};
    const selfEvents: ChangeEvent[] = [];
    off = mod.openChangeStream({
      onEvent: (e) => {
        selfEvents.push(e);
        off();
      },
      onStatus: () => {},
    });
    mod.openChangeStream(other.subscriber);

    FakeEventSource.last().emit("service.created", SERVICE_CREATED);
    expect(selfEvents).toHaveLength(1);
    expect(other.events).toHaveLength(1);

    FakeEventSource.last().emit("service.created", SERVICE_CREATED);
    expect(selfEvents).toHaveLength(1);
    expect(other.events).toHaveLength(2);
  });
});
