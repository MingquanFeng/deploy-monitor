"use client";

/**
 * 轻量 Toast。不引第三方依赖 —— Context + Provider 就够,
 * 需求只有「操作后给一句反馈」,不需要队列优先级 / 位置策略 / 手势关闭。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

type ToastKind = "success" | "error";

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  /** 弹一条成功提示。 */
  success: (message: string) => void;
  /** 弹一条失败提示。停留更久 —— 错误信息通常需要读完。 */
  error: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DURATION: Record<ToastKind, number> = {
  success: 3000,
  error: 5000,
};

const STYLE: Record<ToastKind, string> = {
  success: "border-green-200 bg-green-50 text-green-900",
  error: "border-red-200 bg-red-50 text-red-900",
};

const GLYPH: Record<ToastKind, string> = {
  success: "✓",
  error: "✕",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  // 卸载时要清掉所有未触发的定时器,否则会在已卸载的组件上 setState。
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, kind, message }]);

      const timer = setTimeout(() => {
        timers.current.delete(timer);
        dismiss(id);
      }, DURATION[kind]);
      timers.current.add(timer);
    },
    [dismiss],
  );

  // success/error 的身份必须稳定 —— 它们会进调用方的 useEffect 依赖数组。
  const success = useCallback((m: string) => push("success", m), [push]);
  const error = useCallback((m: string) => push("error", m), [push]);

  return (
    <ToastContext.Provider value={{ success, error }}>
      {children}
      {/*
        aria-live="polite" 让读屏软件在当前朗读结束后播报新增内容,
        不打断用户正在听的东西。容器常驻(即使空)——
        aria-live 区域必须在 DOM 里先存在,后插入内容才会被播报。
      */}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border px-4 py-3 text-sm shadow-lg ${STYLE[t.kind]}`}
          >
            <span aria-hidden="true" className="font-semibold leading-5">
              {GLYPH[t.kind]}
            </span>
            <span className="flex-1 leading-5">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="关闭提示"
              className="-mr-1 shrink-0 rounded px-1 leading-5 opacity-50 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast 必须在 <ToastProvider> 内部使用");
  }
  return ctx;
}
