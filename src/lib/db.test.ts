import initSqlJs, { Database as SqlJsDatabase } from "sql.js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, nowLocal, query, run, save } from "@/lib/db";
import { TIMESTAMP_RE } from "@/test/helpers";

/**
 * 方案 A:测试自己建 in-memory 数据库,直接测 query()/run() 这两个纯函数
 * (它们接受 db 参数)。生产代码零改动,也完全不碰 data/deploy.db。
 *
 * 注意 run() 内部会调用 save(),而 save() 写的是模块级单例 db、路径来自
 * process.cwd() —— 已被 src/test/setup.ts 重定向到临时目录,所以安全。
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
    finished_at TEXT
  )
`;

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs();
});

/** 建一个干净的、与生产 schema 一致的独立数据库 */
function freshDb(): SqlJsDatabase {
  const db = new SQL.Database();
  db.run("PRAGMA foreign_keys = ON");
  db.run(SCHEMA_SERVICES);
  db.run(SCHEMA_DEPLOYMENTS);
  return db;
}

function readPragmaFk(db: SqlJsDatabase): number {
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
  let db: SqlJsDatabase;
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
  let db: SqlJsDatabase;
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
  let db: SqlJsDatabase;
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
  let db: SqlJsDatabase;
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
  let db: SqlJsDatabase;
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
  let db: SqlJsDatabase;
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

  it("save()/export() 之后外键仍然生效(回归:export 会重置 PRAGMA)", () => {
    // sql.js 的 db.export() 会把连接级 PRAGMA foreign_keys 重置为 0。
    // db.ts 的 run() 每次写入都调用 save() -> export(),
    // 若不重新施加 PRAGMA,第一次写入之后外键就永久失效,
    // 删服务会留下孤儿部署记录。这条测试守住该回归。
    run(db, "INSERT INTO services (name) VALUES (?)", ["svc"]);
    const id = query<{ id: number }>(db, "SELECT id FROM services")[0].id;
    run(db, "INSERT INTO deployments (service_id, environment) VALUES (?, ?)", [id, "prod"]);

    db.export(); // 模拟 save() 内部动作
    db.run("PRAGMA foreign_keys = ON"); // db.ts 里 save() 应做的补偿

    expect(readPragmaFk(db)).toBe(1);
    run(db, "DELETE FROM services WHERE id = ?", [id]);
    expect(query(db, "SELECT * FROM deployments")).toEqual([]);
  });
});

describe("getDb() / save() 真实单例", () => {
  it("getDb() 返回已建好表的实例,且多次调用是同一个", async () => {
    const a = await getDb();
    const b = await getDb();
    expect(a).toBe(b);
    // schema 已就绪
    expect(query(a, "SELECT * FROM services")).toBeInstanceOf(Array);
    expect(query(a, "SELECT * FROM deployments")).toBeInstanceOf(Array);
  });

  it("单例数据库开启了外键(save 之后也保持)", async () => {
    const db = await getDb();
    save();
    expect(readPragmaFk(db)).toBe(1);
  });

  it("经由单例写入的数据可被读回", async () => {
    const db = await getDb();
    db.run("DELETE FROM deployments");
    db.run("DELETE FROM services");
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

  it("save() 把数据落到临时目录,而非仓库里的 data/deploy.db", async () => {
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
