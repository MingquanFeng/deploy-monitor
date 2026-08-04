import { beforeEach, describe, expect, it } from "vitest";
import { getDb, run } from "@/lib/db";
import { GET } from "@/app/api/stats/route";
import { resetDb, seedDeployment, seedService } from "@/test/helpers";

beforeEach(async () => {
  await resetDb();
});

/**
 * GET /api/stats 不接收参数 —— 与现有 route.test.ts 一致,
 * 无需构造 NextRequest,直接 await GET() 即可。
 */
async function readStats() {
  const res = await GET();
  expect(res.status).toBe(200);
  return res.json();
}

/**
 * 补一条带 finished_at 的终态记录。seedDeployment 不收 finished_at,
 * 用 UPDATE 直接落 —— 同 overall 套件的 seedFinished 口径。
 */
async function seedFinished(
  serviceId: number,
  environment: "test" | "staging" | "prod",
  status: "success" | "failed",
  startedAt: string,
  finishedAt: string
): Promise<number> {
  const id = await seedDeployment(serviceId, { environment, status, started_at: startedAt });
  const db = await getDb();
  run(db, "UPDATE deployments SET finished_at = ? WHERE id = ?", [finishedAt, id]);
  return id;
}

/**
 * 给某个环境批量造记录,只关心状态计数。
 * environment 默认 prod(沿用 seedDeployment 的默认),各测试按需覆盖。
 */
async function seedStatuses(
  serviceName: string,
  environment: "test" | "staging" | "prod",
  statuses: ("success" | "failed" | "pending")[]
): Promise<number> {
  const serviceId = await seedService({ name: serviceName });
  for (const status of statuses) {
    await seedDeployment(serviceId, { environment, status });
  }
  return serviceId;
}

describe("GET /api/stats by_env", () => {
  it("by_env 始终包含 test / staging / prod 三个 key,即使空库", async () => {
    const body = await readStats();
    expect(body.by_env).toBeDefined();
    expect(Object.keys(body.by_env).sort()).toEqual(["prod", "staging", "test"]);
  });

  it("空库下每个 env 全 0,不返回 undefined / null", async () => {
    const body = await readStats();
    for (const env of ["test", "staging", "prod"] as const) {
      const bucket = body.by_env[env];
      expect(bucket, env).toBeDefined();
      expect(bucket, env).toEqual({
        total: 0,
        success: 0,
        failed: 0,
        pending: 0,
        success_rate: 0,
        mttr_sec: 0,
      });
      for (const [k, v] of Object.entries(bucket)) {
        expect(v, `${env}.${k}`).not.toBeNull();
      }
    }
  });

  it("单条 prod failed 只动 by_env.prod,其他两个 env 不变", async () => {
    await seedStatuses("by-env-prod-only", "prod", ["failed"]);

    const body = await readStats();
    expect(body.by_env.prod.failed).toBe(1);
    expect(body.by_env.prod.total).toBe(1);
    expect(body.by_env.test.failed).toBe(0);
    expect(body.by_env.test.total).toBe(0);
    expect(body.by_env.staging.failed).toBe(0);
    expect(body.by_env.staging.total).toBe(0);
  });

  it("各 env 成功率独立计算 —— prod 全 failed 不污染 test 的 100% success_rate", async () => {
    await seedStatuses("by-env-rate-prod", "prod", ["failed", "failed", "failed"]);
    await seedStatuses("by-env-rate-test", "test", ["success", "success"]);

    const body = await readStats();
    expect(body.by_env.prod.success_rate).toBe(0);
    expect(body.by_env.prod.failed).toBe(3);
    expect(body.by_env.test.success_rate).toBe(1);
    expect(body.by_env.test.success).toBe(2);
    // staging 没造数据,保持 0
    expect(body.by_env.staging.success_rate).toBe(0);
    expect(body.by_env.staging.total).toBe(0);
  });

  it("by_env 每个桶都包含 6 个字段(total/success/failed/pending/success_rate/mttr_sec),且不包含 avg_duration_sec", async () => {
    await seedService({ name: "by-env-shape" });
    await seedFinished(1, "test", "failed", "2026-08-03 14:00:00", "2026-08-03 14:01:00");
    await seedFinished(1, "staging", "success", "2026-08-03 14:00:00", "2026-08-03 14:02:00");

    const body = await readStats();
    for (const env of ["test", "staging", "prod"] as const) {
      const bucket = body.by_env[env];
      // toMatchObject 是部分匹配,这里用来正向断言 6 个字段都在
      expect(bucket, env).toMatchObject({
        total: expect.any(Number),
        success: expect.any(Number),
        failed: expect.any(Number),
        pending: expect.any(Number),
        success_rate: expect.any(Number),
        mttr_sec: expect.any(Number),
      });
      // 严格断言:按 env 桶的契约不该带 avg_duration_sec
      expect(
        Object.prototype.hasOwnProperty.call(bucket, "avg_duration_sec"),
        `${env} 不该带 avg_duration_sec`
      ).toBe(false);
    }
  });

  it("by_env.prod.mttr_sec 在有 failed 时取 failed 时长;没有 failed 时为 0(不 NaN / null)", async () => {
    // 有 failed 的桶:100s 时长
    const id = await seedService({ name: "by-env-mttr" });
    await seedFinished(id, "prod", "failed", "2026-08-03 14:00:00", "2026-08-03 14:01:40");

    let body = await readStats();
    expect(body.by_env.prod.mttr_sec).toBe(100);
    expect(Number.isFinite(body.by_env.prod.mttr_sec)).toBe(true);

    // 清掉 failed,只剩 pending —— mttr_sec 应回落 0,而不是 NaN / null
    await resetDb();
    await seedStatuses("by-env-mttr-empty", "prod", ["pending", "pending"]);

    body = await readStats();
    expect(body.by_env.prod.mttr_sec).toBe(0);
    expect(body.by_env.prod.mttr_sec).not.toBeNull();
    expect(Number.isNaN(body.by_env.prod.mttr_sec)).toBe(false);
  });

  it("by_env.pending 在 env 内计入 total,但不进成功率分母(1 success + 1 failed + 5 pending 仍为 0.5)", async () => {
    await seedStatuses("by-env-pending-rate", "prod", [
      "success",
      "failed",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);

    const body = await readStats();
    expect(body.by_env.prod.pending).toBe(5);
    expect(body.by_env.prod.total).toBe(7); // pending 计入 total
    expect(body.by_env.prod.success + body.by_env.prod.failed + body.by_env.prod.pending).toBe(
      body.by_env.prod.total
    );
    expect(body.by_env.prod.success_rate).toBe(0.5); // 分母只看终态:1/(1+1)
  });

  it("跨环境独立:在 prod 写入记录后改状态,不影响 test / staging 统计", async () => {
    // 三个 env 各造一条,初始全 pending
    await seedStatuses("by-env-iso-prod", "prod", ["pending"]);
    await seedStatuses("by-env-iso-test", "test", ["pending"]);
    await seedStatuses("by-env-iso-staging", "staging", ["pending"]);

    let body = await readStats();
    expect(body.by_env.prod.pending).toBe(1);
    expect(body.by_env.test.pending).toBe(1);
    expect(body.by_env.staging.pending).toBe(1);

    // 把 prod 那条推进到 success —— test/staging 必须保持 pending=1 / success=0
    const db = await getDb();
    run(db, "UPDATE deployments SET status = 'success' WHERE environment = 'prod'", []);

    body = await readStats();
    expect(body.by_env.prod.success).toBe(1);
    expect(body.by_env.prod.pending).toBe(0);
    expect(body.by_env.prod.success_rate).toBe(1);

    // 跨环境隔离:test / staging 没被任何影响
    expect(body.by_env.test.success).toBe(0);
    expect(body.by_env.test.failed).toBe(0);
    expect(body.by_env.test.pending).toBe(1);
    expect(body.by_env.test.total).toBe(1);
    expect(body.by_env.staging.success).toBe(0);
    expect(body.by_env.staging.failed).toBe(0);
    expect(body.by_env.staging.pending).toBe(1);
    expect(body.by_env.staging.total).toBe(1);
  });
});