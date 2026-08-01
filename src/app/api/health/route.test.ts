import { beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "@/lib/db";
import { GET } from "@/app/api/health/route";
import { resetDb, TIMESTAMP_RE } from "@/test/helpers";

/**
 * 把 @/lib/db 换成「默认转发到真实实现」的可 spy 版本:
 * 正常路径仍然打真实的 sql.js 数据库(和其他测试一致),
 * 只有需要制造故障的用例才临时把 getDb 改成 reject。
 * 直接 vi.spyOn(db, "getDb") 对 ESM 命名空间无效,必须走 vi.mock。
 */
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: vi.fn(actual.getDb) };
});

beforeEach(async () => {
  await resetDb();
  // resetDb() 自己也走 getDb,必须在它之后清计数,否则调用次数断言会多算一次
  vi.mocked(db.getDb).mockClear();
});

describe("GET /api/health", () => {
  it("数据库正常时返回 200 + status ok", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: "ok",
      checks: { database: "ok" },
    });
  });

  it("响应结构只含 status / timestamp / checks 三个字段", async () => {
    const body = await (await GET()).json();
    expect(Object.keys(body).sort()).toEqual(["checks", "status", "timestamp"]);
    expect(Object.keys(body.checks)).toEqual(["database"]);
  });

  it("timestamp 是 YYYY-MM-DD HH:MM:SS 格式", async () => {
    const body = await (await GET()).json();
    expect(body.timestamp).toMatch(TIMESTAMP_RE);
  });

  it("库里没有任何业务数据时依然健康(探针不依赖业务表内容)", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("确实调用了 getDb(不是写死的常量响应)", async () => {
    await GET();
    expect(vi.mocked(db.getDb)).toHaveBeenCalledTimes(1);
  });

  it("getDb 抛错时返回 503 + status error", async () => {
    vi.mocked(db.getDb).mockRejectedValueOnce(new Error("db init failed"));
    const res = await GET();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      status: "error",
      checks: { database: "error" },
    });
  });

  it("503 响应仍带合法 timestamp", async () => {
    vi.mocked(db.getDb).mockRejectedValueOnce(new Error("db init failed"));
    const body = await (await GET()).json();
    expect(body.timestamp).toMatch(TIMESTAMP_RE);
  });

  it("探针查询失败(表结构损坏/连接不可用)也判定为 error", async () => {
    // getDb 成功但语句执行失败:返回一个 prepare 就抛错的假数据库
    vi.mocked(db.getDb).mockResolvedValueOnce({
      prepare: () => {
        throw new Error("database disk image is malformed");
      },
    } as unknown as Awaited<ReturnType<typeof db.getDb>>);
    const res = await GET();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      status: "error",
      checks: { database: "error" },
    });
  });

  it("故障是瞬时的:下一次请求恢复 200", async () => {
    vi.mocked(db.getDb).mockRejectedValueOnce(new Error("transient"));
    expect((await GET()).status).toBe(503);
    expect((await GET()).status).toBe(200);
  });

  it("健康检查不产生任何写入(不污染业务数据)", async () => {
    await GET();
    const real = await db.getDb();
    expect(db.query(real, "SELECT COUNT(*) AS c FROM services")[0].c).toBe(0);
    expect(db.query(real, "SELECT COUNT(*) AS c FROM deployments")[0].c).toBe(0);
  });

  it("路由导出 force-dynamic,避免被静态化成缓存快照", async () => {
    const mod = await import("@/app/api/health/route");
    expect(mod.dynamic).toBe("force-dynamic");
  });
});
