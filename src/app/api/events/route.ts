import type { NextRequest } from "next/server";
import type { ChangeEvent } from "@/lib/events";
import { subscribe } from "@/lib/events";

/**
 * SSE 实时推送端点。浏览器用原生 EventSource 连上来，服务端在数据变更时单向下推。
 *
 * 为什么是 SSE 而不是 WebSocket：
 *   `ws` 必须 attach 到 HTTP server 实例，需要自定义 server.ts 接管启动流程，
 *   与当前的 standalone 部署（node .next/standalone/server.js）互斥。
 *   本项目只需要「服务端 → 浏览器」的单向通知，没有客户端主动推消息的需求，
 *   SSE 用标准 Route Handler 就能实现，部署方式零改动，且 EventSource 自带断线重连。
 *
 * 跨实例限制见 src/lib/events.ts 顶部注释 —— 事件总线是进程内的，多副本时
 * 客户端只会收到自己所连那个实例产生的事件。
 */

/**
 * 没有这行，Next.js 会把这个无参 GET 判定为可静态化路由，在构建期把响应
 * 预渲染成一个快照。SSE 是一条永不结束的流，静态化的结果是客户端拿到一个
 * 已经 close 的空 body，EventSource 立刻 error 并进入无限重连。
 */
export const dynamic = "force-dynamic";

/**
 * Node runtime（而非 Edge）：事件总线的另一端是 6 个 API 路由，它们都 import
 * better-sqlite3（原生模块，Edge 跑不了）。两边必须在同一个进程、同一个模块图里，
 * 否则 publish 与 subscribe 落在不同的模块实例上，事件根本传不过来。
 */
export const runtime = "nodejs";

/**
 * 心跳间隔。反向代理（Nginx proxy_read_timeout 默认 60s、ALB idle timeout 默认 60s）
 * 会掐掉在这段时间内没有任何字节流动的连接。25s 的取值让 60s 窗口里至少落进两次心跳：
 * 偶尔一次 tick 被事件循环延迟也不会触发超时，同时又不至于把连接刷成高频轮询。
 * （15s 太密 —— 100 个空闲连接就是 4 次写/秒的纯无效流量；30s 只留一次心跳，没有余量。）
 */
const HEARTBEAT_MS = 25_000;

/** SSE 注释帧：以 `:` 开头的行会被 EventSource 丢弃，只用于保活，不触发任何客户端回调。 */
const HEARTBEAT_FRAME = ": heartbeat\n\n";

/** 把事件序列化成 SSE 数据帧。`event:` 让客户端能用 addEventListener 按类型分流。 */
function formatEvent(event: ChangeEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();

  // 两条清理路径（abort / cancel）都指向这个函数，它必须幂等。
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      /**
       * 所有写入都过这里。连接断开后 controller 已 close，再 enqueue 会抛
       * "Invalid state: Controller is already closed" —— 该异常发生在
       * publish() 的循环里或 setInterval 的回调里，前者会被 events.ts 吞掉
       * （不影响其他订阅者），后者则是没人 catch 的 uncaughtException。
       * 所以在这里就地拦住，并顺手触发清理：写失败本身就是「连接没了」最早的信号，
       * 有时比 abort 事件先到。
       */
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
          cleanup();
        }
      };

      const unsubscribe = subscribe((event) => send(formatEvent(event)));

      const heartbeat = setInterval(() => send(HEARTBEAT_FRAME), HEARTBEAT_MS);
      // 心跳定时器不该成为进程退出的阻碍:一条长连接的保活 timer 会让
      // Node 的事件循环一直有活跃 handle。unref 后进程可以正常退出。
      // (Node 的 setInterval 返回 Timeout 对象;DOM 的类型声明里没有 unref,故做特性检测。)
      (heartbeat as unknown as { unref?: () => void }).unref?.();

      cleanup = () => {
        // 幂等：abort 与 cancel 都可能调进来，甚至同一次断开触发两次。
        // clearInterval 对已清理的 id 是 no-op，unsubscribe 内部自带 removed 标记。
        clearInterval(heartbeat);
        unsubscribe();
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // 已经被 close 过（例如 cancel 路径下流已由平台关闭），忽略
          }
        }
      };

      /**
       * 清理路径一：请求信号 abort。
       * 客户端主动断开（关标签页、EventSource.close()、curl Ctrl-C）时，
       * Next.js 的 Node adapter 会 abort 这个 signal。实测这是本项目 standalone
       * 下最可靠的一条 —— cancel() 在部分断开方式下不触发。
       *
       * 清理路径二：ReadableStream 的 cancel()（见下方）。
       * 消费端主动取消（下游 pipe 断裂、平台回收流）时走它，此时 signal 可能不 abort。
       * 两条都挂上、且 cleanup 幂等，是因为「哪条会触发」取决于断开方式与运行时
       * （dev server / standalone / 代理在中间），不能只赌一条。
       */
      req.signal.addEventListener("abort", () => cleanup(), { once: true });
      // 极端情况：请求在 stream 建立前就已 abort，此时 addEventListener 收不到事件
      if (req.signal.aborted) {
        cleanup();
        return;
      }

      // 立即发一帧，让客户端确认通道已打通（也顺带把 HTTP 响应头刷出去，
      // 避免代理在等 body 的第一个字节时缓冲整个响应）
      send(": connected\n\n");
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // 代理与浏览器都不得缓存这条流
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx 默认对 proxy_pass 的响应做缓冲（proxy_buffering on），
      // 会攒够一个 buffer 才转发 —— 对 SSE 意味着事件被扣在代理里，
      // 客户端要等好几秒甚至到心跳才一次性收到一批。这个头让 Nginx 对本响应关闭缓冲。
      // 非 Nginx 环境会忽略该头，加着无害。
      "X-Accel-Buffering": "no",
    },
  });
}
