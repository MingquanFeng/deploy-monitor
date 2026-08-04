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
import { BUTTON_SECONDARY, ENV_LABELS } from "@/lib/constants";

interface Stats {
  total: number;
  success: number;
  failed: number;
  pending: number;
  success_rate: number;
  avg_duration_sec: number;
  mttr_sec: number;
}

/** 单个环境的口径。比 Stats 少一个 avg_duration_sec —— 后端契约如此。 */
type EnvStats = Omit<Stats, "avg_duration_sec">;

/** `GET /api/stats` 的新响应形状。 */
interface StatsResponse {
  overall: Stats;
  by_env: Record<EnvKey, EnvStats>;
}

/**
 * 环境的展示顺序 = 部署流水线的推进顺序(test → staging → prod),不是字母序。
 * 读者的眼睛从左到右扫过去,正好是一次变更从测试走到生产的路径。
 */
const ENV_ORDER = ["test", "staging", "prod"] as const;
type EnvKey = (typeof ENV_ORDER)[number];

/**
 * 环境标签配色。集中在这里而不是散在 JSX 里,原因有二:
 * 一是 Tailwind 的 JIT 只认源码里出现过的完整类名字符串,
 * `bg-${color}-100` 这种拼接会被扫描器漏掉、编译不出样式,必须写全;
 * 二是配色是语义决策,应当能一眼看完、一处改完。
 *
 * prod 用红:红色在这套面板里已经被「失败」占用(STATUS_BADGE.failed 同为
 * red-100/800)。这不是撞色,而是刻意让两个红叠加 —— 生产环境的失败是唯一
 * 需要立刻有人起身处理的信号,视觉权重必须高于其余五种组合的任意一种。
 * test 蓝(中性、信息性)、staging 紫(介于两者之间的警示度),都让位于它。
 */
const ENV_BADGE: Record<EnvKey, string> = {
  test: "bg-blue-100 text-blue-800",
  staging: "bg-purple-100 text-purple-800",
  prod: "bg-red-100 text-red-800",
};

/** 空环境的零值。后端保证空 env 全 0,这里兜住后端尚未上线的过渡期。 */
const EMPTY_ENV: EnvStats = {
  total: 0,
  success: 0,
  failed: 0,
  pending: 0,
  success_rate: 0,
  mttr_sec: 0,
};

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

/**
 * 成功率进度条。原本内联在整体卡片下方,现在整体与各环境共用同一根实现,
 * 避免两处各写一遍 width 钳位。`aria-hidden` 是因为百分比数字就在旁边,
 * 读屏器读一遍足够,再读一次进度条只是噪音。
 */
function RateBar({ rate }: { rate: number }) {
  const pct = Math.max(0, Math.min(100, rate * 100));
  return (
    <div className="h-1.5 w-full rounded-full bg-gray-100" aria-hidden="true">
      <div
        // 0% 时不上绿色:一根宽度为 0 的绿条看不见,但「没有数据」和
        // 「成功率就是 0」在视觉上应该有区别,后者要能读出灰底。
        className={`h-full rounded-full transition-all ${
          pct > 0 ? "bg-green-500" : "bg-gray-300"
        }`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** 「按环境对比」区块里的单张环境卡。容器样式与上方 StatCard 保持一致。 */
function EnvCard({ env, data }: { env: EnvKey; data: EnvStats }) {
  const ratePct = (data.success_rate * 100).toFixed(1);
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <span
          className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${ENV_BADGE[env]}`}
        >
          {ENV_LABELS[env]}
        </span>
        <span className="text-xs text-gray-400">{data.total} 次</span>
      </div>

      {/* 数字小矩阵:2×2,与卡片宽度无关,窄屏也不会挤成一列。 */}
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
        {[
          { label: "总数", value: data.total, tone: "text-gray-900" },
          { label: "成功", value: data.success, tone: "text-green-700" },
          { label: "失败", value: data.failed, tone: "text-red-700" },
          { label: "进行中", value: data.pending, tone: "text-yellow-700" },
        ].map((it) => (
          <div key={it.label}>
            <dt className="text-xs text-gray-500">{it.label}</dt>
            <dd className={`text-lg font-semibold ${it.tone}`}>{it.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-3">
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-gray-500">成功率</span>
          <span className="text-sm font-semibold text-gray-900">{ratePct}%</span>
        </div>
        <div className="mt-1">
          <RateBar rate={data.success_rate} />
        </div>
      </div>

      <div className="mt-3 flex items-baseline justify-between">
        <span className="text-xs text-gray-500">MTTR</span>
        {/* 与整体卡片一致:没有失败样本时 MTTR 无意义,显示「-」而不是「0 秒」
            —— 后者会被读成「修复只花了 0 秒」,是个假信号。 */}
        <span className="text-sm font-semibold text-gray-900">
          {data.failed > 0 && data.mttr_sec > 0
            ? formatDuration(data.mttr_sec)
            : "-"}
        </span>
      </div>
    </div>
  );
}

export default function StatsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [byEnv, setByEnv] = useState<Record<EnvKey, EnvStats> | null>(null);
  // 0 表示尚未拉过；用时间戳而不是布尔可以把「刚刚同步过」直接渲染出来。
  const [lastSyncAt, setLastSyncAt] = useState<number>(0);

  const load = useCallback(async () => {
    const res = await fetch("/api/stats");
    if (!res.ok) {
      // 后端 agent 在并行实现，可能暂时 404。把当前 stats 留着不立刻清空，
      // 否则短暂不可用会让面板的数字跳回「-」再回来，闪烁反而更让人不安。
      return;
    }
    /**
     * 兼容新旧两种形状。后端 agent 正在并行改造,期间 `/api/stats` 可能
     * 仍返回扁平的旧结构。用 `overall` 是否存在做判定而不是版本号:
     * 判据就在数据本身,后端切换的那一刻前端自动跟上,无需同步发布。
     */
    const data: StatsResponse | Stats = await res.json();
    if ("overall" in data) {
      setStats(data.overall);
      setByEnv(data.by_env);
    } else {
      setStats(data);
      setByEnv(null); // 旧形状没有分环境数据,区块整体不渲染
    }
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
        <RateBar rate={safe.success_rate} />
      </div>

      {/* 按环境对比。后端未就绪(旧形状)时整块不渲染 —— 与其显示三张全 0 的
          卡让人以为「真的一次部署都没有」,不如先不出现。 */}
      {byEnv && (
        <section className="mt-6">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">按环境对比</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {ENV_ORDER.map((env) => (
              <EnvCard key={env} env={env} data={byEnv[env] ?? EMPTY_ENV} />
            ))}
          </div>
        </section>
      )}

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