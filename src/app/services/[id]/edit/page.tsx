"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

interface Service {
  id: number;
  name: string;
  description: string;
  owner: string;
}

export default function EditServicePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [loaded, setLoaded] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [owner, setOwner] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/services/${id}`)
      .then(async (r) => {
        if (r.status === 404) {
          setNotFound(true);
          return null;
        }
        return r.json();
      })
      .then((data: Service | null) => {
        if (data) {
          setName(data.name);
          setDescription(data.description ?? "");
          setOwner(data.owner ?? "");
        }
        setLoaded(true);
      });
  }, [id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    const res = await fetch(`/api/services/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, owner }),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json();
      setError(data.error || "保存失败");
      return;
    }
    router.push("/services");
  };

  if (notFound) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-4">编辑服务</h1>
        <p className="text-red-600 text-sm">服务不存在</p>
        <a href="/services" className="text-blue-600 hover:underline text-sm mt-3 inline-block">
          返回服务列表
        </a>
      </div>
    );
  }

  if (!loaded) {
    return <div className="text-gray-500">加载中...</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">编辑服务</h1>
        <a
          href="/services"
          className="text-sm text-gray-600 hover:underline"
        >
          返回列表
        </a>
      </div>

      <form
        onSubmit={handleSubmit}
        className="bg-white border rounded-lg p-4 space-y-3 max-w-2xl"
      >
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex flex-col gap-1">
          <label className="text-sm text-gray-600">服务名 *</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="border rounded px-3 py-1.5 text-sm"
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-sm text-gray-600">描述</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="border rounded px-3 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-sm text-gray-600">负责人</label>
          <input
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className="border rounded px-3 py-1.5 text-sm"
          />
        </div>
        <div className="flex gap-2 pt-2">
          <button
            type="submit"
            disabled={saving}
            className="bg-blue-600 text-white px-4 py-1.5 rounded text-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? "保存中..." : "保存"}
          </button>
          <a
            href="/services"
            className="bg-gray-100 text-gray-700 px-4 py-1.5 rounded text-sm hover:bg-gray-200"
          >
            取消
          </a>
        </div>
      </form>
    </div>
  );
}
