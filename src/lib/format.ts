/**
 * 时间格式化工具。
 *
 * 数据库里的时间列由 `nowLocal()`(src/lib/db.ts)写入,格式为
 * `"YYYY-MM-DD HH:MM:SS"`,取的是**服务器本地时区**的墙上时间,
 * 不带时区后缀。所以这里必须按本地时区解析,不能补 `Z`(那会
 * 整体偏移一个时区差)。
 *
 * `new Date("2026-07-31 22:30:00")` 走的是引擎的非标准兜底解析;
 * 把空格换成 `T` 后变成 ES 规范里的 date-time 形式,规范明确
 * 「不带偏移量时按本地时区解释」,跨引擎行为一致。
 */

/** 把数据库里的 naive datetime 按本地时区解析为 Date;无法解析时返回 null。 */
export function parseDbDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;

  // 已带时区信息(ISO 的 Z / ±HH:MM)时原样交给 Date。
  const normalized = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(dateStr)
    ? dateStr
    : dateStr.replace(" ", "T");

  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 相对时间。近期用「刚刚 / N 分钟前」,超过 30 天退化为绝对日期,
 * 避免出现「412 天前」这种读者无法换算的表达。
 */
export function formatRelativeTime(dateStr: string | null | undefined): string {
  const date = parseDbDate(dateStr);
  if (!date) return "-";

  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);

  // diffSec 为负(时钟漂移 / 未来时间)时也落到「刚刚」,不显示负数。
  if (diffSec < 60) return "刚刚";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  if (diffSec < 86400 * 30) return `${Math.floor(diffSec / 86400)} 天前`;

  return formatDate(dateStr);
}

/** 绝对日期 `YYYY-MM-DD`。 */
export function formatDate(dateStr: string | null | undefined): string {
  const date = parseDbDate(dateStr);
  if (!date) return "-";

  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 绝对时间 `YYYY-MM-DD HH:MM`,用于表格里需要精确时间的列。 */
export function formatDateTime(dateStr: string | null | undefined): string {
  const date = parseDbDate(dateStr);
  if (!date) return "-";

  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${formatDate(dateStr)} ${hh}:${mm}`;
}
