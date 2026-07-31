import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // sql.js 是 WASM 包，必须作为外部包不参与打包，否则 webpack 试图把 .wasm 当作普通模块处理会失败
  serverExternalPackages: ["sql.js"],
  // standalone 模式：next build 会在 .next/standalone/ 产出自包含的运行目录，
  // 自动通过 outputFileTracing 把 serverExternalPackages 及其 WASM 资产（sql-wasm.wasm）
  // 拷贝进去，避免部署时遗漏文件导致 "Cannot find module './638.js'" 这类 webpack chunk 缺失错误
  output: "standalone",
  outputFileTracingIncludes: {
    "/**": ["./node_modules/sql.js/dist/sql-wasm.wasm"],
  },
};

export default nextConfig;
