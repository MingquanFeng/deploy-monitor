export const ENV_LABELS: Record<string, string> = {
  test: "测试",
  staging: "预发",
  prod: "生产",
};

export const STATUS_LABELS: Record<string, string> = {
  pending: "进行中",
  success: "成功",
  failed: "失败",
};

export const STATUS_BADGE: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  success: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

export const STATUS_COLORS: Record<string, string> = {
  success: "bg-green-500",
  pending: "bg-yellow-500",
  failed: "bg-red-500",
};

/**
 * 状态的形状编码。颜色不能是唯一的信息载体(WCAG 1.4.1 Use of Color)——
 * 红绿色盲用户看不出绿点和红点的区别,所以每个状态额外配一个字形。
 */
export const STATUS_GLYPH: Record<string, string> = {
  success: "✓",
  pending: "•",
  failed: "✕",
};

// ---------------------------------------------------------------------------
// 尺寸令牌
//
// 先前各页面的 input/button 混用 py-1.5 与 py-2,同一行里的控件高度差
// 2~4px,视觉上参差不齐。统一用固定高度而不是 padding:padding 的最终
// 高度取决于 font-size 与 line-height,换字号就会跑偏;固定高度则不会。
// h-9 = 36px,满足触控目标的常规下限;表单主按钮用 h-10 = 40px。
// ---------------------------------------------------------------------------

/** 单行输入框 / 下拉框。`h-9` + `leading-none` 让文字在固定高度里垂直居中。 */
export const INPUT_CLASS =
  "h-9 w-full rounded-md border border-gray-300 bg-white px-3 text-sm " +
  "transition-colors placeholder:text-gray-400 " +
  "focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 " +
  "disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400";

/** 多行文本域。高度由 rows 决定,所以这里不带 h-*。 */
export const TEXTAREA_CLASS =
  "w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm " +
  "transition-colors placeholder:text-gray-400 " +
  "focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20";

/** 所有按钮共用的基座:高度、居中、焦点环、禁用态。 */
const BUTTON_BASE =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-4 " +
  "text-sm font-medium transition-colors " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export const BUTTON_PRIMARY =
  `${BUTTON_BASE} bg-blue-600 text-white hover:bg-blue-700 focus-visible:ring-blue-500`;

export const BUTTON_SECONDARY =
  `${BUTTON_BASE} border border-gray-300 bg-white text-gray-700 ` +
  `hover:bg-gray-50 focus-visible:ring-gray-400`;

export const BUTTON_DANGER =
  `${BUTTON_BASE} bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500`;

/** 表格单元格的统一内距,表头与数据行共用,保证纵向网格对齐。 */
export const CELL_CLASS = "px-4 py-2.5";
