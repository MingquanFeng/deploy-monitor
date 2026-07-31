"use client";

import { useEffect, useState } from "react";

interface Service {
  id: number;
  name: string;
  description: string;
  owner: string;
  created_at: string;
}

export default function ServicesPage() {
  const [services, setServices] = useState<Service[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [owner, setOwner] = useState("");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  const load = () => fetch("/api/services").then((r) => r.json()).then(setServices);
  useEffect(() => { load(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const res = await fetch("/api/services", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: desc, owner }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error);
      return;
    }
    setName(""); setDesc(""); setOwner("");
    setShowForm(false);
    load();
  };

  const handleDelete = async (id: number) => {
    if (!confirm("确认删除该服务？关联的部署记录也会被删除。")) return;
    await fetch(`/api/services/${id}`, { method: "DELETE" });
    load();
  };

  const filtered = services.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">服务管理</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700"
        >
          {showForm ? "取消" : "新建服务"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-white border rounded-lg p-4 mb-6 space-y-3">
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <div className="flex gap-3 flex-wrap">
            <input
              placeholder="服务名 *"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="border rounded px-3 py-1.5 text-sm flex-1 min-w-[150px]"
              required
            />
            <input
              placeholder="描述"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              className="border rounded px-3 py-1.5 text-sm flex-1 min-w-[150px]"
            />
            <input
              placeholder="负责人"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              className="border rounded px-3 py-1.5 text-sm w-40"
            />
            <button
              type="submit"
              className="bg-green-600 text-white px-4 py-1.5 rounded text-sm hover:bg-green-700"
            >
              保存
            </button>
          </div>
        </form>
      )}

      <input
        placeholder="搜索服务名..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="border rounded px-3 py-1.5 text-sm w-full mb-4"
      />

      <div className="bg-white border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left">
            <tr>
              <th className="px-4 py-2">服务名</th>
              <th className="px-4 py-2">描述</th>
              <th className="px-4 py-2">负责人</th>
              <th className="px-4 py-2">创建时间</th>
              <th className="px-4 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={s.id} className="border-t hover:bg-gray-50">
                <td className="px-4 py-2">
                  <a href={`/services/${s.id}`} className="text-blue-600 hover:underline">
                    {s.name}
                  </a>
                </td>
                <td className="px-4 py-2 text-gray-600">{s.description}</td>
                <td className="px-4 py-2">{s.owner}</td>
                <td className="px-4 py-2 text-gray-500">{s.created_at}</td>
                <td className="px-4 py-2">
                  <button
                    onClick={() => handleDelete(s.id)}
                    className="text-red-600 hover:underline text-xs"
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                  暂无服务
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
