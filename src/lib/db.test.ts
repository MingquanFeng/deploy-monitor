import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import { getDb, isUniqueViolation, nowLocal, query, run, runInfo } from "@/lib/db";
import { resetDb, TIMESTAMP_RE } from "@/test/helpers";

/**
 * 方案 A:测试自己建 in-memory 数据库,直接测 query()/run() 这两个纯函数
 * (它们接受 db 参数)。生产代码零改动,也完全不碰 data/deploy.db。
 *
 * 这些 :memory: 实例与模块级单例完全隔离,写入不落任何磁盘文件。
 * 涉及单例的用例集中在末尾的 "getDb() 真实单例" 一节,
 * 其路径已被 src/test/setup.ts 重定向到临时目录,所以安全。
 */

const SCHEMA_SERVICES = `
  CREATE TABLE services (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    UNIQUE NOT NULL,
    description TEXT   DEFAULT '',
    owner      TEXT    DEFAULT '',
    created_at TEXT    DEFAULT NULL
  )
`;

const SCHEMA_DEPLOYMENTS = `
  CREATE TABLE deployments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id  INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    environment TEXT    NOT NULL CHECK(environment IN ('test','staging','prod')),
    version     TEXT    NOT NULL DEFAULT '',
    status      TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','success','failed')),
    deployed_by TEXT    DEFAULT '',
    note        TEXT    DEFAULT '',
    started_at  TEXT    DEFAULT NULL,
    finished_at TEXT,
    rollback_from INTEGER REFERENCES deployments(id) ON DELETE SET NULL
  )
`;

/** 建一个干净的、与生产 schema 一致的独立数据库 */
function freshDb(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SERVICES);
  db.exec(SCHEMA_DEPLOYMENTS);
  return db;
}

function readPragmaFk(db: Db): number {
  const rows = query<{ foreign_keys: number }>(db, "PRAGMA foreign_keys");
  return rows[0].foreign_keys;
}

describe("nowLocal()", () => {
  it("返回 YYYY-MM-DD HH:MM:SS 格式", () => {
    expect(nowLocal()).toMatch(TIMESTAMP_RE);
  });

  it("各字段零填充到固定宽度", () => {
    // 用固定时间断言补零行为,避免只在两位数月份的日子才通过
    const iso = nowLocal();
    const [datePart, timePart] = iso.split(" ");
    const [y, m, d] = datePart.split("-");
    const [hh, mm, ss] = timePart.split(":");
    expect(y).toHaveLength(4);
    expect([m, d, hh, mm, ss].map((s) => s.length)).toEqual([2, 2, 2, 2, 2]);
  });

  it("反映本地时间而非 UTC(与 Date 的本地取值一致)", () => {
    const before = new Date();
    const s = nowLocal();
    const after = new Date();
    // 小时字段必须落在调用前后的本地小时之内
    const hour = Number(s.split(" ")[1].split(":")[0]);
    const candidates = new Set([before.getHours(), after.getHours()]);
    expect(candidates.has(hour)).toBe(true);
  });

  it("是可解析的合法时间,且与当前时刻相差在几秒内", () => {
    const parsed = new Date(nowLocal().replace(" ", "T"));
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(Math.abs(Date.now() - parsed.getTime())).toBeLessThan(5000);
  });
});

describe("query()", () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });

  it("空结果返回 []", () => {
    const rows = query(db, "SELECT * FROM services");
    expect(rows).toEqual([]);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("WHERE 无匹配时返回 [] 而不是 undefined", () => {
    run(db, "INSERT INTO services (name) VALUES (?)", ["a"]);
    expect(query(db, "SELECT * FROM services WHERE name = ?", ["nope"])).toEqual([]);
  });

  it("返回行对象数组,列名为 key", () => {
    run(db, "INSERT INTO services (name, description, owner, created_at) VALUES (?, ?, ?, ?)", [
      "svc-a",
      "desc",
      "alice",
      "2026-01-01 00:00:00",
    ]);
    const rows = query(db, "SELECT * FROM services");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 1,
      name: "svc-a",
      description: "desc",
      owner: "alice",
      created_at: "2026-01-01 00:00:00",
    });
  });

  it("多行按 SQL 指定顺序返回", () => {
    for (const n of ["c", "a", "b"]) {
      run(db, "INSERT INTO services (name) VALUES (?)", [n]);
    }
    const names = query<{ name: string }>(
      db,
      "SELECT name FROM services ORDER BY name ASC"
    ).map((r) => r.name);
    expect(names).toEqual(["a", "b", "c"]);
  });

  it("参数绑定生效(不是字符串拼接)", () => {
    run(db, "INSERT INTO services (name) VALUES (?)", ["needle"]);
    run(db, "INSERT INTO services (name) VALUES (?)", ["haystack"]);
    const rows = query<{ name: string }>(db, "SELECT * FROM services WHERE name = ?", [
      "needle",
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("needle");
  });

  it("参数化查询不会被注入攻击穿透", () => {
    run(db, "INSERT INTO services (name) VALUES (?)", ["real"]);
    // 这串东西必须被当成普通字符串字面量,而不是 SQL
    const rows = query(db, "SELECT * FROM services WHERE name = ?", [
      "' OR 1=1 --",
    ]);
    expect(rows).toEqual([]);
    expect(query(db, "SELECT * FROM services")).toHaveLength(1);
  });

  it("不传 params 也能工作", () => {
    run(db, "INSERT INTO services (name) VALUES (?)", ["x"]);
    expect(query(db, "SELECT COUNT(*) AS c FROM services")[0]).toEqual({ c: 1 });
  });
});

describe("run()", () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });

  it("INSERT 之后 query() 能查到", () => {
    run(db, "INSERT INTO services (name, created_at) VALUES (?, ?)", [
      "svc-new",
      "2026-01-01 00:00:00",
    ]);
    const rows = query<{ name: string }>(db, "SELECT * FROM services WHERE name = ?", [
      "svc-new",
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("svc-new");
  });

  it("UPDATE 生效", () => {
    run(db, "INSERT INTO services (name) VALUES (?)", ["old"]);
    run(db, "UPDATE services SET owner = ? WHERE name = ?", ["bob", "old"]);
    expect(query<{ owner: string }>(db, "SELECT owner FROM services")[0].owner).toBe("bob");
  });

  it("DELETE 生效", () => {
    run(db, "INSERT INTO services (name) VALUES (?)", ["gone"]);
    run(db, "DELETE FROM services WHERE name = ?", ["gone"]);
    expect(query(db, "SELECT * FROM services")).toEqual([]);
  });

  it("接受 null 参数(用于 COALESCE 模式)", () => {
    run(db, "INSERT INTO services (name, owner) VALUES (?, ?)", ["n", "keep"]);
    run(db, "UPDATE services SET owner = COALESCE(?, owner) WHERE name = ?", [null, "n"]);
    expect(query<{ owner: string }>(db, "SELECT owner FROM services")[0].owner).toBe("keep");
  });

  it("AUTOINCREMENT 递增分配 id", () => {
    run(db, "INSERT INTO services (name) VALUES (?)", ["one"]);
    run(db, "INSERT INTO services (name) VALUES (?)", ["two"]);
    const ids = query<{ id: number }>(db, "SELECT id FROM services ORDER BY id").map(
      (r) => r.id
    );
    expect(ids).toEqual([1, 2]);
  });
});

describe("UNIQUE 约束", () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });

  it("重复服务名抛错,错误信息含 UNIQUE constraint failed", () => {
    run(db, "INSERT INTO services (name) VALUES (?)", ["dup"]);
    expect(() => run(db, "INSERT INTO services (name) VALUES (?)", ["dup"])).toThrow(
      /UNIQUE constraint failed/
    );
  });

  it("错误信息点明具体列(API 层靠它判 409)", () => {
    run(db, "INSERT INTO services (name) VALUES (?)", ["dup"]);
    expect(() => run(db, "INSERT INTO services (name) VALUES (?)", ["dup"])).toThrow(
      /services\.name/
    );
  });

  it("约束失败后不产生第二行", () => {
    run(db, "INSERT INTO services (name) VALUES (?)", ["dup"]);
    expect(() => run(db, "INSERT INTO services (name) VALUES (?)", ["dup"])).toThrow();
    expect(query(db, "SELECT * FROM services")).toHaveLength(1);
  });

  it("不同名字可以共存", () => {
    run(db, "INSERT INTO services (name) VALUES (?)", ["a"]);
    run(db, "INSERT INTO services (name) VALUES (?)", ["b"]);
    expect(query(db, "SELECT * FROM services")).toHaveLength(2);
  });
});

describe("NOT NULL 约束", () => {
  it("services.name 为 NULL 时抛错", () => {
    const db = freshDb();
    expect(() => run(db, "INSERT INTO services (name) VALUES (?)", [null])).toThrow(
      /NOT NULL constraint failed/
    );
  });

  it("deployments.service_id 为 NULL 时抛错", () => {
    const db = freshDb();
    expect(() =>
      run(db, "INSERT INTO deployments (service_id, environment) VALUES (?, ?)", [
        null,
        "prod",
      ])
    ).toThrow(/NOT NULL constraint failed/);
  });
});

describe("CHECK 约束 - environment", () => {
  let db: Db;
  let serviceId: number;
  beforeEach(() => {
    db = freshDb();
    run(db, "INSERT INTO services (name) VALUES (?)", ["svc"]);
    serviceId = query<{ id: number }>(db, "SELECT id FROM services")[0].id;
  });

  it.each(["test", "staging", "prod"])("接受合法环境 %s", (env) => {
    run(db, "INSERT INTO deployments (service_id, environment) VALUES (?, ?)", [
      serviceId,
      env,
    ]);
    expect(
      query<{ environment: string }>(db, "SELECT environment FROM deployments")[0].environment
    ).toBe(env);
  });

  it.each(["dev", "production", "PROD", "", "staging "])(
    "拒绝非法环境 %j",
    (env) => {
      expect(() =>
        run(db, "INSERT INTO deployments (service_id, environment) VALUES (?, ?)", [
          serviceId,
          env,
        ])
      ).toThrow(/CHECK constraint failed/);
    }
  );

  it("非法环境不落库", () => {
    expect(() =>
      run(db, "INSERT INTO deployments (service_id, environment) VALUES (?, ?)", [
        serviceId,
        "nope",
      ])
    ).toThrow();
    expect(query(db, "SELECT * FROM deployments")).toEqual([]);
  });
});

describe("CHECK 约束 - status", () => {
  let db: Db;
  let serviceId: number;
  beforeEach(() => {
    db = freshDb();
    run(db, "INSERT INTO services (name) VALUES (?)", ["svc"]);
    serviceId = query<{ id: number }>(db, "SELECT id FROM services")[0].id;
  });

  it.each(["pending", "success", "failed"])("接受合法状态 %s", (status) => {
    run(
      db,
      "INSERT INTO deployments (service_id, environment, status) VALUES (?, ?, ?)",
      [serviceId, "prod", status]
    );
    expect(query<{ status: string }>(db, "SELECT status FROM deployments")[0].status).toBe(
      status
    );
  });

  it.each(["running", "ok", "SUCCESS", "cancelled", ""])(
    "拒绝非法状态 %j",
    (status) => {
      expect(() =>
        run(
          db,
          "INSERT INTO deployments (service_id, environment, status) VALUES (?, ?, ?)",
          [serviceId, "prod", status]
        )
      ).toThrow(/CHECK constraint failed/);
    }
  );

  it("status 默认值为 pending", () => {
    run(db, "INSERT INTO deployments (service_id, environment) VALUES (?, ?)", [
      serviceId,
      "prod",
    ]);
    expect(query<{ status: string }>(db, "SELECT status FROM deployments")[0].status).toBe(
      "pending"
    );
  });

  it("UPDATE 到非法状态同样被拒", () => {
    run(db, "INSERT INTO deployments (service_id, environment) VALUES (?, ?)", [
      serviceId,
      "prod",
    ]);
    expect(() =>
      run(db, "UPDATE deployments SET status = ? WHERE id = 1", ["bogus"])
    ).toThrow(/CHECK constraint failed/);
  });
});

describe("外键与级联删除", () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });

  it("PRAGMA foreign_keys 已开启", () => {
    expect(readPragmaFk(db)).toBe(1);
  });

  it("插入指向不存在服务的部署记录被拒", () => {
    expect(() =>
      run(db, "INSERT INTO deployments (service_id, environment) VALUES (?, ?)", [
        99999,
        "prod",
      ])
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("删除服务时级联删除其部署记录", () => {
    run(db, "INSERT INTO services (name) VALUES (?)", ["svc"]);
    const id = query<{ id: number }>(db, "SELECT id FROM services")[0].id;
    for (const env of ["test", "staging", "prod"]) {
      run(db, "INSERT INTO deployments (service_id, environment) VALUES (?, ?)", [id, env]);
    }
    expect(query(db, "SELECT * FROM deployments")).toHaveLength(3);

    run(db, "DELETE FROM services WHERE id = ?", [id]);

    expect(query(db, "SELECT * FROM services")).toEqual([]);
    expect(query(db, "SELECT * FROM deployments")).toEqual([]);
  });

  it("级联只清掉被删服务的记录,不动其他服务", () => {
    run(db, "INSERT INTO services (name) VALUES (?)", ["keep"]);
    run(db, "INSERT INTO services (name) VALUES (?)", ["drop"]);
    const keepId = query<{ id: number }>(db, "SELECT id FROM services WHERE name = ?", [
      "keep",
    ])[0].id;
    const dropId = query<{ id: number }>(db, "SELECT id FROM services WHERE name = ?", [
      "drop",
    ])[0].id;
    run(db, "INSERT INTO deployments (service_id, environment) VALUES (?, ?)", [
      keepId,
      "prod",
    ]);
    run(db, "INSERT INTO deployments (service_id, environment) VALUES (?, ?)", [
      dropId,
      "prod",
    ]);

    run(db, "DELETE FROM services WHERE id = ?", [dropId]);

    const remaining = query<{ service_id: number }>(db, "SELECT service_id FROM deployments");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].service_id).toBe(keepId);
  });

  it("连续多次写入之后外键仍然生效(回归:PRAGMA 曾被写操作重置)", () => {
    // 历史背景:sql.js 时期 run() 每次写入都要 db.export() 全库序列化落盘,
    // 而 export() 会把连接级 PRAGMA foreign_keys 重置为 0 —— 第一次写入之后
    // 外键就永久失效,删服务会留下孤儿部署记录。
    // better-sqlite3 直接写文件、不存在 export 环节,PRAGMA 建连接时设一次即终身有效。
    // 断言的语义不变:写操作不能把外键关掉。
    run(db, "INSERT INTO services (name) VALUES (?)", ["svc"]);
    const id = query<{ id: number }>(db, "SELECT id FROM services")[0].id;
    run(db, "INSERT INTO deployments (service_id, environment) VALUES (?, ?)", [id, "prod"]);

    // 多写几次,确认 PRAGMA 不被写操作侵蚀
    for (let i = 0; i < 5; i++) {
      run(db, "INSERT INTO services (name) VALUES (?)", [`filler-${i}`]);
      expect(readPragmaFk(db)).toBe(1);
    }

    expect(readPragmaFk(db)).toBe(1);
    run(db, "DELETE FROM services WHERE id = ?", [id]);
    expect(query(db, "SELECT * FROM deployments")).toEqual([]);
  });
});

describe("runInfo() / lastInsertRowid", () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });

  it("返回新插入行的真实 id", () => {
    // sql.js 时期 last_insert_rowid() 经 db.exec() 读取恒为 0,
    // 迫使 API 层用 "ORDER BY id DESC LIMIT 1" 反查。这里守住新能力。
    const info = runInfo(db, "INSERT INTO services (name) VALUES (?)", ["a"]);
    expect(Number(info.lastInsertRowid)).toBe(1);
    expect(info.changes).toBe(1);
  });

  it("多次插入时 id 递增且与实际落库行一致", () => {
    const ids = ["a", "b", "c"].map(
      (n) => Number(runInfo(db, "INSERT INTO services (name) VALUES (?)", [n]).lastInsertRowid)
    );
    expect(ids).toEqual([1, 2, 3]);
    const stored = query<{ id: number }>(db, "SELECT id FROM services ORDER BY id").map(
      (r) => r.id
    );
    expect(stored).toEqual(ids);
  });

  it("UPDATE 返回受影响行数", () => {
    run(db, "INSERT INTO services (name) VALUES (?)", ["a"]);
    run(db, "INSERT INTO services (name) VALUES (?)", ["b"]);
    const info = runInfo(db, "UPDATE services SET owner = ?", ["everyone"]);
    expect(info.changes).toBe(2);
  });

  it("插入部署记录时能直接精确回读该行", () => {
    const sid = Number(
      runInfo(db, "INSERT INTO services (name) VALUES (?)", ["svc"]).lastInsertRowid
    );
    const did = Number(
      runInfo(db, "INSERT INTO deployments (service_id, environment, version) VALUES (?, ?, ?)", [
        sid,
        "prod",
        "v9",
      ]).lastInsertRowid
    );
    const row = query<{ id: number; version: string }>(
      db,
      "SELECT * FROM deployments WHERE id = ?",
      [did]
    );
    expect(row).toHaveLength(1);
    expect(row[0].version).toBe("v9");
  });
});

describe("isUniqueViolation()", () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });

  it("识别真实的 UNIQUE 冲突错误", () => {
    run(db, "INSERT INTO services (name) VALUES (?)", ["dup"]);
    let caught: unknown;
    try {
      run(db, "INSERT INTO services (name) VALUES (?)", ["dup"]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(isUniqueViolation(caught)).toBe(true);
  });

  it("UNIQUE 冲突错误带结构化 code(不必再靠文案判断)", () => {
    run(db, "INSERT INTO services (name) VALUES (?)", ["dup"]);
    let caught: unknown;
    try {
      run(db, "INSERT INTO services (name) VALUES (?)", ["dup"]);
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: string }).code).toBe("SQLITE_CONSTRAINT_UNIQUE");
    expect((caught as Error).name).toBe("SqliteError");
  });

  it.each([
    ["NOT NULL", () => run(db, "INSERT INTO services (name) VALUES (?)", [null])],
    ["no such table", () => run(db, "INSERT INTO nope (x) VALUES (?)", [1])],
  ])("不把 %s 错误误判为 UNIQUE 冲突", (_label, fn) => {
    let caught: unknown;
    try {
      fn();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(isUniqueViolation(caught)).toBe(false);
  });

  it("CHECK 与 FOREIGN KEY 错误不算 UNIQUE 冲突", () => {
    const sid = Number(
      runInfo(db, "INSERT INTO services (name) VALUES (?)", ["svc"]).lastInsertRowid
    );
    for (const fn of [
      () => run(db, "INSERT INTO deployments (service_id, environment) VALUES (?, ?)", [sid, "x"]),
      () => run(db, "INSERT INTO deployments (service_id, environment) VALUES (?, ?)", [999, "prod"]),
    ]) {
      let caught: unknown;
      try {
        fn();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      expect(isUniqueViolation(caught)).toBe(false);
    }
  });

  it("错误被序列化丢掉 code 后,仍能靠文案兜底识别", () => {
    // 跨 worker 传递 / 被中间件重新包装的错误会丢掉 code 与原型链,
    // 此时文案是唯一信号 —— 两条判据并存的意义就在这里。
    expect(isUniqueViolation(new Error("UNIQUE constraint failed: services.name"))).toBe(true);
    expect(isUniqueViolation({ message: "UNIQUE constraint failed: services.name" })).toBe(false);
  });

  it("非错误输入不会抛异常", () => {
    for (const v of [null, undefined, 0, "", "boom", {}, []]) {
      expect(isUniqueViolation(v)).toBe(false);
    }
  });
});

describe("getDb() 真实单例", () => {
  it("getDb() 返回已建好表的实例,且多次调用是同一个", async () => {
    const a = await getDb();
    const b = await getDb();
    expect(a).toBe(b);
    // schema 已就绪
    expect(query(a, "SELECT * FROM services")).toBeInstanceOf(Array);
    expect(query(a, "SELECT * FROM deployments")).toBeInstanceOf(Array);
  });

  it("单例数据库开启了外键(写入之后也保持)", async () => {
    const db = await getDb();
    run(db, "INSERT INTO services (name) VALUES (?)", ["fk-probe"]);
    expect(readPragmaFk(db)).toBe(1);
  });

  it("单例数据库启用了 WAL 日志模式", async () => {
    // WAL 是迁移到 better-sqlite3 的核心收益:写入只追加 -wal,
    // 不再像 sql.js 那样每次写入重写整个数据库文件。
    const db = await getDb();
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("经由单例写入的数据可被读回", async () => {
    const db = await getDb();
    db.exec("DELETE FROM deployments");
    db.exec("DELETE FROM services");
    run(db, "INSERT INTO services (name, created_at) VALUES (?, ?)", [
      "singleton-svc",
      nowLocal(),
    ]);
    const rows = query<{ name: string; created_at: string }>(
      db,
      "SELECT * FROM services WHERE name = ?",
      ["singleton-svc"]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].created_at).toMatch(TIMESTAMP_RE);
  });

  it("写入落到临时目录,而非仓库里的 data/deploy.db", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const db = await getDb();
    run(db, "INSERT INTO services (name) VALUES (?)", ["persisted"]);

    // db.ts 优先用 DATA_DIR,setup.ts 已把它指向临时目录
    const dataDir = process.env.DATA_DIR!;
    expect(dataDir).toContain("deploy-monitor-test-");
    expect(fs.existsSync(path.join(dataDir, "deploy.db"))).toBe(true);

    // 铁证:cwd 与 DATA_DIR 都在临时区,不在仓库里
    expect(process.cwd()).toContain("deploy-monitor-test-");
    expect(dataDir).not.toContain("workspace");
  });
});

/**
 * 回滚标记 migration。
 *
 * 这一节刻意打在 getDb() 单例上,不用 freshDb() —— freshDb() 的 schema 是测试文件里
 * 手抄的副本,拿它断言 migration 只能证明「我抄对了」。ALTER TABLE 是否真的跑过、
 * 外键动作是否真的是 SET NULL,只有真实连接说得清。
 */
describe("migration: deployments.rollback_from", () => {
  let db: Db;
  beforeEach(async () => {
    db = await resetDb();
  });

  function seedPair(name: string): { serviceId: number; deploymentId: number } {
    const serviceId = Number(
      runInfo(db, "INSERT INTO services (name) VALUES (?)", [name]).lastInsertRowid
    );
    const deploymentId = Number(
      runInfo(db, "INSERT INTO deployments (service_id, environment) VALUES (?, ?)", [
        serviceId,
        "prod",
      ]).lastInsertRowid
    );
    return { serviceId, deploymentId };
  }

  it("deployments 表存在 rollback_from 列", () => {
    const cols = db.pragma("table_info(deployments)") as { name: string; type: string }[];
    const col = cols.find((c) => c.name === "rollback_from");
    expect(col).toBeDefined();
    expect(col!.type).toBe("INTEGER");
  });

  it("不写该列时默认为 null", () => {
    const { deploymentId } = seedPair("rbcol-default");
    const rows = query<{ rollback_from: number | null }>(
      db,
      "SELECT rollback_from FROM deployments WHERE id = ?",
      [deploymentId]
    );
    expect(rows[0].rollback_from).toBeNull();
  });

  it("可以写入指向同表既有记录的 id", () => {
    const { serviceId, deploymentId } = seedPair("rbcol-selfref");
    const rollbackId = Number(
      runInfo(
        db,
        "INSERT INTO deployments (service_id, environment, rollback_from) VALUES (?, ?, ?)",
        [serviceId, "prod", deploymentId]
      ).lastInsertRowid
    );
    const rows = query<{ rollback_from: number | null }>(
      db,
      "SELECT rollback_from FROM deployments WHERE id = ?",
      [rollbackId]
    );
    expect(rows[0].rollback_from).toBe(deploymentId);
  });

  it("自引用外键生效:指向不存在的 id 抛 FOREIGN KEY 约束错误", () => {
    const { serviceId } = seedPair("rbcol-fk");
    let caught: unknown;
    try {
      run(
        db,
        "INSERT INTO deployments (service_id, environment, rollback_from) VALUES (?, ?, ?)",
        [serviceId, "prod", 99999]
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toMatch(/FOREIGN KEY constraint failed/);
    expect((caught as { code?: string }).code).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
  });

  it("外键失败时不落库", () => {
    const { serviceId } = seedPair("rbcol-fk-nowrite");
    expect(() =>
      run(
        db,
        "INSERT INTO deployments (service_id, environment, rollback_from) VALUES (?, ?, ?)",
        [serviceId, "prod", 99999]
      )
    ).toThrow();
    // 只剩 seedPair 建的那一条
    expect(query(db, "SELECT * FROM deployments")).toHaveLength(1);
  });

  it("ON DELETE SET NULL:删掉被指向的记录后,回滚记录保留、指向置空", () => {
    // 这条是本功能最关键的数据完整性保证。若写成 ON DELETE CASCADE,
    // 删一条旧部署会连带删掉所有回滚它的记录 —— 那是静默的数据丢失。
    const { serviceId, deploymentId } = seedPair("rbcol-setnull");
    const rollbackId = Number(
      runInfo(
        db,
        "INSERT INTO deployments (service_id, environment, version, rollback_from) VALUES (?, ?, ?, ?)",
        [serviceId, "prod", "v1-rollback", deploymentId]
      ).lastInsertRowid
    );

    run(db, "DELETE FROM deployments WHERE id = ?", [deploymentId]);

    const rows = query<{ id: number; version: string; rollback_from: number | null }>(
      db,
      "SELECT id, version, rollback_from FROM deployments WHERE id = ?",
      [rollbackId]
    );
    // 记录还在(没被 CASCADE 带走)
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe("v1-rollback");
    // 指向已置空
    expect(rows[0].rollback_from).toBeNull();
    // 全表也只剩这一条,被删的那条确实没了
    expect(query(db, "SELECT * FROM deployments")).toHaveLength(1);
  });

  it("ON DELETE SET NULL 对多条指向同一记录的回滚全部生效", () => {
    const { serviceId, deploymentId } = seedPair("rbcol-setnull-many");
    for (const v of ["rb-1", "rb-2", "rb-3"]) {
      run(
        db,
        "INSERT INTO deployments (service_id, environment, version, rollback_from) VALUES (?, ?, ?, ?)",
        [serviceId, "prod", v, deploymentId]
      );
    }
    run(db, "DELETE FROM deployments WHERE id = ?", [deploymentId]);

    const rows = query<{ rollback_from: number | null }>(
      db,
      "SELECT rollback_from FROM deployments ORDER BY id"
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.rollback_from === null)).toBe(true);
  });

  it("删服务仍走 CASCADE:回滚链上的记录一并清掉,不因 SET NULL 而留下孤儿", () => {
    // service_id 的 CASCADE 与 rollback_from 的 SET NULL 是两条独立的外键动作,
    // 这里守住前者没被后者影响。
    const { serviceId, deploymentId } = seedPair("rbcol-cascade");
    run(
      db,
      "INSERT INTO deployments (service_id, environment, rollback_from) VALUES (?, ?, ?)",
      [serviceId, "prod", deploymentId]
    );
    expect(query(db, "SELECT * FROM deployments")).toHaveLength(2);

    run(db, "DELETE FROM services WHERE id = ?", [serviceId]);

    expect(query(db, "SELECT * FROM deployments")).toEqual([]);
  });

  it("UPDATE 也受外键约束:改成不存在的 id 被拒", () => {
    const { deploymentId } = seedPair("rbcol-update-fk");
    expect(() =>
      run(db, "UPDATE deployments SET rollback_from = ? WHERE id = ?", [99999, deploymentId])
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("migration 幂等:重复取单例不会重复 ALTER,列仍只有一个", async () => {
    // ALTER TABLE ADD COLUMN 重复执行会抛 "duplicate column name",
    // db.ts 靠先查 table_info 再决定是否执行来保证幂等。
    await getDb();
    await getDb();
    const cols = db.pragma("table_info(deployments)") as { name: string }[];
    expect(cols.filter((c) => c.name === "rollback_from")).toHaveLength(1);
  });
});
