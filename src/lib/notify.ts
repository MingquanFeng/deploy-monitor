/**
 * 部署失败的 Server酱 通知。
 *
 * 为什么挂在事件总线上而不是在写入点直接调
 * ------------------------------------------------------------------
 * 项目里有 6 处写 API 会 publish()。若在每处补一次推送调用，「通知」这件事就被
 * 摊进了业务路由：将来加第 7 个写入点必然有人忘记补，而漏掉是静默的
 * （没人会因为「少了一条通知」而收到报错）。挂 listener 则让订阅关系只有一处，
 * 写入点对通知的存在完全无感 —— 这也正是 v0.5.0 引入 events.ts 的目的。
 *
 * 只推 pending → failed 这一次跃变
 * ------------------------------------------------------------------
 * 判据是**状态迁移**，不是「当前状态是不是 failed」。后者会让每一次
 * `PUT {status:"failed"}` 都推一条 —— 而把一条已经 failed 的记录再标一次 failed
 * 是完全合法的操作（页面上按钮就摆在那里，运维手抖点两下很正常），
 * 于是同一次故障会被反复轰炸。前态由 PUT 路由在 UPDATE 之前读出并放进事件里
 * （见 src/lib/events.ts 的 DeploymentChangeEvent），因为 publish() 发生在 UPDATE
 * 之后，那一刻库里已经查不到「改动前是什么」了。
 *
 * 相应的边界（刻意不覆盖，不是遗漏）：
 *   - `deployment.created` 直接以 failed 落库（webhook 上报 status=failed）不推。
 *     CI 上报失败时自己的流水线已经红了、已经有通知渠道，这里再推一条是重复。
 *   - success → failed 不推。这种迁移意味着「先报成功又改判失败」，属于人工纠正
 *     记录，不是一次新发生的故障。
 *
 * 单进程限制与 events.ts 同源：listener 活在当前 Node 进程堆里，多副本部署时
 * 每个实例各自订阅自己的总线。对通知而言这恰好是对的（事件只在处理写请求的
 * 那个实例上产生，也只由它推一次），但若将来按 events.ts 的建议换成 Redis
 * Pub/Sub，就必须额外处理跨实例去重 —— 否则 N 个副本会推 N 条。
 */

import { getDb, query } from "@/lib/db";
import type { ChangeEvent, DeploymentChangeEvent } from "@/lib/events";
import { subscribe } from "@/lib/events";

/** Server酱 API 端点。SCF_API_BASE 用于端到端验证（指向假服务器），生产不设置。 */
const SCF_API_BASE = process.env.SCF_API_BASE?.trim() || "https://sctapi.ftqq.com";

/**
 * 网络超时。没有超时的 fetch 在对端黑洞时会挂到 Node 的默认行为
 * （可能是几分钟），期间这个 Promise 与它闭包持有的数据都不会释放。
 * 通知是「尽力而为」的旁路，10s 拿不到响应就该放弃。
 */
const TIMEOUT_MS = 10_000;

/**
 * 读取 SendKey。每次发送前读，而不是在模块顶层求值一次。
 *
 * 模块顶层求值会带来一个隐蔽的问题：本模块在路由模块图里被很早地 import，
 * 而 Next.js 加载 .env 的时机与模块求值顺序并无强保证；一旦顺序反了，
 * 顶层读到的就是 undefined，且此后永远是 undefined（模块只求值一次），
 * 表现为「配置明明填了却从不推送」。每次读的成本是一次对象属性访问，可以忽略。
 */
function readKey(): string | null {
  const key = process.env.SERVERCHAN_KEY?.trim() ?? null;
  return key === "" ? null : key;
}

/** 空值占位。version / deployed_by 在库里默认是空串（手动录入常留空）。 */
function orDash(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? "-" : trimmed;
}

/** 通知需要的字段，从 deployments JOIN services 取。 */
type FailedDeployment = {
  service_name: string;
  environment: string;
  version: string;
  deployed_by: string;
  finished_at: string | null;
  started_at: string | null;
};

/**
 * 拼通知内容。
 *
 * Server酱免费版只支持纯文本，没有 `disable_notification` 控制。
 * 生产环境的显著性通过标题前缀 `[生产]` 体现：通知列表预览行里
 * 第一行就能看出严重性，不需要靠 emoji 或颜色。
 * （Server酱不支持 emoji，会原样显示）
 *
 * 消息分两行：标题行含环境标识，正文行包含全部上下文。
 */
function buildMessage(row: FailedDeployment): { title: string; desp: string } {
  const isProd = row.environment === "prod";
  const envLabel =
    row.environment === "prod"
      ? "生产"
      : row.environment === "staging"
        ? "预发"
        : "测试";

  const title = isProd ? `[生产] ${row.service_name} 部署失败` : `${row.service_name} 部署失败（${envLabel}）`;

  // finished_at 兜底到 started_at：PUT 写 failed 时一定有 finished_at，
  // 但 webhook 直接以 failed 落库的历史记录里可能为空。
  const at = orDash(row.finished_at ?? row.started_at);

  const lines = [
    `服务：${row.service_name}`,
    `环境：${envLabel}`,
    `版本：${orDash(row.version)}`,
    `部署人：${orDash(row.deployed_by)}`,
    `时间：${at}`,
  ];
  return { title, desp: lines.join("\n") };
}

/**
 * 调 Server酱 API。**不抛错**：任何失败都只 console.warn。
 *
 * 契约上必须如此。这条链路的起点是 publish()，而 publish() 的起点是一次
 * 已经成功落库的 PUT —— 通知发不出去绝不能反过来影响那个 200 响应。
 * events.ts 的 publish 吞同步异常，async listener 逃出的 rejection 会变成
 * unhandledRejection 打挂进程，所以必须在这一层自己收干净。
 */
async function send(key: string, title: string, desp: string): Promise<void> {
  try {
    const res = await fetch(`${SCF_API_BASE}/${key}.send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, desp }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(
        `[notify] Server酱 推送失败 HTTP ${res.status}: ${detail.slice(0, 300)}`
      );
    }
  } catch (e) {
    console.warn(
      `[notify] Server酱 推送异常: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/**
 * 是否是「一次新发生的部署失败」。
 *
 * 返回类型谓词而不是 boolean：调用方紧接着就要读 `event.deploymentId`，
 * 而它在 ServiceChangeEvent 上不存在。谓词让编译器完成收窄。
 */
export function isNewFailure(
  event: ChangeEvent
): event is DeploymentChangeEvent & { type: "deployment.updated" } {
  return (
    event.type === "deployment.updated" &&
    event.previousStatus === "pending" &&
    event.status === "failed"
  );
}

/**
 * 处理一条事件：判定 → 读库 → 发送。
 *
 * 为什么要回库读一次而不是把这些字段全塞进事件里：事件是给 SSE 用的，它的载荷
 * 要小、要稳定（每个浏览器标签都会收到一份）。通知需要 service_name，那是
 * services 表的列，塞进事件就等于让事件形状迁就一个旁路消费者。
 *
 * 记录可能已经不在了（读之前的 await 让出过事件循环，期间该服务可能被删、
 * 级联带走了这条记录）。这时静默返回。
 */
async function handle(event: ChangeEvent): Promise<void> {
  if (!isNewFailure(event)) return;

  const key = readKey();
  // 未配置 => 静默跳过。这是默认状态（本地开发、CI、未接入 Server酱 的部署），
  // 不该打日志：每一次失败标记都刷一行 warn，只是噪音。
  if (!key) return;

  const db = await getDb();
  const rows = query<FailedDeployment>(
    db,
    `SELECT d.environment, d.version, d.deployed_by, d.started_at, d.finished_at,
            s.name AS service_name
       FROM deployments d
       JOIN services s ON d.service_id = s.id
      WHERE d.id = ?`,
    [event.deploymentId]
  );
  if (!rows.length) return;

  const { title, desp } = buildMessage(rows[0]);
  await send(key, title, desp);
}

/**
 * 注册失败通知监听器，返回退订函数。
 *
 * 幂等：重复调用不会挂上第二个 listener，而是返回同一个退订函数。
 * 这点是必需的 —— dev 的 HMR 会让模块重新求值，没有这道闩就会一次故障推多条。
 */
let stopExisting: (() => void) | null = null;

export function startFailureNotifier(): () => void {
  if (stopExisting) return stopExisting;

  const unsubscribe = subscribe((event) => {
    // listener 必须是同步的（publish 不 await 返回值）。这里刻意不 await：
    // 一次网络往返最长 10s，publish 若等它就会把 PUT 的响应也拖住 10s。
    void handle(event);
  });

  stopExisting = () => {
    unsubscribe();
    stopExisting = null;
  };
  return stopExisting;
}

/**
 * 模块被 import 时立即注册。
 *
 * 为什么不用 src/instrumentation.ts：Next 15.1 下 webpack 把
 * instrumentation打进独立 chunk，进程里会出现两份 events.ts 实例，
 * 订阅者与 publish 方不在同一个 Set 上，通知静默失效（无任何报错）。
 * 改为模块顶层自注册，由 PUT 路由用副作用 import 拉进来，
 * 保证订阅方与 publish 方在同一个模块图里。详见 CLAUDE.md。
 */
startFailureNotifier();
