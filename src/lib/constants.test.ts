import { describe, expect, it } from "vitest";
import {
  ENV_LABELS,
  STATUS_BADGE,
  STATUS_COLORS,
  STATUS_LABELS,
} from "@/lib/constants";

/**
 * 这些常量表驱动 UI 的文案与配色。它们的 key 必须与数据库
 * CHECK 约束里的取值严格对齐 —— 否则新增/改名枚举值时,
 * 页面会静默渲染出 undefined 而不是报错。
 * 这里把「schema 枚举」与「UI 映射表」的一致性钉死。
 */

// 与 deployments 表 CHECK 约束一致
const SCHEMA_ENVIRONMENTS = ["test", "staging", "prod"] as const;
const SCHEMA_STATUSES = ["pending", "success", "failed"] as const;

describe("ENV_LABELS", () => {
  it("恰好覆盖 schema 允许的全部环境,不多不少", () => {
    expect(Object.keys(ENV_LABELS).sort()).toEqual([...SCHEMA_ENVIRONMENTS].sort());
  });

  it.each(SCHEMA_ENVIRONMENTS)("环境 %s 有非空中文标签", (env) => {
    expect(ENV_LABELS[env]).toBeTruthy();
    expect(typeof ENV_LABELS[env]).toBe("string");
  });

  it("标签互不重复(避免 UI 上两个环境同名)", () => {
    const labels = Object.values(ENV_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("STATUS_LABELS", () => {
  it("恰好覆盖 schema 允许的全部状态,不多不少", () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([...SCHEMA_STATUSES].sort());
  });

  it.each(SCHEMA_STATUSES)("状态 %s 有非空中文标签", (status) => {
    expect(STATUS_LABELS[status]).toBeTruthy();
  });

  it("标签互不重复", () => {
    const labels = Object.values(STATUS_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("STATUS_BADGE / STATUS_COLORS", () => {
  it("STATUS_BADGE 覆盖全部状态", () => {
    expect(Object.keys(STATUS_BADGE).sort()).toEqual([...SCHEMA_STATUSES].sort());
  });

  it("STATUS_COLORS 覆盖全部状态", () => {
    expect(Object.keys(STATUS_COLORS).sort()).toEqual([...SCHEMA_STATUSES].sort());
  });

  it.each(SCHEMA_STATUSES)("状态 %s 的 badge 是 Tailwind 类名", (status) => {
    expect(STATUS_BADGE[status]).toMatch(/bg-\w+-\d{2,3}/);
    expect(STATUS_BADGE[status]).toMatch(/text-\w+-\d{2,3}/);
  });

  it.each(SCHEMA_STATUSES)("状态 %s 的圆点色是 Tailwind 背景类", (status) => {
    expect(STATUS_COLORS[status]).toMatch(/^bg-\w+-\d{2,3}$/);
  });

  it("三种状态配色互不相同(绿/黄/红可区分)", () => {
    const colors = SCHEMA_STATUSES.map((s) => STATUS_COLORS[s]);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("语义配色符合约定:success 绿 / pending 黄 / failed 红", () => {
    expect(STATUS_COLORS.success).toContain("green");
    expect(STATUS_COLORS.pending).toContain("yellow");
    expect(STATUS_COLORS.failed).toContain("red");
  });

  it("badge 配色与圆点配色的色系一致", () => {
    for (const status of SCHEMA_STATUSES) {
      const hue = STATUS_COLORS[status].replace(/^bg-/, "").replace(/-\d+$/, "");
      expect(STATUS_BADGE[status]).toContain(hue);
    }
  });
});

describe("未知取值的降级行为", () => {
  it("查表未命中时返回 undefined(调用方需自己兜底)", () => {
    // 记录当前契约:这些表没有默认值。
    // 页面若直接渲染 ENV_LABELS[x] 会在脏数据下显示空白。
    expect(ENV_LABELS["bogus"]).toBeUndefined();
    expect(STATUS_LABELS["bogus"]).toBeUndefined();
    expect(STATUS_BADGE["bogus"]).toBeUndefined();
    expect(STATUS_COLORS["bogus"]).toBeUndefined();
  });
});
