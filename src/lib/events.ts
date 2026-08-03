/**
 * 进程内变更事件总线 —— SSE 推送的数据源。
 *
 * 单进程限制（重要，扩容前必读）
 * ------------------------------------------------------------------
 * 这个总线是**纯内存**的：订阅者集合就是下面那个 `Set`，活在当前 Node 进程的堆里。
 * 因此它只在「单实例部署」下正确。多实例（PM2 cluster / k8s 多副本 / 多容器）时：
 *   实例 A 处理了 POST /api/deployments，只有连在 A 上的 SSE 客户端收到通知；
 *   连在 B 上的客户端**永远收不到**，界面会一直停在旧数据。
 * 这不是 bug，是本方案的设计边界 —— 当前项目就是单容器 + 单 SQLite 文件
 * (src/lib/db.ts 在模块顶层建立唯一连接)，数据层本身也没有做多写实例。
 *
 * 要跨实例时该往哪走（按代价从低到高）：
 *   1. Redis Pub/Sub：把 publish() 改成 PUBLISH 到一个 channel，
 *      每个实例启动时 SUBSCRIBE，收到消息后再喂给本地 Set。
 *      本文件的对外 API（subscribe/publish）可以完全不变，只换内部实现，
 *      SSE 路由与 6 个写入点零改动。这是首选。
 *   2. Postgres LISTEN/NOTIFY：如果届时数据库已从 SQLite 迁到 Postgres，
 *      可以省掉 Redis 这个额外组件。
 *   3. 专用消息代理（NATS / Kafka）：只有在事件量大到需要持久化、
 *      重放、多消费者组时才值得，当前场景远远用不到。
 * 无论走哪条，都要额外处理「跨实例事件去重」和「实例重启后的补偿拉取」——
 * 内存版天然不需要考虑这两件事，别把它的简单当成可以直接水平扩展。
 */

/** 服务维度的变更。`service.deleted` 因外键级联同时删掉了该服务的全部部署记录。 */
export type ServiceChangeEvent = {
  type: "service.created" | "service.updated" | "service.deleted";
  serviceId: number;
};

/** 部署记录维度的变更。带上 serviceId，客户端可只刷新受影响的服务卡片。 */
export type DeploymentChangeEvent = {
  type: "deployment.created" | "deployment.updated";
  deploymentId: number;
  serviceId: number;
};

export type ChangeEvent = ServiceChangeEvent | DeploymentChangeEvent;

export type ChangeEventType = ChangeEvent["type"];

export type ChangeListener = (event: ChangeEvent) => void;

/**
 * 为什么手写 Set 而不用 Node 的 EventEmitter：
 *
 * 1. listener 上限。EventEmitter 默认在同一事件上挂到第 11 个 listener 就往
 *    stderr 打 MaxListenersExceededWarning。一个 SSE 连接 = 一个 listener，
 *    11 个并发浏览器标签就会开始刷警告。要么 setMaxListeners(0) 关掉这层保护，
 *    要么自己管集合 —— 既然保护本身对我们没意义，不如省掉这个坑。
 * 2. 错误隔离。EventEmitter 同步串行调用 listener，任一个抛错会中断后续调用
 *    （并冒泡成 uncaughtException 打挂进程）。对 SSE 来说这意味着「一个已断开的
 *    连接写失败」会导致「其余健康连接收不到这条事件」。下面的 publish() 逐个
 *    try/catch，坏连接只影响自己。
 * 3. 类型。Set<ChangeListener> 天然是强类型的；EventEmitter 的 emit(name, ...args)
 *    需要额外的泛型体操才能约束 payload。
 */
const listeners = new Set<ChangeListener>();

/**
 * 订阅变更事件，返回退订函数。
 *
 * 调用方**必须**在自己生命周期结束时调用返回的函数（SSE 路由在 abort / cancel
 * 时调用），否则每个断开的连接都会在 Set 里留下一个永不回收的闭包 —— 这个闭包
 * 持有 stream controller，泄漏的不只是函数本身。退订是幂等的，重复调用无副作用。
 */
export function subscribe(listener: ChangeListener): () => void {
  listeners.add(listener);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    listeners.delete(listener);
  };
}

/**
 * 广播事件给所有订阅者。
 *
 * 契约：**本函数永不抛错**。调用点（6 个写 API）据此可以直接裸调，
 * 不必包 try/catch —— 推送失败绝不能把一次已经成功落库的写操作变成 500。
 *
 * 实现上两处刻意的选择：
 *   - 遍历前先 `[...listeners]` 快照。listener 内部若调用 subscribe/退订
 *     （例如收到 service.deleted 后主动关连接），直接遍历 live Set 的行为
 *     在规范上虽然定义良好，但语义绕；快照让「这一次广播的收件人」是确定的。
 *   - 每个 listener 单独 try/catch，一个坏的不影响其它。
 */
export function publish(event: ChangeEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // 单个订阅者失败（多半是连接已断、enqueue 抛错）不影响其他订阅者。
      // 这里刻意不打日志：一个反复断开的客户端会把日志刷爆，
      // 且这类失败对服务端没有可操作性 —— 连接自己会走 cancel/abort 清理。
    }
  }
}

/**
 * 当前订阅者数量。
 *
 * 存在的意义是可观测性与回归测试：SSE 最典型的线上故障是「连接断了但 listener
 * 没退订」，表现为内存与广播耗时随时间单调上升。有了这个计数，
 * 「反复连接再断开后应回到 0」可以写成断言（见 route.test.ts），
 * 而不是靠人肉观察内存。
 */
export function subscriberCount(): number {
  return listeners.size;
}
