"use client";

/**
 * 主导航。抽成独立客户端组件是为了用 `usePathname()` 标出当前页,
 * 而不必把整个 RootLayout 变成客户端组件 —— layout 里的 metadata
 * 导出依赖 Server Component,且把 layout 客户端化会让所有页面
 * 都丢掉服务端渲染的机会。
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import ConnectionIndicator from "@/components/ConnectionIndicator";
import { BUTTON_PRIMARY } from "@/lib/constants";

const LINKS = [
  { href: "/", label: "仪表盘" },
  { href: "/stats", label: "统计" },
  { href: "/services", label: "服务管理" },
  { href: "/deployments", label: "部署历史" },
] as const;

export default function Nav() {
  const pathname = usePathname();

  /**
   * "/" 必须精确匹配,否则它会是所有路径的前缀、永远高亮。
   * 其余用前缀匹配,这样 /services/3 与 /services/3/edit 也能
   * 点亮「服务管理」。
   */
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <nav className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-1 gap-y-2 px-4 py-2.5 sm:px-6">
        <Link
          href="/"
          className="mr-3 rounded text-base font-bold text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          部署监控
        </Link>

        {LINKS.map(({ href, label }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              // aria-current 是给读屏用户的「你在这」——
              // 视觉上的高亮对他们不可见。
              aria-current={active ? "page" : undefined}
              className={`inline-flex h-9 items-center rounded-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                active
                  ? "bg-blue-50 font-medium text-blue-700"
                  : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              }`}
            >
              {label}
            </Link>
          );
        })}

        {/*
          ml-auto 从「新建部署」移到这里 —— 指示灯与按钮一起被推到右侧，
          两者按 gap-3 并排。放在按钮左边而不是最右：最右是主操作的位置，
          一个被动的状态显示不该占据它。
        */}
        <div className="ml-auto flex items-center gap-3">
          <ConnectionIndicator />
          <Link href="/deployments/new" className={BUTTON_PRIMARY}>
            新建部署
          </Link>
        </div>
      </div>
    </nav>
  );
}
