import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export type Db = Database.Database;

// 数据目录可通过 DATA_DIR 覆盖（容器部署时挂载卷到该路径），默认落在项目 data/ 下
const DB_PATH = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, "deploy.db")
  : path.join(process.cwd(), "data", "deploy.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

/**
 * 应用层生成本地时间字符串,格式 YYYY-MM-DD HH:MM:SS
 * 统一所有时间字段的写入路径,避免 SQL 端 datetime('now','localtime')
 * 在不同时区机器上表现不一致
 */
export function nowLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" + pad(d.getMonth() + 1) +
    "-" + pad(d.getDate()) +
    " " + pad(d.getHours()) +
    ":" + pad(d.getMinutes()) +
    ":" + pad(d.getSeconds())
  );
}

const db: Db = new Database(DB_PATH);

// WAL:读不阻塞写、写不阻塞读,且写入只追加 -wal 而非重写整库。
// 这是相对 sql.js「每次写入 export() 全库序列化 + 覆写文件」的核心改进。
db.pragma("journal_mode = WAL");
// NORMAL 配 WAL 是标准组合:仅在 checkpoint 时 fsync,断电最多丢最后几个事务,
// 数据库本身不会损坏。对部署记录这种可重放的数据足够。
db.pragma("synchronous = NORMAL");
// 连接级 PRAGMA,只需在建连接时设一次即可对本连接的全部语句生效。
// (sql.js 时期必须在每次 save() 后补设,因为 export() 会把它重置为 0。)
db.pragma("foreign_keys = ON");
// 并发写入时不立即报 SQLITE_BUSY,先等待重试
db.pragma("busy_timeout = 5000");

// 时间字段一律由应用层通过 nowLocal() 显式传入,SQL 默认值不再依赖 localtime
db.exec(`
  CREATE TABLE IF NOT EXISTS services (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    UNIQUE NOT NULL,
    description TEXT   DEFAULT '',
    owner      TEXT    DEFAULT '',
    created_at TEXT    DEFAULT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS deployments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id  INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    environment TEXT    NOT NULL CHECK(environment IN ('test','staging','prod')),
    version     TEXT    NOT NULL DEFAULT '',
    status      TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','success','failed')),
    deployed_by TEXT    DEFAULT '',
    note        TEXT    DEFAULT '',
    started_at  TEXT    DEFAULT NULL,
    finished_at TEXT
  )
`);

// 回滚标记:rollback_from 指向被本次回滚修复的那条部署记录。
// SQLite 没有 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 语法,重复执行 ADD COLUMN
// 会直接抛 "duplicate column name",所以幂等只能靠先查 table_info 再决定是否执行。
// db.pragma() 的声明返回类型是 unknown,需要断言成行结构才能取 name。
const deploymentCols = db.pragma("table_info(deployments)") as { name: string }[];
if (!deploymentCols.some((c) => c.name === "rollback_from")) {
  // ON DELETE SET NULL:被回滚的原记录若被删,回滚记录本身保留,只是丢掉指向。
  db.exec(
    "ALTER TABLE deployments ADD COLUMN rollback_from INTEGER REFERENCES deployments(id) ON DELETE SET NULL"
  );
}

/**
 * better-sqlite3 是同步驱动,拿实例不需要等待。
 * 保留 async 签名是刻意的:16 处调用点都写着 `await getDb()`,
 * 维持这个契约让驱动替换对上层零改动(await 一个非 Promise 值也是合法的)。
 */
export async function getDb(): Promise<Db> {
  return db;
}

/** 当前使用的数据库文件路径(WAL 的 -wal/-shm 边车文件与它同目录同前缀)。 */
export function getDbPath(): string {
  return DB_PATH;
}

export type SqlParam = string | number | null;

export function query<T = Record<string, unknown>>(
  db: Db,
  sql: string,
  params: SqlParam[] = []
): T[] {
  return db.prepare(sql).all(params) as T[];
}

export function run(db: Db, sql: string, params: SqlParam[] = []): void {
  db.prepare(sql).run(params);
}

/**
 * 写操作的返回信息。需要新插入行 id 时用它,
 * 替代 sql.js 时期「INSERT 后 ORDER BY id DESC LIMIT 1 反查」的兜底
 * (sql.js 的 last_insert_rowid() 经 db.exec() 读取恒为 0,拿不到真实 id)。
 */
export function runInfo(
  db: Db,
  sql: string,
  params: SqlParam[] = []
): Database.RunResult {
  return db.prepare(sql).run(params);
}

/**
 * 判断错误是否为 UNIQUE 约束冲突(API 层据此返回 409 而非 500)。
 *
 * 主判据是 better-sqlite3 的结构化 `code`,它由驱动按 SQLite 扩展错误码直接给出,
 * 不受错误文案变化影响 —— 这是相对 sql.js 时期只能 `message.includes(...)` 的改进
 * (sql.js 的错误 name 是 "Error",没有 code 字段)。
 *
 * 仍保留 message 兜底:错误若经过序列化/包装(跨 worker、被第三方中间件重新抛出)
 * 会丢掉 code 与原型链,此时文案是唯一可用信号。两条判据同时存在严格优于任一单独一条。
 */
export function isUniqueViolation(e: unknown): boolean {
  if (typeof e === "object" && e !== null && "code" in e) {
    const code = (e as { code?: unknown }).code;
    if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      return true;
    }
  }
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("UNIQUE constraint failed");
}
