import initSqlJs, { Database as SqlJsDatabase } from "sql.js";
import fs from "fs";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "deploy.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

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

  db.run(`
    CREATE TABLE IF NOT EXISTS services (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    UNIQUE NOT NULL,
      description TEXT   DEFAULT '',
      owner      TEXT    DEFAULT '',
      created_at TEXT    DEFAULT (datetime('now', 'localtime'))
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
      started_at  TEXT    DEFAULT (datetime('now', 'localtime')),
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
