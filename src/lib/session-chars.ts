/**
 * session-chars.ts
 * 核心流程：会话字符数统计 ——
 *           charsOfMessage  单条消息按分片统计字符数（text / reasoning / tool_call / tool_result）
 *           sessionChars    汇总整段会话：用户 / 助手 / 思维链 / 工具输出
 *           口径：正文只取可见 text 分片（hidden 注入不计），压缩摘要消息整条跳过避免与原文重复计；
 *                 以消息对象为 WeakMap 键，SSE 每次换新对象只重算变动的那条，其余命中缓存
 */
import type { SessionMessage } from "./sessions"
import { countChars } from "./usage"

/** 会话字符数分项与总计（单位：字符，按 Unicode 码点计，emoji 记 1） */
export interface SessionChars {
  total: number
  user: number
  assistant: number
  reasoning: number
  tool: number
}

const cache = new WeakMap<SessionMessage, SessionChars>()

/**
 * charsOfMessage
 * 参数：message 会话消息
 * 核心流程：遍历分片累计 text / thinking / 工具入参 / 工具结果字符数 →
 *           按角色把正文归入用户或助手 → 写入 WeakMap 缓存并返回
 */
function charsOfMessage(message: SessionMessage): SessionChars {
  const hit = cache.get(message)
  if (hit) return hit
  let text = 0
  let reasoning = 0
  let tool = 0
  for (const part of message.parts) {
    const data = (part.data ?? {}) as {
      text?: string
      hidden?: boolean
      thinking?: string
      input?: string
      content?: string
    }
    switch (part.type) {
      case "text":
        // hidden 分片是上下文注入，用户看不到，不计入字符数
        if (data.hidden === true || typeof data.text !== "string") break
        text += countChars(data.text)
        break
      case "reasoning":
        if (typeof data.thinking === "string") reasoning += countChars(data.thinking)
        break
      case "tool_call":
        if (typeof data.input === "string") tool += countChars(data.input)
        break
      case "tool_result":
        if (typeof data.content === "string") tool += countChars(data.content)
        break
    }
  }
  const entry: SessionChars = {
    total: text + reasoning + tool,
    user: message.role === "user" ? text : 0,
    assistant: message.role === "user" ? 0 : text,
    reasoning,
    tool,
  }
  cache.set(message, entry)
  return entry
}

/**
 * sessionChars
 * 参数：messages 当前已加载的消息（分页加载，未翻到的历史不计入）
 * 核心流程：逐条取缓存后的分项并累加，跳过压缩摘要消息
 */
export function sessionChars(messages: SessionMessage[]): SessionChars {
  const sum: SessionChars = { total: 0, user: 0, assistant: 0, reasoning: 0, tool: 0 }
  for (const message of messages) {
    if (message.is_summary_message) continue
    const item = charsOfMessage(message)
    sum.total += item.total
    sum.user += item.user
    sum.assistant += item.assistant
    sum.reasoning += item.reasoning
    sum.tool += item.tool
  }
  return sum
}
