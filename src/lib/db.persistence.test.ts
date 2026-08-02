import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 单独一个文件来测「进程重启后从磁盘已有的 .db 文件恢复」这条路径。
 *
 * db.ts 的 DB_PATH 与连接都在模块顶层求值一次,所以要模拟「重启」,
 * 必须把 DATA_DIR 指向目标目录后 vi.resetModules() 重新 import,
 * 让模块顶层代码再跑一遍、重新打开同一个文件。
 * 放在独立文件里,避免 resetModules 影响其他测试的模块单例。
 *
 * better-sqlite3 直接读写磁盘文件(WAL 模式),不像 sql.js 那样需要
 * 先 readFileSync 整个文件再喂给内存数据库,恢复是驱动天然行为。
 */

const originalDataDir = process.env.DATA_DIR;
let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), `deploy-monitor-reload-${process.pid}-`)
  );
  vi.resetModules();
});

afterEach(() => {
  process.env.DATA_DIR = originalDataDir;
  fs.rmSync(scratch, { recursive: true, force: true });
  vi.resetModules();
});

describe("db.ts 持久化与恢复", () => {
  it("首次启动时新建数据库文件", async () => {
    process.env.DATA_DIR = scratch;
    const mod = await import("@/lib/db");
    await mod.getDb();
    expect(fs.existsSync(path.join(scratch, "deploy.db"))).toBe(true);
  });

  it("重启后能从磁盘恢复已写入的数据", async () => {
    process.env.DATA_DIR = scratch;

    // 第一次「启动」:写入一条服务
    const first = await import("@/lib/db");
    const db1 = await first.getDb();
    first.run(db1, "INSERT INTO services (name, created_at) VALUES (?, ?)", [
      "survivor",
      "2026-01-01 00:00:00",
    ]);
    expect(fs.existsSync(path.join(scratch, "deploy.db"))).toBe(true);

    // 第二次「启动」:同一个 DATA_DIR,模块重新求值 => 走 existsSync 分支
    vi.resetModules();
    const second = await import("@/lib/db");
    const db2 = await second.getDb();
    const rows = second.query<{ name: string }>(
      db2,
      "SELECT name FROM services WHERE name = ?",
      ["survivor"]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("survivor");
  });

  it("从磁盘恢复后外键依然生效(级联删除可用)", async () => {
    process.env.DATA_DIR = scratch;

    const first = await import("@/lib/db");
    const db1 = await first.getDb();
    first.run(db1, "INSERT INTO services (name) VALUES (?)", ["svc"]);
    const id = first.query<{ id: number }>(db1, "SELECT id FROM services")[0].id;
    first.run(db1, "INSERT INTO deployments (service_id, environment) VALUES (?, ?)", [
      id,
      "prod",
    ]);

    vi.resetModules();
    const second = await import("@/lib/db");
    const db2 = await second.getDb();
    expect(second.query(db2, "SELECT * FROM deployments")).toHaveLength(1);

    second.run(db2, "DELETE FROM services WHERE id = ?", [id]);
    // 恢复路径同样要保证 PRAGMA foreign_keys 生效,否则留下孤儿记录
    expect(second.query(db2, "SELECT * FROM deployments")).toEqual([]);
  });

  it("DATA_DIR 不存在时会被自动创建", async () => {
    const nested = path.join(scratch, "a", "b", "c");
    process.env.DATA_DIR = nested;
    const mod = await import("@/lib/db");
    await mod.getDb();
    expect(fs.existsSync(path.join(nested, "deploy.db"))).toBe(true);
  });

  it("不同 DATA_DIR 之间数据互不可见", async () => {
    const dirA = path.join(scratch, "a");
    const dirB = path.join(scratch, "b");

    process.env.DATA_DIR = dirA;
    const modA = await import("@/lib/db");
    const dbA = await modA.getDb();
    modA.run(dbA, "INSERT INTO services (name) VALUES (?)", ["only-in-a"]);

    vi.resetModules();
    process.env.DATA_DIR = dirB;
    const modB = await import("@/lib/db");
    const dbB = await modB.getDb();
    expect(modB.query(dbB, "SELECT * FROM services WHERE name = ?", ["only-in-a"])).toEqual([]);
  });

  it("启用 WAL 后在数据目录产生 -wal / -shm 边车文件", async () => {
    // WAL 的副产物文件必须落在 DATA_DIR 内(而非散到别处),
    // 这样 .gitignore / .dockerignore 的 data/ 规则与容器命名卷才能一并覆盖。
    process.env.DATA_DIR = scratch;
    const mod = await import("@/lib/db");
    const db = await mod.getDb();
    mod.run(db, "INSERT INTO services (name) VALUES (?)", ["wal-probe"]);

    expect(mod.getDbPath()).toBe(path.join(scratch, "deploy.db"));
    const files = fs.readdirSync(scratch).sort();
    expect(files).toContain("deploy.db");
    expect(files).toContain("deploy.db-wal");
    expect(files).toContain("deploy.db-shm");
    // 不应有任何文件逃到 DATA_DIR 之外
    expect(files.every((f) => f.startsWith("deploy.db"))).toBe(true);
  });

  it("重启后 journal_mode 仍为 WAL(设置写在文件头,持久生效)", async () => {
    process.env.DATA_DIR = scratch;
    const first = await import("@/lib/db");
    const db1 = await first.getDb();
    expect(db1.pragma("journal_mode", { simple: true })).toBe("wal");
    first.run(db1, "INSERT INTO services (name) VALUES (?)", ["persist-wal"]);

    vi.resetModules();
    const second = await import("@/lib/db");
    const db2 = await second.getDb();
    expect(db2.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(
      second.query(db2, "SELECT name FROM services WHERE name = ?", ["persist-wal"])
    ).toHaveLength(1);
  });

  it("能打开由 sql.js 时代写下的库文件(journal_mode=delete)并原地转为 WAL", async () => {
    // 数据兼容性回归:旧库是标准 SQLite 文件,只是日志模式不同。
    // 用一个非 WAL 的库文件模拟历史产物,确认新驱动读得出数据、且能就地切到 WAL。
    process.env.DATA_DIR = scratch;
    const dbFile = path.join(scratch, "deploy.db");
    const { default: Database } = await import("better-sqlite3");
    const legacy = new Database(dbFile);
    expect(legacy.pragma("journal_mode", { simple: true })).toBe("delete");
    legacy.exec(`CREATE TABLE services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      owner TEXT DEFAULT '',
      created_at TEXT DEFAULT NULL)`);
    legacy
      .prepare("INSERT INTO services (name, created_at) VALUES (?, ?)")
      .run(["legacy-row", "2026-07-01 10:00:00"]);
    legacy.close();

    const mod = await import("@/lib/db");
    const db = await mod.getDb();
    // 旧数据读得出来
    const rows = mod.query<{ name: string; created_at: string }>(
      db,
      "SELECT * FROM services WHERE name = ?",
      ["legacy-row"]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].created_at).toBe("2026-07-01 10:00:00");
    // 已就地升级为 WAL
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    // 且缺失的 deployments 表被补建(CREATE TABLE IF NOT EXISTS)
    expect(mod.query(db, "SELECT * FROM deployments")).toEqual([]);
    // 新写入接在旧数据之后
    const info = mod.runInfo(db, "INSERT INTO services (name) VALUES (?)", ["new-row"]);
    expect(Number(info.lastInsertRowid)).toBe(2);
  });
});
