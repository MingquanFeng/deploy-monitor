import type { Metadata } from "next";
import "./globals.css";
import Nav from "@/components/Nav";
import { ToastProvider } from "@/components/Toast";

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
      <body className="min-h-screen bg-gray-50 text-gray-900">
        <ToastProvider>
          <Nav />
          <main className="mx-auto max-w-6xl p-4 sm:p-6">{children}</main>
        </ToastProvider>
      </body>
    </html>
  );
}
