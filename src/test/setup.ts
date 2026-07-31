import fs from "fs";
import os from "os";
import path from "path";
import { afterAll } from "vitest";

/**
 * 数据库隔离:在任何测试代码 import `@/lib/db` 之前,把数据库路径指向
 * 本进程私有的临时目录,确保测试永远不碰仓库里的 data/deploy.db。
 *
 * src/lib/db.ts 在模块顶层解析路径:
 *   const DB_PATH = process.env.DATA_DIR
 *     ? path.join(process.env.DATA_DIR, "deploy.db")
 *     : path.join(process.cwd(), "data", "deploy.db");
 * 两条分支都要堵住,所以这里同时:
 *   1. 显式设置 DATA_DIR 指向临时目录(优先级最高的那条分支);
 *   2. chdir 到临时目录(兜住 DATA_DIR 万一被清空的情况)。
 * setupFiles 在测试文件被 import 之前执行,因此赋值一定早于 db.ts 求值。
 * 生产代码零改动。
 *
 * 为什么每个文件一个目录:
 *   vitest 配置了 pool:"forks" + isolate:true,每个测试文件跑在独立子进程里,
 *   于是每个文件拿到自己的 DATA_DIR、自己的 sql.js 单例、自己的数据库文件。
 *   并行执行时测试之间不共享任何状态。
 */

// macOS 上 os.tmpdir() 是 /var/... 的符号链接(真实路径 /private/var/...),
// process.chdir() 后 process.cwd() 会返回解析后的真实路径。
// 这里先解析,让后续对 cwd 的断言与实际值一致。
const tmpRoot = fs.mkdtempSync(
  path.join(fs.realpathSync(os.tmpdir()), `deploy-monitor-test-${process.pid}-`)
);

const dataDir = path.join(tmpRoot, "data");
fs.mkdirSync(dataDir, { recursive: true });

process.env.DATA_DIR = dataDir;
process.chdir(tmpRoot);

function cleanup() {
  try {
    // 先离开将被删除的目录,避免 cwd 悬空
    process.chdir(fs.realpathSync(os.tmpdir()));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // 清理失败不应让测试变红
  }
}

// afterAll 由 vitest 保证执行,比 process.on("exit") 可靠:
// fork worker 常被信号回收,exit 监听器不一定跑得到,会在 /tmp 里堆积垃圾目录。
afterAll(cleanup);
// 兜底:进程被异常终止时尽力清理
process.on("exit", cleanup);
