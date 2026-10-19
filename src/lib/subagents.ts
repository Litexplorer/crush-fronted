/**
 * subagents.ts
 * 核心流程：子 agent 工具的数据解析 ——
 *           childSessionId     按后端约定拼出子会话 ID（messageID$$toolCallID）
 *           parseSubagentPrompt 从 tool_call input 读取 prompt
 *           parseSubagentMeta   解析 tool_result.metadata 里的结构化信息
 *           subagentTitle       从 prompt 首个非空行生成可读标题
 *           loadSubagent        读取子会话信息 + 历史消息
 */
import { getSession, listMessages, type Session, type SessionMessage } from "./sessions"

export interface SubagentMeta {
  session_id?: string
  title?: string
  model?: string
  provider?: string
  duration_ms?: number
}

export interface SubagentSnapshot {
  session: Session
  messages: SessionMessage[]
}

/**
 * childSessionId
 * 参数：messageId 父 assistant 消息 ID；toolCallId 工具调用 ID
 * 核心流程：与 internal/session.CreateAgentToolSessionID 保持同一格式
 */
export function childSessionId(messageId: string, toolCallId: string): string {
  return `${messageId}$$${toolCallId}`
}

/**
 * parseSubagentPrompt
 * 参数：inputRaw agent tool_call 的 input JSON
 * 核心流程：解析 prompt 字段；失败返回空串
 */
export function parseSubagentPrompt(inputRaw: string | undefined): string {
  if (!inputRaw) return ""
  try {
    const data = JSON.parse(inputRaw) as { prompt?: unknown }
    return typeof data.prompt === "string" ? data.prompt : ""
  } catch {
    return ""
  }
}

/**
 * parseSubagentMeta
 * 参数：metadata tool_result.metadata 字符串
 * 核心流程：解析后端附加的 session_id/title/model/duration_ms；失败返回空对象
 */
export function parseSubagentMeta(metadata: string | undefined): SubagentMeta {
  if (!metadata) return {}
  try {
    const data = JSON.parse(metadata) as Record<string, unknown>
    const meta: SubagentMeta = {}
    if (typeof data.session_id === "string") meta.session_id = data.session_id
    if (typeof data.title === "string") meta.title = data.title
    if (typeof data.model === "string") meta.model = data.model
    if (typeof data.provider === "string") meta.provider = data.provider
    if (typeof data.duration_ms === "number") meta.duration_ms = data.duration_ms
    return meta
  } catch {
    return {}
  }
}

/**
 * subagentTitle
 * 参数：prompt 子 agent 任务文本；fallback 无有效首行时的标题
 * 核心流程：跳过空行与 Markdown 列表/标题前缀，截断到 72 字符；
 *           标题生成任务类描述仍写成 "Sub-agent"
 */
export function subagentTitle(prompt: string, fallback = "Sub-agent"): string {
  for (const rawLine of prompt.split("\n")) {
    const line = rawLine.trim().replace(/^[#>*\-\s]+/, "").trim()
    if (!line) continue
    return line.length > 72 ? line.slice(0, 72) + "…" : line
  }
  return fallback
}

/**
 * loadSubagent
 * 参数：wsId workspace ID；sessionId 子会话 ID
 * 核心流程：并行读取子会话信息与全部消息，供卡片首次展开使用
 */
export async function loadSubagent(wsId: string, sessionId: string): Promise<SubagentSnapshot> {
  const [session, messages] = await Promise.all([getSession(wsId, sessionId), listMessages(wsId, sessionId)])
  return { session, messages }
}
