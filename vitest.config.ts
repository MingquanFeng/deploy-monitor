import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // forks(而非 threads): src/lib/db.ts 在模块顶层根据 process.cwd() 解析
    // DB_PATH,测试需要在 import 之前 chdir 到临时目录以隔离数据库。
    // process.chdir() 在 worker_threads 中不可用,必须用子进程池。
    pool: "forks",
    // 每个测试文件独占一个 fork => 独占 cwd => 独占数据库文件。
    // 这是本套件数据隔离的基石,不要改成 true。
    isolate: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/lib/**", "src/app/api/**"],
      exclude: ["src/test/**", "src/**/*.test.ts", "src/types/**"],
    },
  },
});
