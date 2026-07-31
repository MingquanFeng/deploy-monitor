import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 单独一个文件来测「从磁盘已有的 .db 文件恢复」这条分支。
 *
 * db.ts 的 DB_PATH 与实例都在模块顶层求值一次,所以要覆盖
 * `if (fs.existsSync(DB_PATH))` 分支,必须先把 DATA_DIR 指向一个已经
 * 存在 deploy.db 的目录,再 vi.resetModules() 重新 import。
 * 放在独立文件里,避免 resetModules 影响其他测试的模块单例。
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
});
