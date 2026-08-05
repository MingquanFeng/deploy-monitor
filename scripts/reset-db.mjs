/**
 * 清空数据库：删掉所有服务与部署记录，并重置自增序列。
 *
 * 用法（必须显式带 --yes，防手滑）：
 *   node scripts/reset-db.mjs --yes
 *
 * 数据目录由 DATA_DIR 决定，与 src/lib/db.ts 同一套解析规则：
 *   DATA_DIR=/path/to/dir node scripts/reset-db.mjs --yes
 * 不设则用项目根的 data/。
 *
 * 不带 --yes 时只打印当前数据量，不做任何改动 —— 顺便当作「看看库里有多少数据」的工具。
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, "deploy.db")
  : path.join(process.cwd(), "data", "deploy.db");

if (!fs.existsSync(DB_PATH)) {
  console.log(`数据库不存在: ${DB_PATH}`);
  console.log("（首次启动应用时会自动创建，无需手动处理）");
  process.exit(0);
}

const db = new Database(DB_PATH);
// 与应用同样开启外键：删 services 时靠 ON DELETE CASCADE 带走 deployments
db.pragma("foreign_keys = ON");

const count = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
const before = { services: count("services"), deployments: count("deployments") };

console.log(`数据库: ${DB_PATH}`);
console.log(`  services:    ${before.services}`);
console.log(`  deployments: ${before.deployments}`);

if (!process.argv.includes("--yes")) {
  console.log("\n未做任何改动。要真的清空，重跑并加上 --yes：");
  console.log("  node scripts/reset-db.mjs --yes");
  process.exit(0);
}

if (before.services === 0 && before.deployments === 0) {
  console.log("\n已经是空库，无需清理。");
  process.exit(0);
}

// 单事务：中途失败不留下「服务删了但部署还在」的半清空状态
db.transaction(() => {
  db.exec("DELETE FROM deployments");
  db.exec("DELETE FROM services");
  // 重置自增序列，让下次插入从 id=1 开始。sqlite_sequence 只有在表用过
  // AUTOINCREMENT 之后才存在对应行，DELETE 不存在的行是 no-op，不必判断。
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('services','deployments')");
})();

console.log(`\n已清空 ${before.services} 个服务、${before.deployments} 条部署记录，自增 id 已重置。`);
