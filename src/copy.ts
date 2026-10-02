// @input:  (none - 纯函数，零依赖，不得 import config.ts)
// @output: Scene, CopyVars, DEFAULT_COPY, renderCopy
// @pos:    根层 - 分场景文案模板（占位符替换 + 默认值）

export type Scene =
  | "WAITING"
  | "TOOL_CALL"
  | "TOOL_RESULT"
  | "TOOL_FAILED"
  | "TEXT"
  | "HEARTBEAT"
  | "PERMISSION"
  | "BODY"

export interface CopyVars {
  tool?: string // TOOL_CALL / TOOL_RESULT：工具名
  result?: string // TOOL_RESULT：调用方已截断到 PROGRESS_TOOL_RESULT_MAX 的结果摘要
  error?: string // TOOL_FAILED：调用方已截断到 120 的错误消息
  snippet?: string // TEXT：调用方已截断到 PROGRESS_TEXT_MAX 的中间文本
  min?: number // HEARTBEAT：分钟
  sec?: number // HEARTBEAT：秒
  dots?: string // WAITING：动画帧字符串（由 StreamSession 计算）
  title?: string // PERMISSION：权限标题
  body?: string // BODY：正文
}

// 默认文案：TOOL_CALL/TOOL_RESULT/TOOL_FAILED/TEXT/HEARTBEAT 与 bridge.ts 现行硬编码逐字一致；
// WAITING/PERMISSION/BODY 为新增（无现状对照）。
export const DEFAULT_COPY: Record<Scene, string> = {
  WAITING: "请稍候{dots}",
  TOOL_CALL: "🔧 调用工具：{tool}",
  TOOL_RESULT: "📄 {tool} 返回：{result}",
  TOOL_FAILED: "❌ 工具失败：{error}",
  TEXT: "💬 {snippet}",
  HEARTBEAT: "⏳ 仍在处理中（已用 {min} 分 {sec} 秒）…",
  PERMISSION: "🔒 需要授权：{title}",
  BODY: "{body}",
}

// 已知占位符集合：未知占位符原样保留（fail-visible），缺失 var 渲染为空串
const KNOWN_PLACEHOLDERS = new Set([
  "tool",
  "result",
  "error",
  "snippet",
  "min",
  "sec",
  "dots",
  "title",
  "body",
])

/**
 * 渲染分场景文案。
 * 截断一律在调用方（bridge.ts）做完再传 vars，本函数不做任何截断——
 * 保证非流式路径与现行硬编码字节级一致。
 */
export function renderCopy(
  scene: Scene,
  vars: CopyVars = {},
  texts?: Partial<Record<Scene, string>>,
): string {
  const template = texts?.[scene] ?? DEFAULT_COPY[scene]
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (!KNOWN_PLACEHOLDERS.has(key)) return match
    return String(vars[key as keyof CopyVars] ?? "")
  })
}
