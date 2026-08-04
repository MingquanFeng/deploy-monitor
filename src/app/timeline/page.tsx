"use client";

/**
 * 部署时间线视图。
 *
 * 3 行（test/staging/prod）× N 列（最近 N 天）的失败率热力网格。
 * 一格 = 「这天在这个环境下做了 X 次部署，其中 Y 次失败」。
 * 颜色按失败率分阶；空集（total=0）单独标灰，与「全部成功」区分开，
 * 避免视觉误读 —— 灰底表示「这天没部署」而不是「这天 0% 失败」。
 *
 * 数据契约见任务说明：`GET /api/timeline?days=N` 返回 buckets 数组，
 * 每个 bucket 含三个 env 的 { total, failed }。后端正在并行实现，
 * 上线前可能 404 —— 与 /stats 页面用相同的兜底策略：保持上一次的数据，
 * 而不是清空让数字「跳回 - 再回来」的闪烁。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useChangeStream } from "@/hooks/useChangeStream";
import { affectsAnyDeployment } from "@/lib/changeStream";
import { BUTTON_SECONDARY, ENV_LABELS } from "@/lib/constants";

/** 环境的展示顺序 = 部署流水线的推进顺序，与 /stats 页面保持一致。 */
const ENV_ORDER = ["test", "staging", "prod"] as const;
type _EnvKey = (typeof ENV_ORDER)[number];

/** 单 env 单日桶。 */
interface EnvBucket {
  total: number;
  failed: number;
}

/** `GET /api/timeline` 响应形状。 */
interface TimelineResponse {
  days: number;
  buckets: Array<{
    date: string;
    test: EnvBucket;
    staging: EnvBucket;
    prod: EnvBucket;
  }>;
}

/** 单个时间窗选项。标签、值都明确写出 —— 比 `7` 这种裸数字更易读。 */
const WINDOW_OPTIONS = [
  { days: 7, label: "近 7 天" },
  { days: 30, label: "近 30 天" },
] as const;
type WindowDays = (typeof WINDOW_OPTIONS)[number]["days"];

/**
 * 失败率 → 背景色 / 文字色的色阶映射。
 *
 * Tailwind JIT 只扫描源码里出现过的完整类名字符串 —— `bg-${color}-${n}`
 * 拼接的类名扫描器看不到，编译期不会产生 CSS，运行时是无效类。
 * 把每个档位的全部类名写进 const 数组作为字面量，是项目里既有的规避方式
 * （见 /stats 页面 ENV_BADGE 的注释）。
 *
 * 按阈值降序排列，匹配时从最高档往低档找第一个命中的（rate >= threshold）。
 * 100% → red-500+白字 是最深档 —— 没有「比 100% 更糟」的语义，
 * 所以 threshold 不写到 101。
 */
const FAIL_RATE_BG: Array<{
  threshold: number;
  class: string;
  /** 单元格内文字的颜色。深底配白字，浅底配深字，与背景对比度足够。 */
  text: string;
}> = [
  { threshold: 76, class: "bg-red-500", text: "text-white" },
  { threshold: 51, class: "bg-red-300", text: "text-red-900" },
  { threshold: 26, class: "bg-yellow-300", text: "text-yellow-900" },
  { threshold: 1, class: "bg-yellow-100", text: "text-yellow-900" },
  { threshold: 0, class: "bg-green-50", text: "text-gray-700" },
];

/** 空集档 —— 与 0% 失败率刻意区分。threshold 单独放最后，且不在 BG 表里按数值匹配。 */
const EMPTY_CLASS = "bg-gray-50";
const EMPTY_TEXT = "text-gray-400";

/**
 * 把失败率映射到样式档。total=0 是独立分支，不参与 rate 计算（避免 0/0 = NaN）。
 * BG 表按阈值降序，遍历到第一个命中的就返回 —— 即「rate ≥ 阈值」即落入该档。
 */
function pickStyle(bucket: EnvBucket): { bg: string; text: string } {
  if (bucket.total === 0) {
    return { bg: EMPTY_CLASS, text: EMPTY_TEXT };
  }
  const rate = bucket.failed / bucket.total;
  for (const step of FAIL_RATE_BG) {
    if (rate * 100 >= step.threshold) {
      return { bg: step.class, text: step.text };
    }
  }
  // 0% 的失败率在表里 threshold=0 那档兜住；这里只是类型完备。
  return { bg: "bg-green-50", text: "text-gray-700" };
}

/**
 * 把 bucket.date（"YYYY-MM-DD"）压缩成 "MM-DD"。年份在 N 天窗口内不切换，
 * 跨年只在「1/1 前后 N=7 天」的小概率情况下出现 —— 不去显示年份，因为：
 *   1. 短窗口下读者更关心「最近 7 天的形态」而非绝对年份。
 *   2. 表格本来就窄，列越多越挤，年份被挤掉换回来的是列宽空间。
 * 移动端进一步压缩在 CSS 层做（见下方 min-w + truncate），不在数据层折断。
 */
function formatBucketDate(dateStr: string): string {
  const parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  return `${parts[1]}-${parts[2]}`;
}

export default function TimelinePage() {
  const [window, setWindow] = useState<WindowDays>(7);
  const [data, setData] = useState<TimelineResponse | null>(null);
  // 用时间戳记录最近一次成功同步；与 /stats 页面同款，方便显示「刚刚同步」。
  const [lastSyncAt, setLastSyncAt] = useState<number>(0);

  const load = useCallback(async () => {
    const res = await fetch(`/api/timeline?days=${window}`);
    if (!res.ok) {
      // 后端 agent 在并行实现，可能暂时 404。沿用 /stats 页面策略：
      // 保持当前 data 不清空，避免闪烁。
      return;
    }
    const json: TimelineResponse = await res.json();
    setData(json);
    setLastSyncAt(Date.now());
  }, [window]);

  useEffect(() => { load(); }, [load]);

  /**
   * 任意 deployment.* 都触发重拉 —— 时间线关心的是「最近 N 天有多少次部署 /
   * 其中失败多少」，任意新建、状态变更、删除都会改变桶里的计数。
   * 后端要扛住 N=30 时的高频刷新，单次 SQL 聚合在 SQLite 上是 O(N) 表扫描，
   * 当前部署记录量级（百级）远远够用。
   */
  useChangeStream((event) => {
    if (affectsAnyDeployment(event)) load();
  });

  /**
   * 把日期桶拆成「显示列」。后端返回的 buckets 按 date ASC，最后一天在最右，
   * 但人眼从左到右扫时习惯「越右越新」，所以保持原序即可。
   * 即便后端未来改成 DESC，这里也会因为 map 的顺序被显示成倒序，
   * 届时再调整 —— 当前以契约为准。
   */
  const columns = useMemo(() => data?.buckets ?? [], [data]);

  return (
    <div>
      {/*
        顶部一行。标题与控件同 baseline：标题左、控件右。
        移动端用 flex-wrap 让两行换行时不撞。
      */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">部署时间线</h1>
        <div className="flex items-center gap-2">
          {/*
            时间窗按钮组：用 segmented control 风格 —— 当前选中态用蓝底白字，
            其余按钮用白底灰字 + 边框。aria-pressed 给读屏器表达「这是单选按钮组」。
          */}
          <div
            role="group"
            aria-label="时间窗口"
            className="inline-flex rounded-md border border-gray-300 bg-white"
          >
            {WINDOW_OPTIONS.map((opt) => {
              const active = window === opt.days;
              return (
                <button
                  key={opt.days}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setWindow(opt.days)}
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
        网格容器。
        横向溢出问题：3 行 × 30 列在移动端必然撑出滚动条。
        解决方式：
          1. 容器加 overflow-x-auto —— 允许横向滚动而不撑爆父布局。
          2. 单元格用 min-w + 固定尺寸，保证列宽一致，不会被截成奇形怪状。
          3. 日期列用 whitespace-nowrap —— 压缩文本不会换行成两行。
        与「用 border 区分单元」相比：
          - 用 ring 而不是 border 做 hover 高亮：border 会让格子向外扩 1px，
            同行其他格子抖一像素（layout shift），视觉上像漏闪。
          - 用 grid + gap:1px + 灰背景 = 网格线，无需每格单独画边框。
      */}
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-gray-200">
        <div
          role="grid"
          aria-label={`最近 ${window} 天部署失败率`}
          className="grid min-w-fit"
          style={{
            /*
              gridTemplateColumns:第一列是行标签（环境名）固定 80px，
              其余 N 列每列 64px。64px 是「两位数字 + 一点 padding」的最小可视尺寸，
              30 列 = 1920px,横屏不会溢出,移动端则触发容器的横向滚动。
            */
            gridTemplateColumns: `80px repeat(${columns.length}, minmax(64px, 1fr))`,
            gap: "1px",
          }}
        >
          {/* 表头行：左上角空，然后是日期。 */}
          <div
            role="columnheader"
            className="sticky left-0 z-10 bg-white px-2 py-2 text-xs font-medium text-gray-500"
          >
            环境
          </div>
          {columns.map((b) => (
            <div
              key={`h-${b.date}`}
              role="columnheader"
              className="bg-white px-2 py-2 text-center text-xs font-medium tabular-nums text-gray-500"
            >
              {formatBucketDate(b.date)}
            </div>
          ))}

          {/* 数据行：每行一个环境。 */}
          {ENV_ORDER.map((env) => (
            <div key={env} role="row" className="contents">
              <div
                role="rowheader"
                className="sticky left-0 z-10 flex items-center bg-white px-3 py-2 text-sm font-medium text-gray-700"
              >
                {ENV_LABELS[env]}
              </div>
              {columns.map((b) => {
                const bucket = b[env];
                const style = pickStyle(bucket);
                return (
                  <div
                    key={`${env}-${b.date}`}
                    role="gridcell"
                    /*
                      hover 用 ring-2 而不是 border —— 见上方容器注释。
                      ring 是在元素外侧画一层,不影响盒模型尺寸,同行其他格子不抖。
                      ring-blue-400 与「失败」色阶的红/黄不撞,在所有档位上都可读。
                    */
                    className={`group relative flex h-12 items-center justify-center text-sm font-semibold tabular-nums transition-shadow hover:ring-2 hover:ring-blue-400 hover:ring-inset ${style.bg} ${style.text}`}
                  >
                    {/*
                      数字主体。只显示 total —— failed 占比已经在背景色里表达,
                      数字主体追求「一眼读出今天做了多少」,失败次数交给 tooltip。
                    */}
                    <span>{bucket.total}</span>
                    {/*
                      <span> 而非 <div>:Tailwind 不会把它当成独立块,
                      共享主格的尺寸,定位时也不会被父级 flex 推走。
                      tooltip 用绝对定位叠在格子右上,鼠标悬停自然显示 —— 不依赖 JS。
                    */}
                    <span className="pointer-events-none absolute right-1 top-1 hidden rounded bg-gray-900 px-1.5 py-0.5 text-[10px] font-normal text-white shadow-lg group-hover:block">
                      {bucket.total} 次部署, {bucket.failed} 失败
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/*
        底部图例 + 同步状态。
        图例横向平铺五档,避免文字解释 —— 颜色已经在格子里用了,
        让读者对照格子颜色与图例就能读懂。
      */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-gray-500">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-400">失败率:</span>
          {FAIL_RATE_BG.slice().reverse().map((step, idx, arr) => {
            // 上一档的 threshold + 1 即本档的下界；最高档（数组第一项）上界是 100。
            const upper = idx === arr.length - 1 ? 100 : arr[idx + 1].threshold;
            const lower = step.threshold;
            const range =
              lower === 0
                ? `0–${upper === 100 ? "100" : upper - 1}%`
                : `${lower}–${upper === 100 ? "100" : upper - 1}%`;
            return (
              <span
                key={step.threshold}
                className={`inline-flex items-center rounded px-2 py-0.5 text-xs ${step.class} ${step.text}`}
              >
                {range}
              </span>
            );
          })}
          <span
            className={`inline-flex items-center rounded px-2 py-0.5 text-xs ${EMPTY_CLASS} ${EMPTY_TEXT}`}
          >
            无部署
          </span>
        </div>
        <span>
          最近同步:{" "}
          {lastSyncAt ? new Date(lastSyncAt).toLocaleString() : "尚未同步"}
        </span>
      </div>
    </div>
  );
}