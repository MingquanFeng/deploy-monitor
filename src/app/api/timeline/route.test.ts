import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/timeline/route";
import {
  plainRequest,
  resetDb,
  seedDeployment,
  seedService,
} from "@/test/helpers";

/**
 * 端点契约:
 *   GET /api/timeline?days=N        N: 1-30，缺省 7
 *   400:  days 必须是 1-30 之间的整数
 *   200:  { days: number,
 *           buckets: [{ date:"YYYY-MM-DD",
 *                       test:{total,failed},
 *                       staging:{total,failed},
 *                       prod:{total,failed} }, ...] }
 *   buckets.length === days;每个 bucket 都含三个 env key(空也是 {total:0,failed:0})
 */

const URL_BASE = "http://localhost:3000/api/timeline";

beforeEach(async () => {
  await resetDb();
});

/** 把 days 查询参数挂到 URL 上 */
function urlWithDays(days: string | number | undefined): string {
  if (days === undefined) return URL_BASE;
  return `${URL_BASE}?days=${encodeURIComponent(String(days))}`;
}

/** 触发 GET 并断言状态码,返回解析后的 JSON */
async function getTimeline(
  days: string | number | undefined,
  expectedStatus: 200 | 400
): Promise<unknown> {
  const res = await GET(plainRequest("GET", urlWithDays(days)));
  expect(res.status, `status for days=${String(days)}`).toBe(expectedStatus);
  return res.json();
}

/** 取最后一次成功响应的所有 buckets */
async function readBuckets(days: string | number | undefined) {
  const body = (await getTimeline(days, 200)) as {
    days: number;
    buckets: Array<{
      date: string;
      test: { total: number; failed: number };
      staging: { total: number; failed: number };
      prod: { total: number; failed: number };
    }>;
  };
  return body;
}

describe("GET /api/timeline 输入校验", () => {
  it("缺省 days 视为 7,返回 200 且 days===7", async () => {
    const body = (await getTimeline(undefined, 200)) as { days: number };
    expect(body.days).toBe(7);
  });

  it("days=1 返回 buckets.length=1", async () => {
    const body = await readBuckets(1);
    expect(body.days).toBe(1);
    expect(body.buckets).toHaveLength(1);
  });

  it("days=7 返回 buckets.length=7", async () => {
    const body = await readBuckets(7);
    expect(body.buckets).toHaveLength(7);
  });

  it("days=30 返回 buckets.length=30(上限)", async () => {
    const body = await readBuckets(30);
    expect(body.days).toBe(30);
    expect(body.buckets).toHaveLength(30);
  });

  it("days=0 返回 400", async () => {
    await getTimeline(0, 400);
  });

  it("days=31 返回 400(超过上限)", async () => {
    await getTimeline(31, 400);
  });

  it("days=-1 返回 400", async () => {
    await getTimeline(-1, 400);
  });

  it("days=abc 返回 400", async () => {
    await getTimeline("abc", 400);
  });

  it("days=7.5 返回 400(非整数)", async () => {
    await getTimeline("7.5", 400);
  });

  it("400 响应包含错误描述", async () => {
    const res = await GET(plainRequest("GET", urlWithDays(0)));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
    expect(body.error).toMatch(/1.*30/);
  });
});

describe("GET /api/timeline 响应形状", () => {
  it("基础形状:days + buckets 数组", async () => {
    const body = await readBuckets(7);
    expect(typeof body.days).toBe("number");
    expect(Array.isArray(body.buckets)).toBe(true);
  });

  it("每个 bucket 包含 test/staging/prod 三个 key(空库也是)", async () => {
    const body = await readBuckets(7);
    for (const b of body.buckets) {
      expect(Object.keys(b).sort()).toEqual(["date", "prod", "staging", "test"]);
      expect(b.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("空库时每个 env 都是 {total:0,failed:0}(非 undefined / 非 null)", async () => {
    const body = await readBuckets(7);
    for (const b of body.buckets) {
      for (const env of ["test", "staging", "prod"] as const) {
        const e = b[env];
        expect(e).toEqual({ total: 0, failed: 0 });
        expect(e).not.toBeNull();
      }
    }
  });

  it("0 数据的天也出现在 buckets 里(空集的天仍然占位)", async () => {
    const body = await readBuckets(7);
    expect(body.buckets).toHaveLength(7);
    // 7 天都没有数据,7 天都应该 total=0
    const allEmpty = body.buckets.every(
      (b) =>
        b.test.total === 0 &&
        b.staging.total === 0 &&
        b.prod.total === 0 &&
        b.test.failed === 0 &&
        b.staging.failed === 0 &&
        b.prod.failed === 0
    );
    expect(allEmpty).toBe(true);
  });

  it("buckets.date 严格按时间正序排列(单调递增)", async () => {
    const body = await readBuckets(7);
    for (let i = 1; i < body.buckets.length; i++) {
      expect(body.buckets[i].date > body.buckets[i - 1].date).toBe(true);
    }
  });
});

describe("GET /api/timeline 数据归集", () => {
  /**
   * 时区策略:
   *   SQLite `date(?, '-N days')` 把无时区后缀字符串按 UTC 解析。Node `new Date(s)`
   *   按本地时间解析。两套解读口径天然差一天。
   *
   *   测试不靠「今天是 2026-08-04」之类的硬编码 —— 先发请求,从响应里读出最后一
   *   个 bucket 的 date 作为「终点日」,以此为锚点倒推 N 天前。
   *   实现用 SQLite UTC 还是 SQLite localtime、用 Node 本地还是 UTC,测试都能
   *   与之同步 —— 测试只用响应中的日期字符串作为日期游标,不动时间戳解析。
   *
   *   唯一要求:实现里存在的那一天,在响应里也存在;响应里 N 个日期连续;且最后一
   *   个日期 = 响应发出时点(在实现的时区口径下)的「当天」。
   */

  /** 倒推 N 天,返回 YYYY-MM-DD */
  function backDate(anchor: string, n: number): string {
    const [y, m, d] = anchor.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - n);
    return dt.toISOString().slice(0, 10);
  }

  it("造 N 条 prod failed(终点日),最后 bucket 的 prod.failed===N,其他 env 不变", async () => {
    const body = await readBuckets(7);
    const lastDate = body.buckets[body.buckets.length - 1].date;

    const id = await seedService({ name: "timeline-prod-failed" });
    const N = 3;
    for (let i = 0; i < N; i++) {
      await seedDeployment(id, {
        status: "failed",
        environment: "prod",
        started_at: `${lastDate} 10:00:00`,
      });
    }

    const body2 = await readBuckets(7);
    const last = body2.buckets[body2.buckets.length - 1];
    expect(last.date).toBe(lastDate);
    expect(last.prod).toEqual({ total: N, failed: N });
    // 平行 sanity:同一 bucket 里 test/staging 仍空
    expect(last.test).toEqual({ total: 0, failed: 0 });
    expect(last.staging).toEqual({ total: 0, failed: 0 });
  });

  it("跨日期测试:不同日期各造一条 prod failed,对应 bucket 计数对得上", async () => {
    const body = await readBuckets(7);
    const anchor = body.buckets[body.buckets.length - 1].date;

    // 选终点日的 0/2/5 天前各造一条 prod failed
    const id = await seedService({ name: "timeline-cross-date" });
    const offsets = [0, 2, 5];
    const dates = offsets.map((n) => backDate(anchor, n));
    for (const d of dates) {
      await seedDeployment(id, {
        status: "failed",
        environment: "prod",
        started_at: `${d} 10:00:00`,
      });
    }

    const body2 = await readBuckets(7);
    // 把 buckets 转成 date -> bucket 索引,断言每一天的 prod.failed 等于「那天的造数」
    const byDate = new Map(body2.buckets.map((b, i) => [b.date, i]));
    for (let k = 0; k < offsets.length; k++) {
      const d = dates[k];
      const idx = byDate.get(d);
      expect(idx, `date ${d} should be in buckets`).toBeDefined();
      expect(body2.buckets[idx!].prod).toEqual({ total: 1, failed: 1 });
      // 同一桶里的 test/staging 不变
      expect(body2.buckets[idx!].test).toEqual({ total: 0, failed: 0 });
      expect(body2.buckets[idx!].staging).toEqual({ total: 0, failed: 0 });
    }
    // 没有造数的天仍是 0(取一个不在 dates 里的日期)
    const emptyDate = body2.buckets.find((b) => !dates.includes(b.date))!.date;
    const emptyBucket = body2.buckets[byDate.get(emptyDate)!];
    expect(emptyBucket.prod).toEqual({ total: 0, failed: 0 });
  });

  it("混 env:同一天 prod failed + staging success,totals 各自累加互不影响", async () => {
    const body = await readBuckets(7);
    const anchor = body.buckets[body.buckets.length - 1].date;

    const id = await seedService({ name: "timeline-mixed-env" });
    await seedDeployment(id, {
      status: "failed",
      environment: "prod",
      started_at: `${anchor} 09:00:00`,
    });
    await seedDeployment(id, {
      status: "failed",
      environment: "prod",
      started_at: `${anchor} 10:00:00`,
    });
    await seedDeployment(id, {
      status: "success",
      environment: "staging",
      started_at: `${anchor} 11:00:00`,
    });

    const body2 = await readBuckets(7);
    const last = body2.buckets[body2.buckets.length - 1];
    expect(last.date).toBe(anchor);
    expect(last.prod).toEqual({ total: 2, failed: 2 });
    expect(last.staging).toEqual({ total: 1, failed: 0 });
    expect(last.test).toEqual({ total: 0, failed: 0 });
  });

  it("跨 env 的 success 不计为 failed:3 prod success + 1 prod failed → failed=1", async () => {
    const body = await readBuckets(7);
    const anchor = body.buckets[body.buckets.length - 1].date;

    const id = await seedService({ name: "timeline-success-not-failed" });
    await seedDeployment(id, { status: "success", environment: "prod", started_at: `${anchor} 09:00:00` });
    await seedDeployment(id, { status: "success", environment: "prod", started_at: `${anchor} 10:00:00` });
    await seedDeployment(id, { status: "success", environment: "prod", started_at: `${anchor} 11:00:00` });
    await seedDeployment(id, { status: "failed", environment: "prod", started_at: `${anchor} 12:00:00` });

    const body2 = await readBuckets(7);
    const last = body2.buckets[body2.buckets.length - 1];
    expect(last.prod).toEqual({ total: 4, failed: 1 });
  });

  it("days=1 时只有一个 bucket,内容与 days=7 最后一桶一致", async () => {
    const body7 = await readBuckets(7);
    const anchor = body7.buckets[body7.buckets.length - 1].date;

    const id = await seedService({ name: "timeline-days-1" });
    await seedDeployment(id, {
      status: "failed",
      environment: "test",
      started_at: `${anchor} 10:00:00`,
    });

    const body1 = await readBuckets(1);
    expect(body1.buckets).toHaveLength(1);
    expect(body1.buckets[0].date).toBe(anchor);
    expect(body1.buckets[0].test).toEqual({ total: 1, failed: 1 });
    expect(body1.buckets[0].prod).toEqual({ total: 0, failed: 0 });
  });
});