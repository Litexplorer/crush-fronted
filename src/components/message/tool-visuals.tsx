/**
 * tool-visuals.tsx
 * 核心流程：工具卡片的公共展示逻辑 ——
 *           toolIcon      按工具名选择图标
 *           toolSummary   按工具类型提取一行摘要（agent 取任务首行，不再回退原始 JSON）
 *           formatJson    展开态的 input JSON 格式化
 */

import type { JSX } from "solid-js"

/**
 * parseToolInput
 * 参数：inputRaw tool_call.input（JSON 字符串）
 * 核心流程：尝试 JSON.parse 为对象；失败或空则返回空对象（摘要走原始字符串兜底）
 */
export function parseToolInput(inputRaw: string | undefined): Record<string, unknown> {
  if (!inputRaw) return {}
  try {
    const parsed = JSON.parse(inputRaw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // 非 JSON：由摘要逻辑按原始字符串处理
  }
  return {}
}

/**
 * toolIcon
 * 参数：name 工具名
 * 核心流程：按工具名选图标（bash→终端、edit/write→文件、其余→扳手）
 */
export function toolIcon(name: string): JSX.Element {
  const lower = name.toLowerCase()
  if (lower.includes("bash") || lower.includes("shell")) {
    return (
      <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M2.5 4h11v8h-11z" stroke-linejoin="round" />
        <path d="m4.5 6.5 2 1.75-2 1.75M8 10.25h3.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    )
  }
  if (/edit|write|multiedit|patch/.test(lower)) {
    return (
      <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M9.5 2.5H4A1.5 1.5 0 0 0 2.5 4v8A1.5 1.5 0 0 0 4 13.5h8A1.5 1.5 0 0 0 13.5 12V6.5" stroke-linecap="round" />
        <path d="m6.5 9.5 6-6 1.5 1.5-6 6H6.5z" stroke-linejoin="round" />
      </svg>
    )
  }
  if (lower === "agent") {
    return (
      <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="8" cy="4.5" r="2" />
        <circle cx="4" cy="11.5" r="1.5" />
        <circle cx="12" cy="11.5" r="1.5" />
        <path d="M8 6.5v3M5.2 10.3 7 8.5M10.8 10.3 9 8.5" stroke-linecap="round" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="1.5">
      <path
        d="M9.7 4.3a2.8 2.8 0 0 0-3.7 3.4L2.6 11a1.5 1.5 0 1 0 2.1 2.1l3.3-3.4a2.8 2.8 0 0 0 3.4-3.7L9.9 7.5 8.2 5.8z"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  )
}

/**
 * toolSummary
 * 参数：name 工具名；inputRaw 原始 input 字符串
 * 核心流程：bash 取 command 首行；edit/write 取文件名；
 *           agent 取 prompt 首个非空行；其余取原始字符串前 80 字符
 */
export function toolSummary(name: string, inputRaw: string | undefined): string {
  const lower = name.toLowerCase()
  const input = parseToolInput(inputRaw)
  if (lower.includes("bash") || lower.includes("shell")) {
    const command = input.command
    if (typeof command === "string" && command) {
      const firstLine = command.split("\n")[0] ?? command
      return truncate(firstLine, 80)
    }
  }
  if (/(edit|write|multiedit|patch)/.test(lower)) {
    const filePath = input.file_path ?? input.path
    if (typeof filePath === "string" && filePath) {
      const fileName = filePath.split("/").pop() ?? filePath
      return fileName + (filePath.includes("/") ? `  ·  ${filePath}` : "")
    }
  }
  if (lower === "agent") {
    const prompt = input.prompt
    if (typeof prompt === "string" && prompt) {
      const firstLine = prompt.split("\n").map((line) => line.trim()).find((line) => line.length > 0)
      if (firstLine) return truncate(firstLine, 80)
    }
  }
  const raw = (inputRaw ?? "").trim()
  if (!raw) return "…"
  return truncate(raw, 80)
}

/**
 * formatJson
 * 参数：inputRaw 原始字符串
 * 核心流程：可解析则两空格缩进格式化，否则原样返回
 */
export function formatJson(inputRaw: string | undefined): string {
  if (!inputRaw) return "{}"
  try {
    return JSON.stringify(JSON.parse(inputRaw), null, 2)
  } catch {
    return inputRaw
  }
}

/**
 * truncate
 * 参数：text 原文；limit 字符上限
 * 核心流程：超长截断并补省略号
 */
function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) + "…" : text
}
