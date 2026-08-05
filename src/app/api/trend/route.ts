import { NextRequest, NextResponse } from "next/server";
import { getDb, query } from "@/lib/db";

/**
 * 部署趋势:近 N 天的部署计数,按 hour 或 day 聚合。
 *
 * 必须每次实时执行 —— 部署计数随时间变化,该路由没有静态化价值。
 * 同 /api/timeline 与 /api/health 的处理。
 */
export const dynamic = "force-dynamic";

/** 窗口上下界:1-30,缺省 7。非法值(含小数/负数/越界)→ 400 */
const DEFAULT_DAYS = 7;
const MIN_DAYS = 1;
const MAX_DAYS = 30;

/** 3 天以内保留小时细节,超过则降级到日,避免点过密看不清趋势 */
const HOUR_GRANULARITY_CUTOFF = 3;

/** env 在 SQL 端不参与 GROUP BY,JS 端按硬编码 3 种展开。
 * 不用 SELECT DISTINCT environment —— 空集时仍要保证三个 key 都出现,
 * 前端就不必再兜 null/undefined。
 *
 * 与 timeline 一致 —— 后者每个 env 多 success/pending 两个数字,
 * 本路由 total+failed 两个,与 /api/stats 的 by_env 区分开。
 */
const ENVS = ["test", "staging", "prod"] as const;
type Env = (typeof ENVS)[number];

/** 每个 (env) 桶的形状:总数 + 失败数。
 * 与 /api/stats 的 by_env 区分开(stats 还带 success/pending)。*/
type EnvBucket = { total: number; failed: number };

type PointShape = {
  ts: string;
  test: EnvBucket;
  staging: EnvBucket;
  prod: EnvBucket;
};

type RawEnvRow = {
  bucket: string; // substr(started_at, 1, trimLength) → 本地日历日/小时
  environment: string;
  total: number;
  failed: number;
};

/**
 * 时区策略与 /api/timeline 完全一致:
 *   写入路径 src/lib/db.ts nowLocal() 已经把 started_at 写成本地时间
 *   字符串 YYYY-MM-DD HH:MM:SS,字面前缀就是写入者本地日历/小时,
 *   不依赖 SQLite 的 UTC/localtime 解释,跨编译与跨时区都稳定。
 *
 * 与 timeline 唯一差异:聚合键从字符 1-10(YYYY-MM-DD)改为 1-13(YYYY-MM-DD HH),
 * GROUP BY/having 同样用字符串字典序,闭区间过滤。
 */
function parseDays(raw: string | null): number | "invalid" {
  if (raw === null || raw === "") return DEFAULT_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_DAYS || n > MAX_DAYS) return "invalid";
  return n;
}

/**
 * 以「现在」的本地分量构造锚点时间,所有步进只动分量,不动 epoch——
 * 与 SQL 端的 substr 路线一致,不踩 SQLite 时区陷阱。
 *
 * 返回的 anchor 是一对 { day, hour } 字符串前缀:
 *   day  = YYYY-MM-DD
 *   hour = YYYY-MM-DD HH(整点)
 */
function anchorNow(): { day: string; hour: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const day =
    now.getFullYear() +
    "-" + pad(now.getMonth() + 1) +
    "-" + pad(now.getDate());
  const hour = day + " " + pad(now.getHours());
  return { day, hour };
}

/**
 * 给定本地日历日 dayKey = YYYY-MM-DD 与 hour offset,返回对应的 hourKey。
 *
 * 注意:小时分量的偏移只能跨日时变更日期部分 —— 用 baseMs + offset*3600*1000
 * 走 Date 的本地分量再 pad,与 timeline buildDayKey 同套路。
 *
 * 兼容性:输入若含小时段(如 "YYYY-MM-DD HH",hour 模式每次步进时再调用本函数),
 * split("-") 会因为 HH 段也含空格被错切。这里只信任前 10 个字符。
 */
function shiftHour(dayKey: string, hourOffset: number): string {
  const dayOnly = dayKey.slice(0, 10); // YYYY-MM-DD
  const [y, m, d] = dayOnly.split("-").map(Number);
  const baseMs = new Date(y, m - 1, d).getTime();
  const targetMs = baseMs + hourOffset * 3600 * 1000;
  const dt = new Date(targetMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    dt.getFullYear() +
    "-" + pad(dt.getMonth() + 1) +
    "-" + pad(dt.getDate()) +
    " " + pad(dt.getHours())
  );
}

/** 给定本地日历日 dayKey + day offset,返回 dayKey。 */
function shiftDay(dayKey: string, dayOffset: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const targetMs = new Date(y, m - 1, d).getTime() + dayOffset * 86400 * 1000;
  const dt = new Date(targetMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    dt.getFullYear() +
    "-" + pad(dt.getMonth() + 1) +
    "-" + pad(dt.getDate())
  );
}

/** 空 bucket(env 全 0);空库时也要保证 3 个 env key 都存在。 */
function emptyBuckets(): { test: EnvBucket; staging: EnvBucket; prod: EnvBucket } {
  const e = (): EnvBucket => ({ total: 0, failed: 0 });
  return { test: e(), staging: e(), prod: e() };
}

/**
 * by_env 维度的聚合 SQL:按 (bucket, environment) 折叠,每个 group 输出
 * total(全部状态)+ failed(仅失败)两个数字。
 *
 * 4 个 `?` 都填同一个 trimLength(13=hour 模式,10=day 模式),SQLite 会按字面值
 * 4 次绑定 —— 走参数化避免字符串拼接。
 *
 * 不在原 count SQL 上叠积 —— 原查询保留为 AGGREGATE_SQL_COUNT,新查询独立,
 * 可读性优先。
 */
const AGGREGATE_SQL_BY_ENV = `
  SELECT substr(started_at, 1, ?) AS bucket,
         environment,
         COUNT(*)                                       AS total,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM deployments
   WHERE started_at IS NOT NULL
     AND substr(started_at, 1, ?) >= ?
     AND substr(started_at, 1, ?) <= ?
   GROUP BY substr(started_at, 1, ?), environment
` as const;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const days = parseDays(searchParams.get("days"));
  if (days === "invalid") {
    return NextResponse.json(
      { error: "days 必须是 1-30 之间的整数" },
      { status: 400 }
    );
  }

  const granularity: "hour" | "day" =
    days <= HOUR_GRANULARITY_CUTOFF ? "hour" : "day";

  const db = await getDb();
  const { day: today } = anchorNow();

  if (granularity === "hour") {
    // 窗口本地小时 [today - (N-1) days @ 00:00, today 23:00],闭区间长度 = days*24
    // 不要用 currentHour: WHERE 拿到当前小时之后就停了,但前端 points 铺满今天 24 小时,
    // 当前小时以后的点永远 count=0 —— 而夜间发布(22:00 以后)是常见场景。
    const windowStart = shiftHour(today, -(days - 1) * 24);
    const windowEnd = `${today} 23`;

    const rows = query<RawEnvRow>(
      db,
      AGGREGATE_SQL_BY_ENV,
      // SQL 中 `?` 顺序:SELECT/2×WHERE/GROUP BY 处都用 trimLength,中间两个是窗口端点
      [13, 13, windowStart, 13, windowEnd, 13]
    );

    // 按 bucket 聚合到 { test, staging, prod } 三桶
    const agg = new Map<string, { test: EnvBucket; staging: EnvBucket; prod: EnvBucket }>();
    for (const r of rows) {
      let bucket = agg.get(r.bucket);
      if (!bucket) {
        bucket = emptyBuckets();
        agg.set(r.bucket, bucket);
      }
      const env = (ENVS as readonly string[]).includes(r.environment)
        ? (r.environment as Env)
        : null;
      if (!env) continue; // 防御:枚举外的脏数据
      bucket[env].total = r.total;
      bucket[env].failed = r.failed;
    }

    // 0 数据时间段按已知窗口以 1h 步长补全 —— 前端画 3 条线需要固定 N 个点
    const totalPoints = days * 24;
    const points: PointShape[] = [];
    for (let i = 0; i < totalPoints; i++) {
      // 起点是 windowStart(=windowEnd - totalPoints + 1 hour)
      const ts = shiftHour(windowStart, i);
      const b = agg.get(ts) ?? emptyBuckets();
      points.push({
        ts: `${ts}:00:00`,
        test: { ...b.test },
        staging: { ...b.staging },
        prod: { ...b.prod },
      });
    }
    return NextResponse.json({ days, granularity, points });
  }

  // granularity === "day"
  const windowStart = shiftDay(today, -(days - 1));
  const windowEnd = today;

  const rows = query<RawEnvRow>(
    db,
    AGGREGATE_SQL_BY_ENV,
    [10, 10, windowStart, 10, windowEnd, 10]
  );

  const agg = new Map<string, { test: EnvBucket; staging: EnvBucket; prod: EnvBucket }>();
  for (const r of rows) {
    let bucket = agg.get(r.bucket);
    if (!bucket) {
      bucket = emptyBuckets();
      agg.set(r.bucket, bucket);
    }
    const env = (ENVS as readonly string[]).includes(r.environment)
      ? (r.environment as Env)
      : null;
    if (!env) continue;
    bucket[env].total = r.total;
    bucket[env].failed = r.failed;
  }

  // 0 数据时间段按已知窗口以 1d 步长补全
  const points: PointShape[] = [];
  for (let i = 0; i < days; i++) {
    const ts = shiftDay(windowStart, i);
    const b = agg.get(ts) ?? emptyBuckets();
    points.push({
      ts: `${ts} 00:00:00`,
      test: { ...b.test },
      staging: { ...b.staging },
      prod: { ...b.prod },
    });
  }
  return NextResponse.json({ days, granularity, points });
}