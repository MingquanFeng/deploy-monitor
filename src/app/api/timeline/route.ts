import { NextRequest, NextResponse } from "next/server";
import { getDb, query } from "@/lib/db";

/**
 * 必须每次实时执行 —— 部署计数随时间变化,该路由没有静态化价值。
 * 同 /api/health 的处理。
 */
export const dynamic = "force-dynamic";

/** 窗口上下界:1-30,缺省 7。非法值(含小数/负数/越界)→ 400 */
const DEFAULT_DAYS = 7;
const MIN_DAYS = 1;
const MAX_DAYS = 30;

/** env 在 SQL 里硬编码为 test/staging/prod,与 CHECK 约束一致。
 * 不用 SELECT DISTINCT environment —— 空集时仍要保证三个 key 都出现,
 * 前端就不必再兜 null/undefined。 */
const ENVS = ["test", "staging", "prod"] as const;
type Env = (typeof ENVS)[number];

type RawRow = {
  d: string; // substr(started_at, 1, 10) → 本地日历日 YYYY-MM-DD
  environment: string;
  status: string;
};

/**
 * 时区陷阱实测(better-sqlite3 3.53.4, Asia/Shanghai):
 *
 * SQLite 对无时区后缀的字符串处理行为分裂,容易踩坑:
 *
 * 1. `strftime('%s', 'YYYY-MM-DD HH:MM:SS')` 把字符串按 **UTC** 解析(官方文档明文)。
 *    实测:'2026-08-04 18:31:53' → epoch 1785868313 = Date.UTC(2026,7,4,18,31,53)。
 *
 * 2. `date('YYYY-MM-DD HH:MM:SS')` / `strftime('%Y-%m-%d', '...')` 在 better-sqlite3 编译下
 *    **实际上返回字符串字面前缀**(YYYY-MM-DD 部分),与官方文档说的「按 UTC」不一致。
 *    实测:date('2026-08-04 18:31:53') = '2026-08-04',date('2026-08-05 03:00:00') = '2026-08-05'。
 *    ——「按本地时区」是个巧合,本质是字符串截断。
 *
 * 我们这里不能依赖 SQLite 的字符串解释 —— 跨编译版本不稳定,跨时区更不可移植。
 *
 * 关键洞察:**写入路径在 src/lib/db.ts 的 nowLocal()**,生成的就是**本地时间字符串**
 * `YYYY-MM-DD HH:MM:SS`,字面前缀 YYYY-MM-DD 就是写入者的本地日历日,
 * 与 SQLite 把它当 UTC 还是 localtime 无关。
 *
 * 所以这里走最直接的路线:
 *   - SQL 端 `substr(started_at, 1, 10)` 拿字面前缀当本地日历日(纯字符串操作,不触发任何日期解析);
 *   - 窗口过滤也用 `substr(...)` 字符串字典序比较 —— `YYYY-MM-DD` 字典序 == 时间顺序。
 *
 * 这个方案:
 *   - 不依赖 SQLite 时区语义(避开 'YYYY-MM-DD HH:MM:SS' 的 UTC 陷阱);
 *   - 不在 JS 端做 epoch 补偿(避开跨日边界 8h 偏移);
 *   - 跨时区可移植(CI 上 TZ=UTC 时本地日期 == UTC 日期,字面前缀仍正确)。
 *
 * 与 stats 路由的 `strftime('%s', ts)` 差值抵消同理 —— 都承认 SQLite 把 naive 字符串
 * 按 UTC 解析这件事,只是 stats 在差值中抵消、本路由直接不碰 epoch,改用字符串前缀。
 */
function parseDays(raw: string | null): number | "invalid" {
  if (raw === null || raw === "") return DEFAULT_DAYS;
  // 必须是 1-30 之间的**整数**,不允许小数、负数、字符串
  // Number("7") = 7, Number("7.5") = 7.5, Number("abc") = NaN, Number("") = 0
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_DAYS || n > MAX_DAYS) return "invalid";
  return n;
}

/**
 * 用请求处理那一刻的本地「今天午夜」为基准,生成 [-N+1, 0] 区间的本地日历日字符串。
 * 直接对日期分量做加减,不碰 epoch —— 与 SQL 端的 `substr` 路线保持一致,完全
 * 不踩 SQLite 时区陷阱。
 */
function buildDayKey(today: Date): (dayOffset: number) => string {
  const baseMs = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  ).getTime();
  return (dayOffset: number) => {
    const ms = baseMs + dayOffset * 86400 * 1000;
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
      d.getFullYear() +
      "-" + pad(d.getMonth() + 1) +
      "-" + pad(d.getDate())
    );
  };
}

/** 构造一个空 bucket(env 全 0) */
function emptyBuckets() {
  const e = (): { total: number; failed: number } => ({ total: 0, failed: 0 });
  return {
    test: e(),
    staging: e(),
    prod: e(),
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const days = parseDays(searchParams.get("days"));
  if (days === "invalid") {
    return NextResponse.json(
      { error: "days 必须是 1-30 之间的整数" },
      { status: 400 }
    );
  }

  const db = await getDb();
  const now = new Date();
  const dayKey = buildDayKey(now);

  // 窗口两端:本地日历日 `[today - (N-1), today]` 闭区间
  // 写成字符串,SQLite 字典序比较 YYYY-MM-DD 与时间顺序一致(ISO 风格)
  const windowStart = dayKey(-(days - 1));
  const windowEnd = dayKey(0);

  // SQL 端:按字符串前缀做窗口过滤 + GROUP BY
  // substr(started_at, 1, 10):取前 10 个字符(YYYY-MM-DD),纯字符串操作,不触发日期解析
  // substr 索引自动可用(列前缀),无需另建索引
  // windowEnd 用闭区间 '<=' 而不是半开,因为字典序下 'YYYY-MM-DD' = 'YYYY-MM-DD' 时就是当天
  const rows = query<RawRow>(
    db,
    `SELECT substr(started_at, 1, 10) AS d,
            environment,
            status
       FROM deployments
      WHERE started_at IS NOT NULL
        AND substr(started_at, 1, 10) >= ?
        AND substr(started_at, 1, 10) <= ?`,
    [windowStart, windowEnd]
  );

  // JS 端:按 (本地日历日, env) 聚合
  const agg = new Map<string, ReturnType<typeof emptyBuckets>>();
  for (const r of rows) {
    let bucket = agg.get(r.d);
    if (!bucket) {
      bucket = emptyBuckets();
      agg.set(r.d, bucket);
    }
    const env = (ENVS as readonly string[]).includes(r.environment)
      ? (r.environment as Env)
      : null;
    if (!env) continue; // 防御:枚举外的脏数据,跟 stats 一样跳过
    bucket[env].total += 1;
    if (r.status === "failed") bucket[env].failed += 1;
  }

  // 补全缺失日期 —— 0 数据的天也要出现 N 个 bucket,前端画图要固定 N 格
  // 顺序:从最早一天到今天
  const buckets: Array<{
    date: string;
    test: { total: number; failed: number };
    staging: { total: number; failed: number };
    prod: { total: number; failed: number };
  }> = [];
  for (let i = -(days - 1); i <= 0; i++) {
    const date = dayKey(i);
    const b = agg.get(date) ?? emptyBuckets();
    buckets.push({ date, test: b.test, staging: b.staging, prod: b.prod });
  }

  return NextResponse.json({ days, buckets });
}