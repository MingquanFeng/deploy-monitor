import initSqlJs, { Database as SqlJsDatabase } from "sql.js";
import fs from "fs";
import path from "path";

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

let db: SqlJsDatabase;

const initPromise = (async () => {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run("PRAGMA foreign_keys = ON");

  // 时间字段一律由应用层通过 nowLocal() 显式传入,SQL 默认值不再依赖 localtime
  db.run(`
    CREATE TABLE IF NOT EXISTS services (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    UNIQUE NOT NULL,
      description TEXT   DEFAULT '',
      owner      TEXT    DEFAULT '',
      created_at TEXT    DEFAULT NULL
    )
  `);

  db.run(`
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

  save();
})();

export async function getDb(): Promise<SqlJsDatabase> {
  await initPromise;
  return db;
}

export function save() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
  // sql.js 的 db.export() 会把连接级 PRAGMA 重置为默认值,foreign_keys 会变回 0。
  // run() 每次写入都调用 save(),若不在这里补回来,第一次写操作之后外键就永久失效:
  // 删除服务不再级联删除其部署记录(留下孤儿数据),
  // 且能插入指向不存在服务的部署记录。回归测试见 src/lib/db.test.ts。
  db.run("PRAGMA foreign_keys = ON");
}

export function query<T = Record<string, unknown>>(
  db: SqlJsDatabase,
  sql: string,
  params: (string | number)[] = []
): T[] {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows: T[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return rows;
}

export function run(
  db: SqlJsDatabase,
  sql: string,
  params: (string | number | null)[] = []
) {
  db.run(sql, params);
  save();
}
