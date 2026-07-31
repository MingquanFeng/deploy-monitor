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
