"use client";

/**
 * 把 SSE 变更流接进 React。
 *
 * 连接生命周期、按类型分流、引用计数都在 src/lib/changeStream.ts（纯 JS、有测试），
 * 这里只负责 React 侧的两件事：ref 化回调、把连接状态变成 state。
 */

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "@/lib/events";
import { openChangeStream } from "@/lib/changeStream";

export interface UseChangeStreamOptions {
  /**
   * 是否建立连接，默认 true。传 false 时不占用连接
   * （例如某个页面在特定状态下不需要实时刷新）。
   */
  enabled?: boolean;
}

export interface UseChangeStreamResult {
  /** 通道是否连通。断线重连期间为 false，恢复后自动回到 true。 */
  connected: boolean;
}

/**
 * 订阅变更事件，返回连接状态。
 *
 * @param onChange 每条事件调用一次。**允许传内联箭头函数** —— 见下方 ref 说明。
 */
export function useChangeStream(
  onChange: (event: ChangeEvent) => void,
  options: UseChangeStreamOptions = {}
): UseChangeStreamResult {
  const { enabled = true } = options;
  const [connected, setConnected] = useState(false);

  /**
   * onChange 存进 ref，effect 只依赖 [enabled]。
   *
   * 这是本 hook 唯一容易写错的地方。如果把 onChange 放进依赖数组，而调用方
   * 写的是 `useChangeStream((e) => { ... })`（内联箭头函数，每次 render 都是
   * 新引用），effect 就会在每次 render 时 cleanup + 重建 —— 也就是
   * 每次 render 都断开一条 SSE 连接、再重连一条。更糟的是这形成正反馈：
   * refetch → setState → render → 新函数 → 重连，一次数据变更可以引发
   * 连续多次重连。而重连本身带指数退避，用户会看到指示灯持续闪烁。
   *
   * 用 ref 之后，调用方不需要为了这个 hook 去包 useCallback
   * （包了也没坏处，但不是必须的），也就不需要把「回调必须稳定」
   * 这个隐含契约写在文档里靠人记住。
   *
   * 赋值放在 effect 外的渲染阶段：React 18 并发下 useLayoutEffect 更严谨，
   * 但那会引入 SSR 警告，而这里的时序要求很松 —— 事件来自异步的网络回调，
   * 一定发生在当前这轮 render 提交之后，届时 ref 早已是最新值。
   */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!enabled) {
      // 从 enabled=true 切到 false 时把灯灭掉，否则会停在上一次的 true
      setConnected(false);
      return;
    }

    // openChangeStream 内部做引用计数：同一标签页只有一条真实 EventSource。
    // 返回的退订函数在 cleanup 里调用 —— 组件卸载（含路由切页）必须走到这里，
    // 否则计数不归零，连接会随着切页累积。
    return openChangeStream({
      onEvent: (event) => onChangeRef.current(event),
      onStatus: setConnected,
    });
  }, [enabled]);

  return { connected };
}
