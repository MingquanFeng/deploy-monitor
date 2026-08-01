"use client";

import { useEffect, useState } from "react";
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

  const load = () => {
    const params = new URLSearchParams();
    if (envFilter) params.set("env", envFilter);
    fetch(`/api/deployments?${params}`)
      .then((r) => r.json())
      .then(setDeployments);
  };

  useEffect(() => { load(); }, [envFilter]);

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
