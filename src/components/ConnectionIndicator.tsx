"use client";

/**
 * 实时连接状态指示灯。
 *
 * 存在的理由：这个面板的数据现在会自己变。用户看到一个「生产环境成功」的卡片时，
 * 需要知道那是**当前**状态，还是通道早就断了、停在几分钟前的快照上。
 * 没有这个指示，一条断掉的 SSE 连接和「一切正常、只是最近没有部署」
 * 在屏幕上完全无法区分 —— 而这两件事的含义天差地别。
 *
 * 刻意不用红色：SSE 断线后 EventSource 会自动退避重连，短暂断开是常态
 * （切网络、笔记本唤醒、代理回收空闲连接都会触发）。用红色告警会训练用户
 * 忽略它，等到真正需要注意的时候已经没人看了。灰色表达的是「暂时不确定」，
 * 而不是「出错了」，这与实际语义相符。
 */

import { useChangeStream } from "@/hooks/useChangeStream";

export default function ConnectionIndicator() {
  /**
   * 这里传空回调：本组件只要连接状态，不关心事件内容。
   * 不会因此多开一条连接 —— changeStream 内部按引用计数复用，
   * 整个标签页只有一条真实的 EventSource（见 src/lib/changeStream.ts）。
   */
  const { connected } = useChangeStream(() => {});

  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-gray-500"
      // 状态变化要让读屏用户也知道，但用 polite 避免打断正在朗读的内容。
      // 圆点本身 aria-hidden，文字承载语义 —— 颜色不能是唯一信息载体。
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 shrink-0 rounded-full transition-colors ${
          connected ? "bg-green-500" : "bg-gray-300"
        }`}
      />
      {/* 窄屏隐藏文字只留圆点，此时 sr-only 的完整描述仍在，读屏不受影响 */}
      <span className="hidden sm:inline">{connected ? "实时" : "未连接"}</span>
      <span className="sr-only">
        {connected ? "实时更新已连接" : "实时更新未连接，正在重试"}
      </span>
    </span>
  );
}
