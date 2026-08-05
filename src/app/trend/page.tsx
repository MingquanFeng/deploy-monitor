"use client";

/**
 * 部署频率趋势图（按环境拆分）。
 *
 * 手写 SVG 折线图，不引图表库。理由不是「造轮子有趣」，而是成本核算：
 * recharts/chart.js 打进 bundle 是 100~200KB 级别的量，而这里需要的
 * 全部能力是「六条折线 + 若干圆点 + 五条网格线」——几十行 path 拼接就够。
 * 库带来的响应式容器、动画、图例系统在这个页面一个都用不上。
 *
 * 数据契约：`GET /api/trend?days=N` → { days, granularity, points[] }，
 * 每个 point 含 test/staging/prod 三个 env，每个 env 含 total/failed 两个数。
 * granularity 由后端按 days 决定（<=3 → hour，>3 → day），前端不猜、只读，
 * 因为坐标轴的标注策略要跟着它走。
 *
 * 视觉编码：
 *   实线 = 总部署数；虚线 = 失败数。
 *   三种环境配色与 /timeline、/stats 的 ENV_BADGE 保持一致（test 蓝、staging 紫、prod 红）。
 *   失败线下方加 env 同色半透明填充，把「失败集中区」可视化为色块。
 *
 * 后端并行实现期间可能 404 —— 与 /stats、/timeline 同款兜底：保留上一次的
 * 数据而不是清空，避免图表「消失一帧再画回来」的闪烁。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useChangeStream } from "@/hooks/useChangeStream";
import { affectsAnyDeployment } from "@/lib/changeStream";
import { BUTTON_SECONDARY } from "@/lib/constants";

/** 单个环境的口径：总部署数 + 失败数。 */
interface EnvBucket {
  total: number;
  failed: number;
}

/** 单个数据点。ts 是 "YYYY-MM-DD HH:MM:SS" 的本地时间字符串。 */
interface TrendPoint {
  ts: string;
  test: EnvBucket;
  staging: EnvBucket;
  prod: EnvBucket;
}

/** `GET /api/trend` 响应形状。 */
interface TrendResponse {
  days: number;
  granularity: "hour" | "day";
  points: TrendPoint[];
}

/** 时间窗选项。与 /timeline 的写法一致：标签和值都写明，不用裸数字。 */
const WINDOW_OPTIONS = [
  { days: 1, label: "近 1 天" },
  { days: 3, label: "近 3 天" },
  { days: 7, label: "近 7 天" },
  { days: 30, label: "近 30 天" },
] as const;
type WindowDays = (typeof WINDOW_OPTIONS)[number]["days"];

/**
 * 环境的展示顺序 = 部署流水线的推进顺序（test → staging → prod），不是字母序。
 * 读者的眼睛从左到右扫过去，正好是一次变更从测试走到生产的路径。
 * 复用 /stats 里的 ENV_ORDER 让两页语义对齐：test/staging/prod 永远是这顺序。
 */
const ENV_ORDER = ["test", "staging", "prod"] as const;
type EnvKey = (typeof ENV_ORDER)[number];

/**
 * 每个 env 的视觉配置。
 *
 * stroke-* 是 solid 折线（总部署数）的颜色；fill-* 是 dashed 折线下方半透明
 * 填充（失败区域）的颜色。两套色阶互相对齐（同色系、不同明度），保证读者
 * 一眼就能把「test 的失败区」和「test 的总数线」关联起来。
 *
 * Tailwind JIT 不会扫描运行时拼接的类名（`stroke-${color}-600`），所以必须
 * 把每个完整字面量写出来，列在这里集中管理而不是散在 JSX 模板字面量里。
 */
const ENV_STYLE: Record<
  EnvKey,
  { stroke: string; fill: string; label: string }
> = {
  test: { stroke: "#2563eb", fill: "#2563eb", label: "test" },
  staging: { stroke: "#9333ea", fill: "#9333ea", label: "staging" },
  prod: { stroke: "#dc2626", fill: "#dc2626", label: "prod" },
};

// ---------------------------------------------------------------------------
// SVG 几何常量
//
// viewBox 是固定的 800×300 用户坐标系，实际显示尺寸交给 CSS（width:100%）。
// 这就是 SVG 相对 canvas 的核心优势：一套坐标算一次，缩放由浏览器负责，
// 不需要 ResizeObserver、不需要 devicePixelRatio 补偿、不需要重绘。
//
// padding 四个方向不对称，各有各的理由：
//   left  40 —— 要放 Y 轴刻度数字，三位数（如 120）在 11px 字号下约 20px 宽，
//               再留 8px 与轴线的呼吸间距。
//   right 16 —— 最后一个数据点的圆点半径 3px + hover 时的高亮，不能贴边裁掉。
//   top   28 —— 峰值气泡要浮在折线上方，气泡本身 r=6 加文字行高约 24px。
//   bottom 34 —— X 轴标签一行，10px 字号 + 间距。
// ---------------------------------------------------------------------------
const VB_WIDTH = 800;
const VB_HEIGHT = 300;
const PAD_LEFT = 40;
const PAD_RIGHT = 16;
const PAD_TOP = 28;
const PAD_BOTTOM = 34;
const CHART_W = VB_WIDTH - PAD_LEFT - PAD_RIGHT; // 744
const CHART_H = VB_HEIGHT - PAD_TOP - PAD_BOTTOM; // 238

/** Y 轴分成几段。4 段 = 5 条线（含 0 与顶），是「够读又不糊」的经验值。 */
const Y_SEGMENTS = 4;

/**
 * 计算 Y 轴上界。
 *
 * 约束：这是**计数**轴，刻度必须是整数 —— 「1.5 次部署」没有意义。
 * 所以不能简单地 `yMax = maxValue` 再等分：max=7 时四等分得到 1.75/3.5/5.25，
 * 三个刻度全是小数。
 *
 * 做法：把上界向上取整到 Y_SEGMENTS 的倍数，于是每一段的高度天然是整数。
 * max=7 → 8（刻度 0/2/4/6/8）；max=13 → 16（0/4/8/12/16）；max=100 → 100（原样）。
 * 代价是上界通常比实际峰值高一点，折线不会顶到框顶 —— 这反而是好事，
 * 峰值气泡需要那点顶部空间。
 *
 * 下界固定 0：部署次数没有负数，且浮动基线会夸大波动幅度，是图表的经典误导。
 * 全 0 数据（新库、或该窗口内无部署）返回 Y_SEGMENTS 而不是 0，
 * 否则后面 `value / yMax` 会除零。
 */
function computeYMax(maxValue: number): number {
  if (maxValue <= 0) return Y_SEGMENTS;
  return Math.ceil(maxValue / Y_SEGMENTS) * Y_SEGMENTS;
}

/** "YYYY-MM-DD HH:MM:SS" → "MM-DD"。 */
function toMonthDay(ts: string): string {
  return ts.slice(5, 10);
}

/** "YYYY-MM-DD HH:MM:SS" → "HH"。 */
function toHour(ts: string): string {
  return ts.slice(11, 13);
}

/** 峰值气泡与 tooltip 用的完整可读时间。 */
function toReadable(ts: string, granularity: "hour" | "day"): string {
  return granularity === "hour"
    ? `${toMonthDay(ts)} ${toHour(ts)}:00`
    : toMonthDay(ts);
}

/**
 * 判断某个点是不是「一天的开始」——用于画日期分隔竖线。
 * hour 模式下是 00 点；day 模式下每个点都是一天，画在每一天上就成了满屏竖线，
 * 所以 day 模式改用周一作为分隔（自然的阅读分组）。
 */
function isDayBoundary(ts: string, granularity: "hour" | "day"): boolean {
  if (granularity === "hour") return toHour(ts) === "00";
  // day 模式：周一。用本地构造 Date，避免 "YYYY-MM-DD" 被当成 UTC 解析后偏一天。
  const [y, m, d] = ts.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).getDay() === 1;
}

/**
 * X 轴标签的抽稀策略。
 *
 * 核心约束：viewBox 宽 800，图表区 744，标签字号 10px。一个 "MM-DD" 约 30px 宽，
 * 一个 "HH" 约 14px 宽。要不重叠，标签总宽必须小于 744。
 *
 * 于是三档：
 *   - 24 点（days=1，hour）：全标，24×14 = 336px，绰绰有余，标 "HH"。
 *   - 72 点（days=3，hour）：只标 6 的整数倍小时（00/06/12/18），
 *     12 个标签，跨天的标 "MM-DD"，避免三天的 "06" 长得一模一样分不清哪天。
 *   - day 模式：按点数算步长，控制在 10 个标签以内，标 "MM-DD"。
 *     7 点全标；30 点每 3 个标一个。
 */
function shouldLabelX(
  point: TrendPoint,
  index: number,
  total: number,
  granularity: "hour" | "day"
): boolean {
  if (granularity === "hour") {
    if (total <= 24) return true;
    return Number(toHour(point.ts)) % 6 === 0;
  }
  const stride = Math.ceil(total / 10);
  // 从末尾往回数：保证「最后一个点（今天）」一定有标签 —— 读者最关心的就是它。
  return (total - 1 - index) % stride === 0;
}

/** X 轴标签文本。hour 模式在跨天处显示日期，其余显示小时。 */
function xLabelText(
  point: TrendPoint,
  granularity: "hour" | "day",
  total: number
): string {
  if (granularity !== "hour") return toMonthDay(point.ts);
  // 24 点以内是单日窗口，日期恒定，标日期是冗余的，只标小时。
  if (total <= 24) return toHour(point.ts);
  return toHour(point.ts) === "00" ? toMonthDay(point.ts) : toHour(point.ts);
}

/**
 * 折线路径生成器。
 *
 * 提取出来是因为现在有 6 条线（3 env × 2 指标），写 6 次 `coords.map(...)` 模板
 * 既冗余也容易漏边界。getValue 把「从 TrendPoint 里取数」的策略外传，
 * maxValue 跟着一起传避免重复扫描 —— 调用方已经计算好了。
 *
 * 一个点的退化情况：返回 "" 让上层跳过 <path> 渲染。一条 path 的两个端点
 * 重合是合法的（退化直线），但不渲染单点更省事。
 */
function buildPath(
  points: TrendPoint[],
  xAt: (i: number) => number,
  yAt: (count: number) => number,
  getValue: (p: TrendPoint) => number
): string {
  if (points.length < 2) return "";
  return points
    .map((p, i) => {
      const x = xAt(i);
      const y = yAt(getValue(p));
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/**
 * 折线下方填充区域路径。
 *
 * 失败数画成折线之外，再在折线和 X 轴（y=PAD_TOP+CHART_H）之间画一个
 * 半透明多边形 —— 让「哪里集中失败」在视觉上变成一块色块，而不是要看
 * Y 轴刻度心算。沿用折线同样的 xAt/yAt 保证左右两端对齐，否则填充区
 * 会比折线宽/窄一点点，边缘参差。
 *
 * 关闭路径用 Z 把终点连回起点，让 SVG 引擎闭合图形而非用 fillRule 猜。
 */
function buildAreaPath(
  points: TrendPoint[],
  xAt: (i: number) => number,
  yAt: (count: number) => number,
  getValue: (p: TrendPoint) => number,
  baselineY: number
): string {
  if (points.length < 2) return "";
  const top = points
    .map((p, i) => {
      const x = xAt(i);
      const y = yAt(getValue(p));
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  // 从最后一点走到 baseline，再回到第一点的 baseline，最后闭合。
  const firstX = xAt(0).toFixed(1);
  const lastX = xAt(points.length - 1).toFixed(1);
  return `${top} L${lastX},${baselineY} L${firstX},${baselineY} Z`;
}

export default function TrendPage() {
  const [days, setDays] = useState<WindowDays>(7);
  const [data, setData] = useState<TrendResponse | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number>(0);

  const load = useCallback(async () => {
    const res = await fetch(`/api/trend?days=${days}`);
    if (!res.ok) return; // 保留上一次数据，见文件头注释
    const json: TrendResponse = await res.json();
    setData(json);
    setLastSyncAt(Date.now());
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 任意 deployment.* 都重拉。趋势图统计的是「每个时间桶里有多少次部署」，
   * 新建会让某个桶 +1，而更新（改 started_at / 回滚标记）也可能挪动桶归属，
   * 所以两类事件都不能漏。
   */
  useChangeStream((event) => {
    if (affectsAnyDeployment(event)) load();
  });

  /**
   * 所有几何量一次算完。
   *
   * 放进 useMemo 而不是在 JSX 里内联计算：SSE 触发的 re-render 可能相当频繁
   * （一次批量部署会连着推好几条事件），而 30 点 × 6 条线的坐标换算虽然便宜，
   * 但把它和 data 绑在一起能让「渲染只是读值」这件事在代码上显式成立。
   */
  const geom = useMemo(() => {
    const points = data?.points ?? [];
    const n = points.length;
    if (n === 0) return null;

    const granularity = data!.granularity;

    /**
     * Y 轴上界取所有 line（3 env × 2 指标）里的最大值，统一归一化。
     * 这样 6 条线共用同一个标尺，绝对值才能横比。
     * 例如 prod 总数 8、test 失败 5、prod 失败 3，yMax 取 8 即可。
     */
    let maxValue = 0;
    for (const p of points) {
      for (const env of ENV_ORDER) {
        const b = p[env];
        if (b.total > maxValue) maxValue = b.total;
        if (b.failed > maxValue) maxValue = b.failed;
      }
    }
    const yMax = computeYMax(maxValue);

    /**
     * X 等分。n=1 时 (n-1)=0 会得到 Infinity，单独处理成「摆在正中」——
     * 一个点画不出折线，但圆点和 tooltip 仍然有意义。
     */
    const dx = n > 1 ? CHART_W / (n - 1) : 0;
    const xAt = (i: number) =>
      n > 1 ? PAD_LEFT + i * dx : PAD_LEFT + CHART_W / 2;
    /** SVG 的 y 轴朝下，所以是 底部 - 比例×高度。 */
    const yAt = (count: number) =>
      PAD_TOP + CHART_H - (count / yMax) * CHART_H;

    const coords = points.map((p, i) => ({
      x: xAt(i),
      point: p,
      index: i,
    }));

    /**
     * 6 条线的路径。
     * total* = 实线，failed* = 虚线 + 半透明填充。
     *
     * 顺序：先画所有填充（在下层），再画所有实线/虚线（在上层），
     * 这样填充不会盖住实线 —— 渲染顺序就是 SVG 的 z-order。
     */
    const paths: Array<{
      env: EnvKey;
      kind: "total" | "failed";
      d: string;
    }> = [];
    const areas: Array<{ env: EnvKey; d: string }> = [];

    for (const env of ENV_ORDER) {
      paths.push({
        env,
        kind: "total",
        d: buildPath(points, xAt, yAt, (p) => p[env].total),
      });
      paths.push({
        env,
        kind: "failed",
        d: buildPath(points, xAt, yAt, (p) => p[env].failed),
      });
      areas.push({
        env,
        d: buildAreaPath(
          points,
          xAt,
          yAt,
          (p) => p[env].failed,
          PAD_TOP + CHART_H
        ),
      });
    }

    /** Y 轴刻度值，从 0 到 yMax 均分。段高是整数（见 computeYMax）。 */
    const yTicks = Array.from(
      { length: Y_SEGMENTS + 1 },
      (_, i) => (yMax / Y_SEGMENTS) * i
    );

    /**
     * 峰值点。在 6 条线里找 total 最大的那个点，**同时记下它是哪个 env**，
     * 气泡文字会带上 env 名 —— 单看「峰值 12 次」读者还要去找是哪条线，
     * 加上「@ prod」一秒定位。
     *
     * 多峰并列时取第一个（test → staging → prod 顺序的 env × 时间顺序的 index），
     * 读者更关心「什么时候开始出现这个量级」，而不是末尾的同高点。
     * maxValue === 0 时不标 —— 「峰值 0 次」是噪声不是信息。
     */
    let peak: {
      x: number;
      y: number;
      ts: string;
      value: number;
      env: EnvKey;
    } | null = null;
    if (maxValue > 0) {
      outer: for (const env of ENV_ORDER) {
        for (let i = 0; i < points.length; i++) {
          if (points[i][env].total === maxValue) {
            peak = {
              x: xAt(i),
              y: yAt(maxValue),
              ts: points[i].ts,
              value: maxValue,
              env,
            };
            break outer;
          }
        }
      }
    }

    return { points, n, granularity, maxValue, yMax, coords, paths, areas, yTicks, peak };
  }, [data]);

  return (
    <div>
      {/* 顶部一行：标题左，控件右；移动端 flex-wrap 自然换行。 */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">部署频率趋势</h1>
        <div className="flex items-center gap-2">
          <div
            role="group"
            aria-label="时间窗口"
            className="inline-flex rounded-md border border-gray-300 bg-white"
          >
            {WINDOW_OPTIONS.map((opt) => {
              const active = days === opt.days;
              return (
                <button
                  key={opt.days}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setDays(opt.days)}
                  className={`h-9 px-3 text-sm transition-colors first:rounded-l-md last:rounded-r-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                    active
                      ? "bg-blue-600 font-medium text-white"
                      : "text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <button onClick={load} className={BUTTON_SECONDARY}>
            刷新
          </button>
        </div>
      </div>

      {/*
        图表容器。
        overflow-x-auto + svg 的 min-w-[520px]：viewBox 让 SVG 天然自适应父宽，
        缩放本身没有代价（矢量），但**字号会跟着缩** —— 轴标签是 10px，
        缩到 320px 宽时是 0.4 倍，实际渲染约 4px，完全不可读。

        520px 是反推出来的下限：10px × (520/800) = 6.5px，是小字仍能辨认的边界。
        于是 375px 的手机会触发横向滚动（520 > 375），滚动条换来的是
        「图能看清」；而 520px 以上的视口（含多数平板竖屏）直接铺满，不滚动。

        取舍说明：原始需求写的是 min-w 320px，但 320px 下实测字糊成一片，
        「不滚动」的收益抵不过「读不了」的损失 —— 一个必须横向滚动才能看全的
        可读图表，好过一个一屏装下但看不清的图表。
      */}
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white p-3">
        {geom === null ? (
          <div className="flex h-64 items-center justify-center text-sm text-gray-400">
            暂无数据
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${VB_WIDTH} ${VB_HEIGHT}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={`最近 ${days} 天部署频率趋势，按环境拆分`}
            className="h-auto w-full min-w-[520px]"
          >
            {/*
              网格横线。虚线（stroke-dasharray）而不是实线：网格是背景参考物，
              和折线用同样的实线笔触会争夺注意力。最底下那条（value=0）画实线，
              它同时是 X 轴基线，需要更强的存在感。

              fill/stroke 用 SVG 原生 attribute 而不是 Tailwind 类：
              Tailwind 的 stroke-* / fill-* 是能用，但 SVG presentation attribute
              优先级最低，任何外部 CSS 都能覆盖它 —— 反过来说，写成 attribute 时
              类名一旦拼错是静默失效（元素直接不可见），而 attribute 拼错至少
              还能拿到浏览器默认值。图表这种「必须画出来」的场景选 attribute 更稳。
            */}
            {geom.yTicks.map((value) => {
              const y = PAD_TOP + CHART_H - (value / geom.yMax) * CHART_H;
              const isBaseline = value === 0;
              return (
                <g key={`grid-${value}`}>
                  <line
                    x1={PAD_LEFT}
                    y1={y}
                    x2={PAD_LEFT + CHART_W}
                    y2={y}
                    stroke={isBaseline ? "#9ca3af" : "#d1d5db"}
                    strokeWidth={1}
                    strokeDasharray={isBaseline ? undefined : "4 4"}
                  />
                  {/*
                    Y 轴刻度数字。text-anchor="end" 让数字右对齐到轴线左侧，
                    这样 "8" 和 "120" 的右边缘齐平，是数字栏的标准排法。
                    dominantBaseline="middle" 让文字垂直居中于网格线，
                    否则文字基线压在线上、视觉上整体偏高半个字。
                  */}
                  <text
                    x={PAD_LEFT - 8}
                    y={y}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fontSize={11}
                    fill="#6b7280"
                  >
                    {value}
                  </text>
                </g>
              );
            })}

            {/*
              日期分隔竖线。比横向网格更淡（#e5e7eb），因为它是次级的分组线，
              不该和读数用的横线同等重量。第 0 个点跳过 —— 它和 Y 轴重合。
            */}
            {geom.coords.map((c) =>
              c.index > 0 && isDayBoundary(c.point.ts, geom.granularity) ? (
                <line
                  key={`sep-${c.point.ts}`}
                  x1={c.x}
                  y1={PAD_TOP}
                  x2={c.x}
                  y2={PAD_TOP + CHART_H}
                  stroke="#e5e7eb"
                  strokeWidth={1}
                />
              ) : null
            )}

            {/* X 轴标签。 */}
            {geom.coords.map((c) =>
              shouldLabelX(c.point, c.index, geom.n, geom.granularity) ? (
                <text
                  key={`xl-${c.point.ts}`}
                  x={c.x}
                  y={PAD_TOP + CHART_H + 16}
                  textAnchor="middle"
                  fontSize={10}
                  fill="#6b7280"
                >
                  {xLabelText(c.point, geom.granularity, geom.n)}
                </text>
              ) : null
            )}

            {/*
              失败区域填充。在折线层之下，让色块成为「底色」而不是盖在折线上。
              fill-opacity=0.18 —— 失败区本意是「引起注意」而不是「主导视觉」，
              太浓会和实线抢戏、太淡则被白底吃掉。0.18 配合同色 stroke 视觉
              重量翻倍，但又不至于糊成一块色斑。
            */}
            {geom.areas.map((a) =>
              a.d ? (
                <path
                  key={`area-${a.env}`}
                  d={a.d}
                  fill={ENV_STYLE[a.env].fill}
                  fillOpacity={0.18}
                  stroke="none"
                />
              ) : null
            )}

            {/*
              6 条折线。total = 实线（strokeWidth 2），failed = 虚线（dasharray 4 3、
              strokeWidth 1.5）。failed 用更细的笔触让两条线重叠时不至于完全遮住
              total —— 视觉上层级是「总部署是主干、失败是叠加层」。

              渲染顺序按 env 走（test → staging → prod），同一指标下后画的盖先画的。
              当 prod 的失败线恰好和 staging 的总线条重叠时，prod 红会盖住
              staging 紫，这正是 prod「红色高于一切」的语义。
            */}
            {geom.paths.map((p) => {
              if (!p.d) return null;
              const isFailed = p.kind === "failed";
              const envStyle = ENV_STYLE[p.env];
              return (
                <path
                  key={`line-${p.env}-${p.kind}`}
                  d={p.d}
                  fill="none"
                  stroke={envStyle.stroke}
                  strokeWidth={isFailed ? 1.5 : 2}
                  strokeDasharray={isFailed ? "4 3" : undefined}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              );
            })}

            {/*
              数据点。每个点都画，包括所有数 = 0 的 —— 空白处的圆点本身就是
              「这个时段确实没有部署」的信息，而不是「这段数据缺失」。
              同一 env 下 total/failed 同 x 不同 y 都画一个圆 —— 两个数相同
              时圆点会重叠成实心，读者看到「这一天的 prod 总数 = 失败数」也是
              有意义的（全是失败的部署）。

              tooltip 用 SVG 原生 <title>：浏览器免费提供 hover 气泡，
              零 JS、零状态、键盘和读屏器都能拿到。代价是延迟约 1 秒且样式
              不可控 —— 对一个「看趋势为主、查具体值为辅」的图表是划算的交换。
              <title> 必须是元素的第一个子节点才生效。
            */}
            {geom.coords.flatMap((c) =>
              ENV_ORDER.flatMap((env) => {
                const b = c.point[env];
                const envStyle = ENV_STYLE[env];
                return [
                  { env, kind: "total" as const, value: b.total, color: envStyle.stroke, yAt: (v: number) => PAD_TOP + CHART_H - (v / geom.yMax) * CHART_H },
                  { env, kind: "failed" as const, value: b.failed, color: envStyle.stroke, yAt: (v: number) => PAD_TOP + CHART_H - (v / geom.yMax) * CHART_H },
                ].map((dot) => {
                  if (dot.value === 0) return null;
                  const y = dot.yAt(dot.value);
                  return (
                    <circle
                      key={`pt-${c.point.ts}-${dot.env}-${dot.kind}`}
                      cx={c.x}
                      cy={y}
                      r={dot.kind === "total" ? 2.5 : 2}
                      fill={dot.color}
                      fillOpacity={dot.kind === "failed" ? 0.6 : 1}
                    >
                      <title>
                        {toReadable(c.point.ts, geom.granularity)} · {dot.env}{" "}
                        · {dot.kind === "total" ? "总部署" : "失败"} {dot.value}
                      </title>
                    </circle>
                  );
                });
              })
            )}

            {/* 峰值气泡。位置计算与设色理由见下方 PEAK 注释块。 */}
            {geom.peak && (
              <g>
                <circle
                  cx={geom.peak.x}
                  cy={geom.peak.y}
                  r={6}
                  fill={ENV_STYLE[geom.peak.env].stroke}
                  stroke="#ffffff"
                  strokeWidth={2}
                >
                  <title>
                    峰值 {geom.peak.value} 次 · {geom.peak.env} ·{" "}
                    {toReadable(geom.peak.ts, geom.granularity)}
                  </title>
                </circle>
                {/*
                  峰值文字。两处夹逼：
                    1. y 取 peak.y - 12，即气泡上方 4px 再加一个字的高度；
                       若峰值贴近顶部（y < PAD_TOP + 14），翻到气泡下方，
                       否则文字会被 viewBox 裁掉。
                    2. textAnchor 按 x 的位置切换 start/middle/end，
                       峰值落在最左/最右时不会横向溢出。
                */}
                <text
                  x={
                    geom.peak.x < 60
                      ? PAD_LEFT
                      : geom.peak.x > VB_WIDTH - 60
                        ? VB_WIDTH - PAD_RIGHT
                        : geom.peak.x
                  }
                  y={
                    geom.peak.y < PAD_TOP + 14
                      ? geom.peak.y + 22
                      : geom.peak.y - 12
                  }
                  textAnchor={
                    geom.peak.x < 60
                      ? "start"
                      : geom.peak.x > VB_WIDTH - 60
                        ? "end"
                        : "middle"
                  }
                  fontSize={11}
                  fontWeight={600}
                  fill={ENV_STYLE[geom.peak.env].stroke}
                >
                  峰值 {geom.peak.value} 次 @ {geom.peak.env} ·{" "}
                  {toReadable(geom.peak.ts, geom.granularity)}
                </text>
              </g>
            )}
          </svg>
        )}
      </div>

      {/*
        底部图例 + 峰值提示 + 同步时间。
        图例用和图里完全相同的颜色画小色块，读者不用记「蓝色是什么」——
        对照即可。粒度也在这里说明：用户选了「近 3 天」却看到 72 个点，
        需要一句话解释为什么横轴突然变成小时。

        6 项图例（3 env × 总/失败）两两一组排版：每组竖排两个 mini 图例
        （实线=总、虚线=失败），三组之间用横向间距分组。这样总-失败的语义
        关系比「6 个一排横过来」更紧。
      */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-gray-500">
        <div className="flex flex-wrap items-center gap-5">
          {ENV_ORDER.map((env) => {
            const s = ENV_STYLE[env];
            return (
              <div key={`legend-${env}`} className="flex flex-col gap-1">
                <span className="inline-flex items-center gap-1.5">
                  <svg width="16" height="8" aria-hidden="true">
                    <line
                      x1="0"
                      y1="4"
                      x2="16"
                      y2="4"
                      stroke={s.stroke}
                      strokeWidth={2}
                    />
                  </svg>
                  <span className="text-xs font-medium text-gray-700">
                    {s.label}
                  </span>
                  <span className="text-xs text-gray-400">总部署</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <svg width="16" height="8" aria-hidden="true">
                    <line
                      x1="0"
                      y1="4"
                      x2="16"
                      y2="4"
                      stroke={s.stroke}
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                    />
                  </svg>
                  <span className="text-xs text-gray-500">失败</span>
                </span>
              </div>
            );
          })}
          {geom && (
            <span className="text-xs text-gray-400">
              粒度：
              {geom.granularity === "hour" ? "每小时" : "每天"}（{geom.n} 个点）
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {geom?.peak && (
            <span className="text-xs">
              峰值{" "}
              <strong
                className="font-semibold"
                style={{ color: ENV_STYLE[geom.peak.env].stroke }}
              >
                {geom.peak.value} 次
              </strong>{" "}
              出现在 {geom.peak.env} ·{" "}
              {toReadable(geom.peak.ts, geom.granularity)}
            </span>
          )}
          <span className="text-xs">
            最近同步：
            {lastSyncAt ? new Date(lastSyncAt).toLocaleString() : "尚未同步"}
          </span>
        </div>
      </div>
    </div>
  );
}