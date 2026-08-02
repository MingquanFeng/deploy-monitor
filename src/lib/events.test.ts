import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeEvent } from "@/lib/events";
import { publish, subscribe, subscriberCount } from "@/lib/events";

/**
 * 事件总线是模块级单例（一个 Set 活在模块作用域里），测试之间会共享。
 * 每个用例都自己收集退订函数并在 beforeEach 前清空，
 * 断言 subscriberCount() 归零 => 用例之间零残留。
 */

const unsubs: Array<() => void> = [];

function track(unsub: () => void): () => void {
  unsubs.push(unsub);
  return unsub;
}

beforeEach(() => {
  while (unsubs.length) unsubs.pop()!();
  expect(subscriberCount()).toBe(0);
});

const SERVICE_CREATED: ChangeEvent = { type: "service.created", serviceId: 1 };
const DEPLOY_CREATED: ChangeEvent = {
  type: "deployment.created",
  deploymentId: 7,
  serviceId: 3,
};

describe("subscribe / publish", () => {
  it("订阅者收到 publish 的事件", () => {
    const seen: ChangeEvent[] = [];
    track(subscribe((e) => seen.push(e)));
    publish(SERVICE_CREATED);
    expect(seen).toEqual([SERVICE_CREATED]);
  });

  it("事件对象原样透传（不做拷贝或改写）", () => {
    const seen: ChangeEvent[] = [];
    track(subscribe((e) => seen.push(e)));
    publish(SERVICE_CREATED);
    expect(seen[0]).toBe(SERVICE_CREATED);
  });

  it("多个订阅者都收到同一事件", () => {
    const a: ChangeEvent[] = [];
    const b: ChangeEvent[] = [];
    const c: ChangeEvent[] = [];
    track(subscribe((e) => a.push(e)));
    track(subscribe((e) => b.push(e)));
    track(subscribe((e) => c.push(e)));
    publish(DEPLOY_CREATED);
    expect(a).toEqual([DEPLOY_CREATED]);
    expect(b).toEqual([DEPLOY_CREATED]);
    expect(c).toEqual([DEPLOY_CREATED]);
  });

  it("连续 publish 按顺序到达", () => {
    const seen: string[] = [];
    track(subscribe((e) => seen.push(e.type)));
    publish({ type: "service.created", serviceId: 1 });
    publish({ type: "service.updated", serviceId: 1 });
    publish({ type: "service.deleted", serviceId: 1 });
    expect(seen).toEqual(["service.created", "service.updated", "service.deleted"]);
  });

  it("没有订阅者时 publish 不抛错", () => {
    expect(subscriberCount()).toBe(0);
    expect(() => publish(SERVICE_CREATED)).not.toThrow();
  });

  it("publish 是同步的（返回时 listener 已执行完）", () => {
    let called = false;
    track(subscribe(() => (called = true)));
    publish(SERVICE_CREATED);
    expect(called).toBe(true);
  });

  it("同一个函数只会被注册一次（Set 语义，不会收到重复事件）", () => {
    const fn = vi.fn();
    const off1 = subscribe(fn);
    const off2 = subscribe(fn);
    expect(subscriberCount()).toBe(1);
    publish(SERVICE_CREATED);
    expect(fn).toHaveBeenCalledTimes(1);
    off1();
    off2();
    expect(subscriberCount()).toBe(0);
  });
});

describe("退订", () => {
  it("退订后不再收到事件", () => {
    const fn = vi.fn();
    const off = subscribe(fn);
    publish(SERVICE_CREATED);
    off();
    publish(SERVICE_CREATED);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("退订后 subscriberCount 归零", () => {
    const off = subscribe(() => {});
    expect(subscriberCount()).toBe(1);
    off();
    expect(subscriberCount()).toBe(0);
  });

  it("重复退订是幂等的，不会误删别人", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribe(a);
    track(subscribe(b));
    offA();
    offA();
    offA();
    expect(subscriberCount()).toBe(1);
    publish(SERVICE_CREATED);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("只退订一个，其余仍然收到", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribe(a);
    track(subscribe(b));
    offA();
    publish(DEPLOY_CREATED);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("N 次 subscribe + N 次退订后计数回到 0（不泄漏）", () => {
    const offs = Array.from({ length: 50 }, () => subscribe(() => {}));
    expect(subscriberCount()).toBe(50);
    offs.forEach((off) => off());
    expect(subscriberCount()).toBe(0);
  });
});

describe("错误隔离", () => {
  it("一个 listener 抛错不影响其他 listener", () => {
    const before = vi.fn();
    const after = vi.fn();
    track(subscribe(before));
    track(
      subscribe(() => {
        throw new Error("这个连接已经断了");
      })
    );
    track(subscribe(after));

    expect(() => publish(SERVICE_CREATED)).not.toThrow();
    expect(before).toHaveBeenCalledTimes(1);
    // 关键:抛错的 listener 排在 after 之前,它的异常不能中断后续调用
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("publish 本身永不抛错（调用点可以裸调，写操作不会因推送失败变 500）", () => {
    track(
      subscribe(() => {
        throw new Error("boom");
      })
    );
    expect(() => publish(SERVICE_CREATED)).not.toThrow();
  });

  it("抛错的 listener 不会被自动移除（下次仍会被调用）", () => {
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    track(subscribe(bad));
    publish(SERVICE_CREATED);
    publish(SERVICE_CREATED);
    expect(bad).toHaveBeenCalledTimes(2);
  });

  it("全部 listener 都抛错也不影响 publish 返回", () => {
    for (let i = 0; i < 5; i++) {
      track(
        subscribe(() => {
          throw new Error(`boom-${i}`);
        })
      );
    }
    expect(() => publish(DEPLOY_CREATED)).not.toThrow();
    expect(subscriberCount()).toBe(5);
  });
});

describe("遍历期间修改订阅集合", () => {
  it("listener 内部退订自己不会打乱本次广播", () => {
    const other = vi.fn();
    const self = vi.fn(() => off());
    const off = track(subscribe(self));
    track(subscribe(other));

    publish(SERVICE_CREATED);
    expect(self).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);

    publish(SERVICE_CREATED);
    expect(self).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(2);
  });

  it("listener 内部新增订阅者，新订阅者不会收到当前这条事件", () => {
    const late = vi.fn();
    track(
      subscribe(() => {
        track(subscribe(late));
      })
    );
    publish(SERVICE_CREATED);
    // 快照语义:本次广播的收件人在遍历开始时就已确定
    expect(late).not.toHaveBeenCalled();
  });

  it("listener 内部退订别人，被退订者仍收到当前事件、下一条起不再收到", () => {
    const victim = vi.fn();
    let offVictim: () => void = () => {};
    // 先注册 killer,让它在迭代顺序里排在 victim 之前执行
    track(subscribe(() => offVictim()));
    offVictim = track(subscribe(victim));

    publish(SERVICE_CREATED);
    // 快照已包含 victim,本次仍会调用它(这是快照的取舍:确定性优于即时性)
    expect(victim).toHaveBeenCalledTimes(1);

    publish(SERVICE_CREATED);
    // 下一次广播时它已不在集合里
    expect(victim).toHaveBeenCalledTimes(1);
  });
});

describe("事件类型", () => {
  it("service.* 事件带 serviceId", () => {
    const seen: ChangeEvent[] = [];
    track(subscribe((e) => seen.push(e)));
    publish({ type: "service.created", serviceId: 11 });
    publish({ type: "service.updated", serviceId: 12 });
    publish({ type: "service.deleted", serviceId: 13 });
    expect(seen.map((e) => e.serviceId)).toEqual([11, 12, 13]);
  });

  it("deployment.* 事件同时带 deploymentId 与 serviceId", () => {
    const seen: ChangeEvent[] = [];
    track(subscribe((e) => seen.push(e)));
    publish({ type: "deployment.created", deploymentId: 1, serviceId: 2 });
    publish({ type: "deployment.updated", deploymentId: 3, serviceId: 4 });
    expect(seen).toEqual([
      { type: "deployment.created", deploymentId: 1, serviceId: 2 },
      { type: "deployment.updated", deploymentId: 3, serviceId: 4 },
    ]);
  });

  it("事件可被 JSON 序列化（SSE data 帧的前提）", () => {
    const seen: string[] = [];
    track(subscribe((e) => seen.push(JSON.stringify(e))));
    publish(DEPLOY_CREATED);
    expect(JSON.parse(seen[0])).toEqual({
      type: "deployment.created",
      deploymentId: 7,
      serviceId: 3,
    });
  });
});
