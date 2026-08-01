"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import {
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  CELL_CLASS,
  INPUT_CLASS,
} from "@/lib/constants";
import { formatDateTime } from "@/lib/format";
import type { Service } from "@/types";

export default function ServicesPage() {
  const toast = useToast();
  const [services, setServices] = useState<Service[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [owner, setOwner] = useState("");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  // 待确认删除的服务。null = 对话框关闭。存整个对象而不只是 id,
  // 这样对话框里能显示服务名 —— 让用户确认的是「删哪个」,不是「删不删」。
  const [pendingDelete, setPendingDelete] = useState<Service | null>(null);

  const load = () => fetch("/api/services").then((r) => r.json()).then(setServices);
  useEffect(() => { load(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    const res = await fetch("/api/services", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: desc, owner }),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json();
      // 表单内保留内联错误(错误紧邻出错的字段),同时弹 toast
      // 覆盖「表单已滚出视口」的情况。
      setError(data.error);
      toast.error(data.error || "创建失败");
      return;
    }
    toast.success(`服务「${name}」已创建`);
    setName(""); setDesc(""); setOwner("");
    setShowForm(false);
    load();
  };

  const confirmDelete = async () => {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);

    const res = await fetch(`/api/services/${target.id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error(`删除「${target.name}」失败`);
      return;
    }
    toast.success(`服务「${target.name}」已删除`);
    load();
  };

  const filtered = services.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">服务管理</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          aria-expanded={showForm}
          className={showForm ? BUTTON_SECONDARY : BUTTON_PRIMARY}
        >
          {showForm ? "取消" : "新建服务"}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="mb-6 rounded-lg border border-gray-200 bg-white p-4"
        >
          {/*
            role="alert" + aria-live 让读屏用户在提交失败时立刻听到原因,
            而不是要自己去表单里摸索哪里错了。
          */}
          {error && (
            <p role="alert" aria-live="assertive" className="mb-3 text-sm text-red-600">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[150px] flex-1">
              <label htmlFor="svc-name" className="mb-1 block text-sm text-gray-600">
                服务名 <span className="text-red-500">*</span>
              </label>
              <input
                id="svc-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={INPUT_CLASS}
                required
              />
            </div>
            <div className="min-w-[150px] flex-1">
              <label htmlFor="svc-desc" className="mb-1 block text-sm text-gray-600">
                描述
              </label>
              <input
                id="svc-desc"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                className={INPUT_CLASS}
              />
            </div>
            <div className="w-40">
              <label htmlFor="svc-owner" className="mb-1 block text-sm text-gray-600">
                负责人
              </label>
              <input
                id="svc-owner"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                className={INPUT_CLASS}
              />
            </div>
            <button type="submit" disabled={saving} className={BUTTON_PRIMARY}>
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </form>
      )}

      <div className="mb-4">
        <label htmlFor="svc-search" className="sr-only">
          搜索服务名
        </label>
        <input
          id="svc-search"
          type="search"
          placeholder="搜索服务名..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={INPUT_CLASS}
        />
      </div>

      {/*
        overflow-x-auto 在这一层:小屏上表格自己横向滚动,
        而不是把整个页面撑宽。min-w 让列在窄屏下不被挤成竖排文字。
      */}
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full min-w-[640px] text-sm">
          <caption className="sr-only">
            服务列表，共 {filtered.length} 个服务
          </caption>
          <thead className="bg-gray-50 text-left">
            <tr>
              <th scope="col" className={`${CELL_CLASS} font-medium text-gray-700`}>服务名</th>
              <th scope="col" className={`${CELL_CLASS} font-medium text-gray-700`}>描述</th>
              <th scope="col" className={`${CELL_CLASS} font-medium text-gray-700`}>负责人</th>
              <th scope="col" className={`${CELL_CLASS} font-medium text-gray-700`}>创建时间</th>
              <th scope="col" className={`${CELL_CLASS} font-medium text-gray-700`}>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={s.id} className="border-t border-gray-100 hover:bg-gray-50">
                <td className={CELL_CLASS}>
                  <Link
                    href={`/services/${s.id}`}
                    className="font-medium text-blue-600 hover:underline"
                  >
                    {s.name}
                  </Link>
                </td>
                <td className={`${CELL_CLASS} text-gray-600`}>{s.description || "-"}</td>
                <td className={CELL_CLASS}>{s.owner || "-"}</td>
                <td className={`${CELL_CLASS} whitespace-nowrap text-gray-500`}>
                  {formatDateTime(s.created_at)}
                </td>
                <td className={CELL_CLASS}>
                  <div className="flex items-center gap-3">
                    <Link
                      href={`/services/${s.id}/edit`}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      编辑
                    </Link>
                    <button
                      onClick={() => setPendingDelete(s)}
                      // 列表里有很多个「删除」,读屏用户只听到「删除」
                      // 无法判断删的是哪一行,所以补上服务名。
                      aria-label={`删除服务 ${s.name}`}
                      className="text-xs text-red-600 hover:underline"
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                  {search ? `没有匹配「${search}」的服务` : "暂无服务"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        destructive
        title="确认删除服务？"
        description={
          <>
            将删除服务
            <span className="font-medium text-gray-900">「{pendingDelete?.name}」</span>
            ，其关联的<strong className="font-medium">全部部署记录也会一并删除</strong>
            。此操作不可撤销。
          </>
        }
        confirmLabel="删除"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
