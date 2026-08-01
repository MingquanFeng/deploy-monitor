"use client";

/**
 * 确认对话框,替代原生 `confirm()`。
 *
 * 原生 confirm 的可访问性其实是浏览器给的(焦点、Escape、读屏播报都免费)。
 * 自己做模态就得把这些补回来,否则是可访问性的退步:
 *   - role="dialog" + aria-modal + aria-labelledby  → 读屏识别为模态并播报标题
 *   - 打开时把焦点移进对话框,关闭时还给触发元素   → 键盘用户不会掉焦点到 body
 *   - Tab 在对话框内循环                            → 焦点不会跑到背后的页面上
 *   - Escape 关闭
 */

import { useCallback, useEffect, useRef } from "react";
import { BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY } from "@/lib/constants";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** 正文。用 ReactNode 以便强调具体对象(如服务名)。 */
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** destructive 时确认按钮用红色,并让「取消」成为默认焦点。 */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  // 打开前的焦点位置,关闭后要还回去。
  const restoreRef = useRef<HTMLElement | null>(null);

  // 打开时接管焦点。破坏性操作把默认焦点放在「取消」上,
  // 这样误敲回车不会直接删数据。
  useEffect(() => {
    if (!open) return;

    restoreRef.current = document.activeElement as HTMLElement | null;
    const target = destructive ? cancelRef.current : confirmRef.current;
    target?.focus();

    return () => {
      restoreRef.current?.focus?.();
    };
  }, [open, destructive]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
        return;
      }

      if (e.key !== "Tab") return;

      // 焦点循环:把 Tab 圈在对话框内部。
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;

      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onCancel],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4"
      // 点遮罩关闭,但只在遮罩自身被点中时 —— 面板内的点击会冒泡到这里。
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={description ? "confirm-dialog-desc" : undefined}
        className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
      >
        <h2 id="confirm-dialog-title" className="text-lg font-semibold text-gray-900">
          {title}
        </h2>
        {description && (
          <div id="confirm-dialog-desc" className="mt-2 text-sm text-gray-600">
            {description}
          </div>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={onCancel} className={BUTTON_SECONDARY}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={destructive ? BUTTON_DANGER : BUTTON_PRIMARY}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
