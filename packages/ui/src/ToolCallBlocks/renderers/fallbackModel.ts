/** 未知工具兜底卡的数据归一层：UI 只消费这里的结果，便于单测覆盖空参数/等待/错误。 */

export type FallbackParameterView =
  | { kind: "none" }
  | { kind: "table"; entries: Array<{ key: string; value: string }> }
  | { kind: "raw"; text: string };

export type FallbackResultLabel = "error" | "result";

export type FallbackResultView =
  | { kind: "error"; text: string; isString: boolean }
  | { kind: "result"; text: string; isString: boolean }
  | { kind: "waiting"; label: FallbackResultLabel }
  | { kind: "empty"; label: FallbackResultLabel };

export function stringifyFallbackValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

export function resolveFallbackParameterView(input: unknown): FallbackParameterView {
  if (input === undefined) {
    return { kind: "none" };
  }

  const isPlainRecord =
    typeof input === "object" && input !== null && !Array.isArray(input) ? input : null;
  if (isPlainRecord) {
    const entries = Object.entries(isPlainRecord);
    if (entries.length === 0) {
      return { kind: "none" };
    }
    // 上游语义：只有全为原始值的对象才铺两列表；嵌套对象/数组整体回退 <pre>，
    // 避免表格单元格里再塞多行 JSON 把行高撑乱。
    if (entries.every(([, value]) => typeof value !== "object" || !value)) {
      return {
        kind: "table",
        entries: entries.map(([key, value]) => ({ key, value: stringifyFallbackValue(value) })),
      };
    }
  }

  return { kind: "raw", text: stringifyFallbackValue(input) };
}

export function resolveFallbackResultView({
  errorText,
  isRunning,
  output,
  status,
  statusLabel,
}: {
  errorText?: string;
  isRunning: boolean;
  output: unknown;
  status?: string;
  statusLabel?: string;
}): FallbackResultView {
  const hasError = status === "failed" || Boolean(errorText?.trim());
  const value = hasError ? errorText || statusLabel : output;
  const label: FallbackResultLabel = hasError ? "error" : "result";

  if (value === undefined) {
    return isRunning || status === "pending" ? { kind: "waiting", label } : { kind: "empty", label };
  }

  const text = stringifyFallbackValue(value);
  return { kind: hasError ? "error" : "result", text, isString: typeof value === "string" };
}