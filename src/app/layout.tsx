import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "部署监控面板",
  description: "实时监控各服务部署状态",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className="bg-gray-50 text-gray-900 min-h-screen">
        <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-6">
          <a href="/" className="text-lg font-bold text-gray-800">
            部署监控
          </a>
          <a href="/" className="text-sm text-gray-600 hover:text-gray-900">
            仪表盘
          </a>
          <a href="/services" className="text-sm text-gray-600 hover:text-gray-900">
            服务管理
          </a>
          <a href="/deployments" className="text-sm text-gray-600 hover:text-gray-900">
            部署历史
          </a>
          <a
            href="/deployments/new"
            className="ml-auto text-sm bg-blue-600 text-white px-4 py-1.5 rounded hover:bg-blue-700"
          >
            新建部署
          </a>
        </nav>
        <main className="max-w-6xl mx-auto p-6">{children}</main>
      </body>
    </html>
  );
}
