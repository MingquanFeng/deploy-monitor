import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 是原生模块（.node 二进制），必须作为外部包不参与打包，
  // 否则 webpack 试图把 .node 当作普通 JS 模块解析会失败
  serverExternalPackages: ["better-sqlite3"],
  // standalone 模式：next build 会在 .next/standalone/ 产出自包含的运行目录。
  // outputFileTracing 能跟到 better-sqlite3 的 JS 文件，但跟不到 prebuilds/*.node —
  // lib/binding.js 是在运行时按 `${platform}-${arch}` 拼路径 require 的（动态字符串），
  // 静态分析看不见，必须显式声明，否则 standalone 启动即 "Cannot find module ... .node"
  output: "standalone",
  outputFileTracingIncludes: {
    "/**": ["./node_modules/better-sqlite3/prebuilds/**"],
  },
};

export default nextConfig;
