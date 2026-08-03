"use client";

import { useCallback, useEffect, useState } from "react";
import { useChangeStream } from "@/hooks/useChangeStream";
import { affectsDeploymentList } from "@/lib/changeStream";
import {
  CELL_CLASS,
  ENV_LABELS,
  INPUT_CLASS,
  STATUS_BADGE,
  STATUS_GLYPH,
  STATUS_LABELS,
} from "@/lib/constants";
import { formatDateTime } from "@/lib/format";
import type { Deployment } from "@/types";

export default function DeploymentsPage() {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [envFilter, setEnvFilter] = useState("");
  const [search, setSearch] = useState("");

  /**
   * load 读了 envFilter，所以必须 useCallback([envFilter])。
   *
   * 这解决了一个真实的闭包陷阱：原先 load 是每次 render 重建的普通函数，
   * `useEffect(() => { load() }, [envFilter])` 恰好能工作（每次 render
   * 的 effect 都捕获当轮的新 load），但那是巧合，也是那条 exhaustive-deps
   * warning 的来源。接入 SSE 后同一个函数还要被实时刷新调用，
   * 「捕获的 envFilter 是哪一轮的」就不再无关紧要 ——
   * 如果传给 hook 的是一个捕获了旧 envFilter 的闭包，用户切到「生产」筛选后，
   * 后续每次实时刷新都会悄悄把列表拉回「全部环境」的结果，
   * 表现为「筛选偶尔自己失效」。
   *
   * useCallback 让 load 的身份与 envFilter 同步变化：筛选变了 → load 是新的
   * → 下面两个 effect 都重新执行（重新拉数据 + 重新用新闭包订阅），
   * 筛选没变时身份稳定、不会引起重连。
   */
  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (envFilter) params.set("env", envFilter);
    fetch(`/api/deployments?${params}`)
      .then((r) => r.json())
      .then(setDeployments);
  }, [envFilter]);

  useEffect(() => { load(); }, [load]);

  /**
   * 过滤：全部 deployment.*，加上 service.deleted（级联删了记录）
   * 与 service.updated（本表有 service_name 一列，改名后要跟着变）。
   * 判定逻辑在 changeStream.ts 里，是纯函数、有测试覆盖。
   *
   * onChange 是内联箭头函数，每次 render 都是新引用 —— 这没问题，
   * hook 内部把它存进 ref，不会因此重连（见 useChangeStream.ts）。
   */
  useChangeStream((event) => {
    if (affectsDeploymentList(event)) load();
  });

  const filtered = search
    ? deployments.filter((d) =>
        d.service_name.toLowerCase().includes(search.toLowerCase())
      )
    : deployments;

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">部署历史</h1>

      <div className="mb-4 flex flex-wrap gap-3">
        <div className="min-w-[200px] flex-1">
          <label htmlFor="dep-search" className="sr-only">
            搜索服务名
          </label>
          <input
            id="dep-search"
            type="search"
            placeholder="搜索服务名..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor="dep-env" className="sr-only">
            按环境筛选
          </label>
          <select
            id="dep-env"
            value={envFilter}
            onChange={(e) => setEnvFilter(e.target.value)}
            className={`${INPUT_CLASS} w-auto`}
          >
            <option value="">全部环境</option>
            <option value="test">测试</option>
            <option value="staging">预发</option>
            <option value="prod">生产</option>
          </select>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full min-w-[760px] text-sm">
          <caption className="sr-only">
            全部部署记录，共 {filtered.length} 条
          </caption>
          <thead className="bg-gray-50 text-left">
            <tr>
              <th scope="col" className={`${CELL_CLASS} font-medium text-gray-700`}>服务</th>
              <th scope="col" className={`${CELL_CLASS} font-medium text-gray-700`}>版本</th>
              <th scope="col" className={`${CELL_CLASS} font-medium text-gray-700`}>环境</th>
              <th scope="col" className={`${CELL_CLASS} font-medium text-gray-700`}>状态</th>
              <th scope="col" className={`${CELL_CLASS} font-medium text-gray-700`}>部署人</th>
              <th scope="col" className={`${CELL_CLASS} font-medium text-gray-700`}>时间</th>
              <th scope="col" className={`${CELL_CLASS} font-medium text-gray-700`}>备注</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((d) => (
              <tr key={d.id} className="border-t border-gray-100 hover:bg-gray-50">
                <td className={`${CELL_CLASS} font-medium`}>{d.service_name}</td>
                <td className={`${CELL_CLASS} font-mono`}>{d.version || "-"}</td>
                <td className={CELL_CLASS}>
                  <span
                    className={
                      d.environment === "prod"
                        ? "font-semibold text-gray-900"
                        : "text-gray-600"
                    }
                  >
                    {ENV_LABELS[d.environment]}
                  </span>
                </td>
                <td className={CELL_CLASS}>
                  <span
                    className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${
                      STATUS_BADGE[d.status]
                    }`}
                  >
                    <span aria-hidden="true">{STATUS_GLYPH[d.status]}</span>
                    {STATUS_LABELS[d.status]}
                  </span>
                </td>
                <td className={CELL_CLASS}>{d.deployed_by || "-"}</td>
                <td className={`${CELL_CLASS} whitespace-nowrap text-gray-500`}>
                  {formatDateTime(d.started_at)}
                </td>
                <td className={`${CELL_CLASS} max-w-[200px] truncate text-gray-500`}>
                  {d.note || "-"}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                  {search ? `没有匹配「${search}」的记录` : "暂无部署记录"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
