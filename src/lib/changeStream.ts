/**
 * SSE 变更流的**客户端**实现（非 React 部分）。
 *
 * 拆成独立模块而不是塞进 hook 里，是为了可测：整个连接生命周期
 * （建连、按类型分流、退订、最后一个订阅者离开时关闭）都是纯 JS，
 * 只依赖一个 `EventSource` 构造函数，可以在 node 环境用假实现驱动。
 * 如果这些逻辑写在 useEffect 里，就只能靠 jsdom + testing-library 才能测到。
 * 见 src/lib/changeStream.test.ts。
 *
 * 事件契约由服务端的 src/lib/events.ts 定义，这里只消费、不重复定义。
 */

import type { ChangeEvent, ChangeEventType } from "@/lib/events";

/** SSE 端点。服务端实现见 src/app/api/events/route.ts。 */
export const CHANGE_STREAM_URL = "/api/events";

/**
 * 全部事件类型的穷尽表。
 *
 * 为什么用 `Record<ChangeEventType, true>` 而不是直接写数组：
 * 数组字面量对「漏了一个类型」是沉默的 —— 服务端往 ChangeEvent 联合里加第 6 种
 * 事件，数组照样编译通过，客户端只是永远收不到那种事件，且没有任何报错。
 * Record 的键必须覆盖联合的每个成员，漏一个就是编译错误，
 * 于是「服务端加事件类型」会立刻在这里断掉构建，而不是在生产环境静默失效。
 */
const EVENT_TYPE_TABLE: Record<ChangeEventType, true> = {
  "service.created": true,
  "service.updated": true,
  "service.deleted": true,
  "deployment.created": true,
  "deployment.updated": true,
};

/**
 * 需要 addEventListener 注册的全部类型。
 *
 * 必须逐类型注册，不能用 `es.onmessage`：服务端每一帧都带了 `event:` 字段
 * （已实测确认，见 route.ts 的 formatEvent），而 `onmessage` 只接收
 * **没有** `event:` 字段的默认消息 —— 用它会一条都收不到。
 */
export const CHANGE_EVENT_TYPES = Object.keys(EVENT_TYPE_TABLE) as ChangeEventType[];

function isChangeEventType(value: unknown): value is ChangeEventType {
  return typeof value === "string" && value in EVENT_TYPE_TABLE;
}

/**
 * 把 SSE `data:` 帧解析成 ChangeEvent，任何不合预期的输入都返回 null。
 *
 * 为什么要校验而不是直接 `JSON.parse(...) as ChangeEvent`：
 * 这份数据来自网络，`as` 只是编译期的谎言。真实的坏输入有两种来源 ——
 * 版本偏移（页面还是旧代码，服务端已经在推新形状）和中间代理截断帧。
 * 解析失败时返回 null 让调用方跳过这一条，比让 `event.serviceId` 变成
 * undefined 后污染下游的过滤判断要好：后者会表现为「刷新逻辑偶发不生效」，
 * 是最难查的一类 bug。
 */
export function parseChangeEvent(data: unknown): ChangeEvent | null {
  if (typeof data !== "string") return null;

  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;

  const candidate = raw as Record<string, unknown>;
  if (!isChangeEventType(candidate.type)) return null;
  if (typeof candidate.serviceId !== "number" || !Number.isFinite(candidate.serviceId)) {
    return null;
  }

  if (candidate.type === "deployment.created" || candidate.type === "deployment.updated") {
    if (
      typeof candidate.deploymentId !== "number" ||
      !Number.isFinite(candidate.deploymentId)
    ) {
      return null;
    }
    return {
      type: candidate.type,
      deploymentId: candidate.deploymentId,
      serviceId: candidate.serviceId,
    };
  }

  return { type: candidate.type, serviceId: candidate.serviceId };
}

// ---------------------------------------------------------------------------
// 相关性判定
//
// 每个页面只在「这条事件会改变我屏幕上的内容」时才 refetch。事件自带 serviceId，
// 判断几乎是免费的，而省掉的是一次完整往返 —— 在一个服务频繁部署的实例上，
// 无脑全量重拉会让所有打开的页面都跟着抖动。
// 这些函数是纯的、无 DOM 依赖，因此可以在 node 环境完整测试。
// ---------------------------------------------------------------------------

/** 事件是否属于部署记录维度。 */
function isDeploymentEvent(
  event: ChangeEvent
): event is Extract<ChangeEvent, { deploymentId: number }> {
  return event.type === "deployment.created" || event.type === "deployment.updated";
}

/**
 * 服务详情页（/services/[id]）：只关心这一个服务。
 *
 * 包含 `service.deleted`：该服务被别人删掉时，本页显示的数据已经不存在了，
 * 也需要重新拉一次以反映真相（GET 会返回 404）。
 */
export function affectsService(event: ChangeEvent, serviceId: number): boolean {
  return event.serviceId === serviceId;
}

/**
 * 部署历史页（/deployments）：全部 deployment.*，加上两种 service 事件。
 *
 *   - `service.deleted`：外键 ON DELETE CASCADE 连带删掉了该服务的全部部署记录，
 *     不刷新的话表格里会留着一批已经不存在的行。
 *   - `service.updated`：这张表有一列展示 `service_name`（来自 API 的 JOIN）。
 *     服务改名后不刷新，表格会一直显示旧名字。这一条很容易漏 ——
 *     直觉上「改服务名」和「部署历史」无关，但渲染出来的字确实变了。
 *
 * 不含 `service.created`：新建的服务必然还没有任何部署记录
 * （deployments.service_id 是外键，记录只能在服务存在之后创建），
 * 这条事件对本页的结果集为空影响。
 */
export function affectsDeploymentList(event: ChangeEvent): boolean {
  return (
    isDeploymentEvent(event) ||
    event.type === "service.deleted" ||
    event.type === "service.updated"
  );
}

/** 服务列表页（/services）：只关心服务的增删改，部署记录不在这张表上。 */
export function affectsServiceList(event: ChangeEvent): boolean {
  return !isDeploymentEvent(event);
}

// ---------------------------------------------------------------------------
// 连接：单例 + 引用计数
//
// 为什么不是「一个 hook 调用 = 一个 EventSource」：
//   1. 浏览器对同一域名的 HTTP/1.1 并发连接有硬上限（约 6 条），SSE 是长连接，
//      每条都常驻。一个标签页开两条就用掉三分之一的额度。
//   2. Next.js 的客户端路由在切页时会先挂载新页面、再卸载旧页面。
//      per-hook 的 EventSource 在这个重叠窗口里必然出现两条连接，
//      并且每次切页都要断一次、重连一次（重连还带指数退避的延迟，
//      切回来的头几百毫秒是「未连接」状态）。
//   3. 导航栏的连接状态指示灯需要 connected，但它不该为了一个圆点再开一条流。
//
// 引用计数让「一个标签页恰好一条连接」成为结构性保证，而不是靠调用方自律：
// 第一个订阅者建连，最后一个订阅者离开时 close()。
// 顺带解决 React StrictMode 的 mount→unmount→mount 双调用 —— 计数在过程中
// 从 0→1→0→1，中间那次归零会关闭连接，随即被新的订阅重新建立，行为正确。
// ---------------------------------------------------------------------------

export interface ChangeStreamSubscriber {
  /** 收到一条已解析的变更事件。 */
  onEvent: (event: ChangeEvent) => void;
  /** 连接状态变化。订阅时会立即以当前状态回调一次。 */
  onStatus: (connected: boolean) => void;
}

let source: EventSource | null = null;
let connected = false;
const subscribers = new Set<ChangeStreamSubscriber>();

/** 当前连接状态与订阅者数量。用于测试断言与调试，不参与渲染。 */
export function changeStreamStatus(): { connected: boolean; subscribers: number } {
  return { connected, subscribers: subscribers.size };
}

function setConnected(next: boolean) {
  if (connected === next) return;
  connected = next;
  // 快照遍历：onStatus 回调里可能触发退订（例如组件在状态变化时卸载）
  for (const sub of [...subscribers]) sub.onStatus(next);
}

function dispatch(raw: unknown) {
  const event = parseChangeEvent(raw);
  // 解析失败：坏帧直接丢弃，不能让它变成一次无意义的全量刷新
  if (!event) return;
  for (const sub of [...subscribers]) sub.onEvent(event);
}

function connect() {
  /**
   * SSR / 非浏览器环境的兜底。调用方全是 "use client" 组件、且只在 useEffect
   * 里调进来（effect 不在服务端执行），理论上到不了这里；但这个模块是普通 JS，
   * 一旦被别处在模块顶层引用就会炸，成本一行，留着。
   */
  if (typeof EventSource === "undefined") return;

  const es = new EventSource(CHANGE_STREAM_URL);
  source = es;

  es.onopen = () => setConnected(true);

  /**
   * 这里**只更新状态，不做重连**。EventSource 原生就带断线重连
   * （失败后自行退避重试，服务端还能用 `retry:` 字段调节间隔）。
   * 自己再 close() + new 一个会和原生机制打架：两套定时器各自重试，
   * 结果是服务端刚恢复的瞬间收到成倍的连接请求。
   *
   * 注意 onerror 不等于「永久失败」—— 它在每次重连尝试失败时都会触发，
   * 之后连上会再次触发 onopen。所以状态指示灯是双向的，不是一次性报错。
   */
  es.onerror = () => setConnected(false);

  // 逐类型注册。服务端每帧都有 event: 字段，onmessage 收不到（已实测）。
  for (const type of CHANGE_EVENT_TYPES) {
    es.addEventListener(type, (e) => dispatch((e as MessageEvent).data));
  }
}

function disconnect() {
  if (!source) return;
  /**
   * close() 之后不会再有 onerror/onopen，所以状态必须手动落回 false，
   * 否则下一个订阅者接手时会读到一个陈旧的 connected=true。
   */
  source.close();
  source = null;
  connected = false;
}

/**
 * 订阅变更流，返回退订函数。
 *
 * 调用方**必须**在生命周期结束时调用退订（hook 在 effect cleanup 里做），
 * 否则引用计数永不归零，连接与闭包都不会释放。退订是幂等的。
 */
export function openChangeStream(subscriber: ChangeStreamSubscriber): () => void {
  subscribers.add(subscriber);
  if (subscribers.size === 1) {
    connect();
  } else {
    // 后来者：连接已经在了（甚至已经 open），立刻同步一次当前状态，
    // 否则它要等到下一次状态**变化**才能拿到值，指示灯会错误地停在初始的「断开」。
    subscriber.onStatus(connected);
  }

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    subscribers.delete(subscriber);
    if (subscribers.size === 0) disconnect();
  };
}
