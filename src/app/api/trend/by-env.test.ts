import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/trend/route";
import {
  plainRequest,
  resetDb,
  seedDeployment,
  seedService,
} from "@/test/helpers";

/**
 * 端点契约(by_env 维度):
 *   GET /api/trend?days=N        N: 1-30,缺省 7
 *   200:  { days, granularity: "hour"|"day",
 *           points: [{ ts:"YYYY-MM-DD HH:00:00" | "YYYY-MM-DD 00:00:00",
 *                       test:    { total: number, failed: number },
 *                       staging: { total: number, failed: number },
 *                       prod:    { total: number, failed: number } }] }
 *
 * 注意:本文件只覆盖「by_env 形状 + 跨 env / 跨 status 分桶」,与既有
 *       src/app/api/trend/route.test.ts(单 bucket count)并列,不互相污染。
 */

const URL_BASE = "http://localhost:3000/api/trend";

beforeEach(async () => {
  await resetDb();
});

function urlWithDays(days: string | number | undefined): string {
  if (days === undefined) return URL_BASE;
  return `${URL_BASE}?days=${encodeURIComponent(String(days))}`;
}

async function getTrend(
  days: string | number | undefined,
  expectedStatus: 200 | 400
): Promise<unknown> {
  const res = await GET(plainRequest("GET", urlWithDays(days)));
  expect(res.status, `status for days=${String(days)}`).toBe(expectedStatus);
  return res.json();
}

type EnvBucket = { total: number; failed: number };
type EnvPoint = {
  ts: string;
  test: EnvBucket;
  staging: EnvBucket;
  prod: EnvBucket;
};

async function readTrendByEnv(days: string | number | undefined): Promise<{
  days: number;
  granularity: "hour" | "day";
  points: EnvPoint[];
}> {
  return (await getTrend(days, 200)) as {
    days: number;
    granularity: "hour" | "day";
    points: EnvPoint[];
  };
}

/** 断言 point 是空桶:{total:0, failed:0} 三个 env 都不变。 */
function expectEmpty(point: EnvPoint): void {
  expect(point.test).toEqual({ total: 0, failed: 0 });
  expect(point.staging).toEqual({ total: 0, failed: 0 });
  expect(point.prod).toEqual({ total: 0, failed: 0 });
}

/** 倒推 N 天,返回 YYYY-MM-DD(UTC 语义下锚点倒推,补齐日期分量)。 */
function backDay(anchor: string, daysBack: number): string {
  const [y, m, d] = anchor.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - daysBack);
  return dt.toISOString().slice(0, 10);
}

describe("GET /api/trend by_env 响应形状", () => {
  it("days=7 day 模式:points.length=7,每个点都有 test/staging/prod 三个 key", async () => {
    const body = await readTrendByEnv(7);
    expect(body.days).toBe(7);
    expect(body.granularity).toBe("day");
    expect(body.points).toHaveLength(7);
    for (const p of body.points) {
      expect(p).toHaveProperty("test");
      expect(p).toHaveProperty("staging");
      expect(p).toHaveProperty("prod");
      expect(p).toMatchObject({
        ts: expect.any(String),
        test: { total: expect.any(Number), failed: expect.any(Number) },
        staging: { total: expect.any(Number), failed: expect.any(Number) },
        prod: { total: expect.any(Number), failed: expect.any(Number) },
      });
    }
  });

  it("days=1 hour 模式:24 点,每个点都有 3 个 env key", async () => {
    const body = await readTrendByEnv(1);
    expect(body.days).toBe(1);
    expect(body.granularity).toBe("hour");
    expect(body.points).toHaveLength(24);
    for (const p of body.points) {
      expect(p.ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:00:00$/);
      expect(Object.keys(p).sort()).toEqual(["prod", "staging", "test", "ts"]);
    }
  });
});

describe("GET /api/trend by_env 空库行为", () => {
  it("空库时所有点各 env 都是 {total:0, failed:0}", async () => {
    const bodyDay = await readTrendByEnv(7);
    expect(bodyDay.points).toHaveLength(7);
    for (const p of bodyDay.points) expectEmpty(p);

    const bodyHour = await readTrendByEnv(2);
    expect(bodyHour.points).toHaveLength(48);
    for (const p of bodyHour.points) expectEmpty(p);
  });
});

describe("GET /api/trend by_env 数据归集", () => {
  it("造 N 条 prod failed(今天日期),对应点 prod.failed=N,test/staging 不变", async () => {
    const body = await readTrendByEnv(7); // day,7
    const anchorDay = body.points[body.points.length - 1].ts.slice(0, 10);
    const N = 4;

    const id = await seedService({ name: "trend-by-env-prod-failed" });
    for (let i = 0; i < N; i++) {
      await seedDeployment(id, {
        environment: "prod",
        status: "failed",
        started_at: `${anchorDay} ${String(10 + i).padStart(2, "0")}:00:00`,
      });
    }

    const body2 = await readTrendByEnv(7);
    const last = body2.points[body2.points.length - 1];
    expect(last.ts).toBe(`${anchorDay} 00:00:00`);
    expect(last.prod).toEqual({ total: N, failed: N });
    expect(last.test).toEqual({ total: 0, failed: 0 });
    expect(last.staging).toEqual({ total: 0, failed: 0 });
  });

  it("跨 env 同日造:prod+staging+test 各 1 条,当天点三个 env total=1", async () => {
    const body = await readTrendByEnv(7);
    const anchorDay = body.points[body.points.length - 1].ts.slice(0, 10);

    const id = await seedService({ name: "trend-by-env-cross" });
    await seedDeployment(id, { environment: "test", status: "success", started_at: `${anchorDay} 08:00:00` });
    await seedDeployment(id, { environment: "staging", status: "success", started_at: `${anchorDay} 09:00:00` });
    await seedDeployment(id, { environment: "prod", status: "success", started_at: `${anchorDay} 10:00:00` });

    const body2 = await readTrendByEnv(7);
    const last = body2.points[body2.points.length - 1];
    expect(last.ts).toBe(`${anchorDay} 00:00:00`);
    expect(last.test.total).toBe(1);
    expect(last.staging.total).toBe(1);
    expect(last.prod.total).toBe(1);
    // 全 success,三个 env 的 failed 都是 0
    expect(last.test.failed).toBe(0);
    expect(last.staging.failed).toBe(0);
    expect(last.prod.failed).toBe(0);
  });

  it("status 区分:同 env 同日造 1 success + 1 failed,断言 total=2, failed=1", async () => {
    const body = await readTrendByEnv(7);
    const anchorDay = body.points[body.points.length - 1].ts.slice(0, 10);

    const id = await seedService({ name: "trend-by-env-status" });
    await seedDeployment(id, { environment: "prod", status: "success", started_at: `${anchorDay} 11:00:00` });
    await seedDeployment(id, { environment: "prod", status: "failed", started_at: `${anchorDay} 12:00:00` });

    const body2 = await readTrendByEnv(7);
    const last = body2.points[body2.points.length - 1];
    expect(last.ts).toBe(`${anchorDay} 00:00:00`);
    expect(last.prod).toEqual({ total: 2, failed: 1 });
    // 其他 env 不受影响
    expect(last.test).toEqual({ total: 0, failed: 0 });
    expect(last.staging).toEqual({ total: 0, failed: 0 });
  });

  it("hour 模式同 env(test)同一小时造 5 条,该小时点 test.total=5, test.failed=0", async () => {
    const body = await readTrendByEnv(1); // hour,24
    const anchorHour = body.points[0].ts.slice(0, 13);

    const id = await seedService({ name: "trend-by-env-same-hour" });
    // 同一小时 5 个不同分钟,全 success
    for (const mm of ["01", "05", "17", "33", "59"]) {
      await seedDeployment(id, {
        environment: "test",
        status: "success",
        started_at: `${anchorHour}:${mm}:00`,
      });
    }

    const body2 = await readTrendByEnv(1);
    const targetTs = `${anchorHour}:00:00`;
    const idx = body2.points.findIndex((p) => p.ts === targetTs);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(body2.points[idx].test).toEqual({ total: 5, failed: 0 });
    // 该点其他 env 仍是空
    expect(body2.points[idx].staging).toEqual({ total: 0, failed: 0 });
    expect(body2.points[idx].prod).toEqual({ total: 0, failed: 0 });

    // 其他 23 个小时全空
    for (let i = 0; i < body2.points.length; i++) {
      if (i === idx) continue;
      expectEmpty(body2.points[i]);
    }
  });

  it("0 数据时间段占位:跨 env 跨日期分散造数,未造数的其他点仍各 env={0,0}", async () => {
    const body = await readTrendByEnv(7); // day,7
    const anchorDay = body.points[body.points.length - 1].ts.slice(0, 10);

    const id = await seedService({ name: "trend-by-env-sparse" });
    // 锚点日 + 倒推 3 天 + 倒推 6 天各造一条 prod failed
    await seedDeployment(id, { environment: "prod", status: "failed", started_at: `${anchorDay} 10:00:00` });
    await seedDeployment(id, { environment: "prod", status: "failed", started_at: `${backDay(anchorDay, 3)} 10:00:00` });
    await seedDeployment(id, { environment: "prod", status: "failed", started_at: `${backDay(anchorDay, 6)} 10:00:00` });

    const body2 = await readTrendByEnv(7);
    const byTs = new Map(body2.points.map((p) => [p.ts, p]));
    // 有数据的三个点 prod={1,1},其他 env 不变
    expect(byTs.get(`${anchorDay} 00:00:00`)!.prod).toEqual({ total: 1, failed: 1 });
    expect(byTs.get(`${backDay(anchorDay, 3)} 00:00:00`)!.prod).toEqual({ total: 1, failed: 1 });
    expect(byTs.get(`${backDay(anchorDay, 6)} 00:00:00`)!.prod).toEqual({ total: 1, failed: 1 });

    // 未造数的其他点全部空桶
    for (const p of body2.points) {
      if (
        p.ts === `${anchorDay} 00:00:00` ||
        p.ts === `${backDay(anchorDay, 3)} 00:00:00` ||
        p.ts === `${backDay(anchorDay, 6)} 00:00:00`
      ) {
        continue;
      }
      expectEmpty(p);
    }
  });
});
