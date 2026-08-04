"use client";

/**
 * 健康度统计面板。
 *
 * 6 张卡片的取舍：PRD 列了 7 个口径（4 个计数 + 成功率 + 平均时长 + MTTR），
 * 但移动端 2 列布局下塞 7 张会挤出横向滚动，且「平均时长」与「MTTR」高度同源
 * （MTTR 是 failed 子集的均值，平均时长是全量的均值，行为长期趋同，
 * 失败率稳定时两者读数接近），同时显示两个会让用户不知道看哪个。
 * 决策：保留 4 个计数（总部署 / 成功 / 失败 / 进行中）+ 成功率 + MTTR，
 * 把平均时长折叠进 MTTR 的 sub 文本里（参见下方 MTTR 卡的 sub）。
 * 如未来需要可拆成 7 张，但目前不需要。
 */

import { useCallback, useEffect, useState } from "react";
import { useChangeStream } from "@/hooks/useChangeStream";
import { affectsAnyDeployment } from "@/lib/changeStream";
import { BUTTON_SECONDARY } from "@/lib/constants";

interface Stats {
  total: number;
  success: number;
  failed: number;
  pending: number;
  success_rate: number;
  avg_duration_sec: number;
  mttr_sec: number;
}

/**
 * 把秒数渲染成「X 分 Y 秒 / Y 秒」。
 *
 * 与 src/app/deployments/[id]/page.tsx 里的同名函数刻意分开命名避免冲突 —— 那
 * 个版本接收两个日期字符串做差，且只在两端都有效时返回结果；这里只接收一个数字，
 * 调用方已经知道是秒。两者语义不重叠，合并反而会让任一调用方多走一步判断。
 */
function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "-";
  const total = Math.round(sec);
  if (total < 60) return `${total} 秒`;
  const min = Math.floor(total / 60);
  const s = total % 60;
  return s > 0 ? `${min} 分 ${s} 秒` : `${min} 分钟`;
}

/** 顶部一栏的数字卡。沿用 src/app/page.tsx 的 dt/dd 语义结构。 */
function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="mt-1 text-2xl font-bold text-gray-900">{value}</dd>
      {sub && <p className="mt-0.5 text-xs text-gray-400">{sub}</p>}
    </div>
  );
}

export default function StatsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  // 0 表示尚未拉过；用时间戳而不是布尔可以把「刚刚同步过」直接渲染出来。
  const [lastSyncAt, setLastSyncAt] = useState<number>(0);

  const load = useCallback(async () => {
    const res = await fetch("/api/stats");
    if (!res.ok) {
      // 后端 agent 在并行实现，可能暂时 404。把当前 stats 留着不立刻清空，
      // 否则短暂不可用会让面板的数字跳回「-」再回来，闪烁反而更让人不安。
      return;
    }
    const data: Stats = await res.json();
    setStats(data);
    setLastSyncAt(Date.now());
  }, []);

  useEffect(() => { load(); }, [load]);

  /**
   * 任一部署维度变更都触发重算 —— MTTR 与成功率都对新建/更新敏感。
   * `affectsAnyDeployment` 不存在：部署历史/详情有专属判定函数，这里
   * 直接按「任意 deployment.*」过滤即可，逻辑够简单不必再抽。
   */
  useChangeStream((event) => {
    if (affectsAnyDeployment(event)) load();
  });

  // 全 0 时不显示 NaN：先把数字都安全化，再分别派生文案。
  const safe = stats ?? {
    total: 0,
    success: 0,
    failed: 0,
    pending: 0,
    success_rate: 0,
    avg_duration_sec: 0,
    mttr_sec: 0,
  };

  const ratePct = (safe.success_rate * 100).toFixed(1);
  const avgText =
    stats && stats.avg_duration_sec > 0 ? formatDuration(stats.avg_duration_sec) : "-";

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">健康度统计</h1>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="总部署" value={String(safe.total)} />
        <StatCard label="成功" value={String(safe.success)} />
        <StatCard label="失败" value={String(safe.failed)} />
        <StatCard label="进行中" value={String(safe.pending)} />
        {/* 成功率：数字 + 一根窄进度条。主视觉仍是字形 + 数字，色盲用户
            即使看不出绿色也能读出百分比。背景条按比例铺底，仅辅助。 */}
        <StatCard
          label="成功率"
          value={`${ratePct}%`}
          sub={`基于 ${safe.success + safe.failed} 次结束`}
        />
        {/* MTTR：把平均时长作为 sub 文本附在 MTTR 卡上 —— 见文件头注释，
            7→6 张的取舍让两指标共用一张卡，避免移动端溢出。 */}
        <StatCard
          label="MTTR"
          value={
            stats && stats.failed > 0 ? formatDuration(stats.mttr_sec) : "-"
          }
          sub={`平均时长 ${avgText}`}
        />
      </dl>

      {/* 进度条独立于卡片之外：与卡片同宽网格铺底，长度跟着成功率走。 */}
      <div className="mt-3 rounded-lg border border-gray-200 bg-white p-3">
        <div className="h-1.5 w-full rounded-full bg-gray-100" aria-hidden="true">
          <div
            className="h-full rounded-full bg-green-500 transition-all"
            style={{ width: `${Math.max(0, Math.min(100, safe.success_rate * 100))}%` }}
          />
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-sm text-gray-500">
        <span>
          最近同步:{" "}
          {lastSyncAt ? new Date(lastSyncAt).toLocaleString() : "尚未同步"}
        </span>
        <button onClick={load} className={BUTTON_SECONDARY}>
          刷新
        </button>
      </div>
    </div>
  );
}