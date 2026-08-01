"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, INPUT_CLASS } from "@/lib/constants";
import type { Service } from "@/types";

export default function EditServicePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
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
      const message = data.error || "保存失败";
      setError(message);
      toast.error(message);
      return;
    }
    toast.success(`服务「${name}」已更新`);
    router.push("/services");
  };

  if (notFound) {
    return (
      <div>
        <h1 className="mb-4 text-2xl font-bold">编辑服务</h1>
        <p role="alert" className="text-sm text-red-600">
          服务不存在
        </p>
        <Link
          href="/services"
          className="mt-3 inline-block text-sm text-blue-600 hover:underline"
        >
          返回服务列表
        </Link>
      </div>
    );
  }

  if (!loaded) {
    return <div className="text-gray-500">加载中...</div>;
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">编辑服务</h1>
        <Link href="/services" className="text-sm text-gray-600 hover:underline">
          返回列表
        </Link>
      </div>

      <form
        onSubmit={handleSubmit}
        className="max-w-2xl space-y-4 rounded-lg border border-gray-200 bg-white p-6"
      >
        {error && (
          <p role="alert" aria-live="assertive" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <div>
          <label htmlFor="edit-name" className="mb-1 block text-sm font-medium">
            服务名 <span className="text-red-500">*</span>
          </label>
          <input
            id="edit-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={INPUT_CLASS}
            required
          />
        </div>
        <div>
          <label htmlFor="edit-desc" className="mb-1 block text-sm font-medium">
            描述
          </label>
          <input
            id="edit-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor="edit-owner" className="mb-1 block text-sm font-medium">
            负责人
          </label>
          <input
            id="edit-owner"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div className="flex gap-2 pt-2">
          <button type="submit" disabled={saving} className={BUTTON_PRIMARY}>
            {saving ? "保存中..." : "保存"}
          </button>
          <Link href="/services" className={BUTTON_SECONDARY}>
            取消
          </Link>
        </div>
      </form>
    </div>
  );
}
