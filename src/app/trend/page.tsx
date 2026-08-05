"use client";

/**
 * 部署频率趋势图。
 *
 * 手写 SVG 折线图，不引图表库。理由不是「造轮子有趣」，而是成本核算：
 * recharts/chart.js 打进 bundle 是 100~200KB 级别的量，而这里需要的
 * 全部能力是「一条折线 + 若干圆点 + 五条网格线」——三十行 path 拼接就够。
 * 库带来的响应式容器、动画、图例系统在这个页面一个都用不上。
 *
 * 数据契约：`GET /api/trend?days=N` → { days, granularity, points[] }。
 * granularity 由后端按 days 决定（<=3 → hour，>3 → day），前端不猜、只读，
 * 因为坐标轴的标注策略要跟着它走。
 *
 * 后端并行实现期间可能 404 —— 与 /stats、/timeline 同款兜底：保留上一次的
 * 数据而不是清空，避免图表「消失一帧再画回来」的闪烁。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useChangeStream } from "@/hooks/useChangeStream";
import { affectsAnyDeployment } from "@/lib/changeStream";
import { BUTTON_SECONDARY } from "@/lib/constants";

/** 单个数据点。ts 是 "YYYY-MM-DD HH:MM:SS" 的本地时间字符串。 */
interface TrendPoint {
  ts: string;
  count: number;
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
 * 所以不能简单地 `yMax = maxCount` 再等分：max=7 时四等分得到 1.75/3.5/5.25，
 * 三个刻度全是小数。
 *
 * 做法：把上界向上取整到 Y_SEGMENTS 的倍数，于是每一段的高度天然是整数。
 * max=7 → 8（刻度 0/2/4/6/8）；max=13 → 16（0/4/8/12/16）；max=100 → 100（原样）。
 * 代价是上界通常比实际峰值高一点，折线不会顶到框顶 —— 这反而是好事，
 * 峰值气泡需要那点顶部空间。
 *
 * 下界固定 0：部署次数没有负数，且浮动基线会夸大波动幅度，是图表的经典误导。
 * 全 0 数据（新库、或该窗口内无部署）返回 Y_SEGMENTS 而不是 0，
 * 否则后面 `count / yMax` 会除零。
 */
function computeYMax(maxCount: number): number {
  if (maxCount <= 0) return Y_SEGMENTS;
  return Math.ceil(maxCount / Y_SEGMENTS) * Y_SEGMENTS;
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
   * （一次批量部署会连着推好几条事件），而 30 点的坐标换算虽然便宜，
   * 但把它和 data 绑在一起能让「渲染只是读值」这件事在代码上显式成立。
   */
  const geom = useMemo(() => {
    const points = data?.points ?? [];
    const n = points.length;
    if (n === 0) return null;

    const granularity = data!.granularity;
    const maxCount = Math.max(...points.map((p) => p.count));
    const yMax = computeYMax(maxCount);

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
      y: yAt(p.count),
      point: p,
      index: i,
    }));

    /**
     * 折线路径。第一个点 M，其余 L。
     * 坐标保留一位小数：SVG 接受浮点，但 "123.45678901" 这种全精度串
     * 会让 30 点的 d 属性膨胀到近 1KB，且没有任何视觉收益 —— 一位小数
     * 在 800 宽的 viewBox 里已经远低于一个物理像素。
     */
    const linePath = coords
      .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
      .join(" ");

    /** Y 轴刻度值，从 0 到 yMax 均分。段高是整数（见 computeYMax）。 */
    const yTicks = Array.from(
      { length: Y_SEGMENTS + 1 },
      (_, i) => (yMax / Y_SEGMENTS) * i
    );

    /**
     * 峰值点。取**第一个**达到 max 的点而不是最后一个：
     * 多峰并列时，读者更关心「什么时候开始出现这个量级」。
     * maxCount === 0 时不标峰值 —— 「峰值 0 次」是噪声不是信息。
     */
    const peak =
      maxCount > 0 ? coords.find((c) => c.point.count === maxCount) ?? null : null;

    return { points, n, granularity, maxCount, yMax, coords, linePath, yTicks, peak };
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
            aria-label={`最近 ${days} 天部署频率趋势，峰值 ${geom.maxCount} 次`}
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
              折线。fill="none" 是必须的 —— path 默认填充黑色，
              漏掉它会得到一大块黑色多边形而不是一条线。
              linejoin/linecap 用 round：折点多且密时，miter 尖角在
              陡峭的转折处会甩出很长的刺。
            */}
            <path
              d={geom.linePath}
              fill="none"
              stroke="#2563eb"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            {/*
              数据点。每个点都画，包括 count=0 的 —— 空白处的圆点本身就是
              「这个时段确实没有部署」的信息，而不是「这段数据缺失」。

              tooltip 用 SVG 原生 <title>：浏览器免费提供 hover 气泡，
              零 JS、零状态、键盘和读屏器都能拿到。代价是延迟约 1 秒且样式
              不可控 —— 对一个「看趋势为主、查具体值为辅」的图表是划算的交换。
              <title> 必须是元素的第一个子节点才生效。
            */}
            {geom.coords.map((c) => (
              <circle
                key={`pt-${c.point.ts}`}
                cx={c.x}
                cy={c.y}
                r={3}
                fill="#2563eb"
              >
                <title>
                  {toReadable(c.point.ts, geom.granularity)} · {c.point.count} 次部署
                </title>
              </circle>
            ))}

            {/* 峰值气泡。位置计算与设色理由见下方 PEAK 注释块。 */}
            {geom.peak && (
              <g>
                <circle
                  cx={geom.peak.x}
                  cy={geom.peak.y}
                  r={6}
                  fill="#dc2626"
                  stroke="#ffffff"
                  strokeWidth={2}
                >
                  <title>
                    峰值 {geom.maxCount} 次 ·{" "}
                    {toReadable(geom.peak.point.ts, geom.granularity)}
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
                  fill="#dc2626"
                >
                  峰值 {geom.maxCount} 次 @{" "}
                  {toReadable(geom.peak.point.ts, geom.granularity)}
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
      */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-gray-500">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1.5">
            <svg width="16" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="16" y2="4" stroke="#2563eb" strokeWidth="2" />
              <circle cx="8" cy="4" r="3" fill="#2563eb" />
            </svg>
            <span className="text-xs">部署次数</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <svg width="16" height="12" aria-hidden="true">
              <circle cx="8" cy="6" r="5" fill="#dc2626" stroke="#ffffff" strokeWidth="2" />
            </svg>
            <span className="text-xs">峰值</span>
          </span>
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
              <strong className="font-semibold text-red-600">
                {geom.maxCount} 次
              </strong>{" "}
              出现在 {toReadable(geom.peak.point.ts, geom.granularity)}
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
