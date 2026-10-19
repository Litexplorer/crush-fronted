/**
 * sessions.ts
 * 核心流程：会话四个接口的对接层 ——
 *           listSessions   GET  /workspaces/{id}/sessions
 *           createSession  POST /workspaces/{id}/sessions（后端只读取 title 字段）
 *           getSession     GET  /workspaces/{id}/sessions/{sid}
 *           listMessages   GET  /workspaces/{id}/sessions/{sid}/messages
 */
import { httpGet, httpPost } from "./http"

/** 会话 todo 条目，对应 proto.Todo */
export interface SessionTodo {
  content: string
  status: string
  active_form: string
  parent?: string
}

/** 对应 internal/proto/session.go 的 proto.Session；created_at/updated_at 为 Unix 秒 */
export interface Session {
  id: string
  parent_session_id: string
  title: string
  message_count: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  summary_message_id: string
  cost: number
  todos?: SessionTodo[]
  channel?: string
  created_at: number
  updated_at: number
  is_busy: boolean
  attached_clients: number
}

/** 消息角色，对应 proto.MessageRole */
export type MessageRole = "assistant" | "user" | "system" | "tool"

/**
 * 消息内容分片：线上格式为 {type,data} 包装（text/reasoning/tool_call/
 * tool_result/finish…），data 结构随 type 变化，本阶段保持 unknown
 */
export interface ContentPart {
  type: string
  data: unknown
}

/** 对应 internal/proto/message.go 的 proto.Message；parts 经 MarshalJSON 包装为 {type,data} 数组 */
export interface SessionMessage {
  id: string
  role: MessageRole
  session_id: string
  parts: ContentPart[]
  model: string
  provider: string
  created_at: number
  updated_at: number
  is_summary_message?: boolean
}

/** 创建会话请求体；后端 handlePostWorkspaceSessions 只解码 title */
export interface CreateSessionInput {
  title?: string
}

/**
 * listSessions
 * 参数：wsId workspace ID
 * 核心流程：GET /workspaces/{wsId}/sessions，返回 proto.Session[]；后端可能返回 null，归一为空数组
 */
export async function listSessions(wsId: string): Promise<Session[]> {
  const data = await httpGet<Session[] | null>(`/workspaces/${encodeURIComponent(wsId)}/sessions`)
  return data ?? []
}

/**
 * createSession
 * 参数：wsId workspace ID；input.title 可选会话标题
 * 核心流程：POST /workspaces/{wsId}/sessions，body 携带 title（允许空串），返回创建出的会话
 */
export async function createSession(wsId: string, input: CreateSessionInput = {}): Promise<Session> {
  return httpPost<Session>(`/workspaces/${encodeURIComponent(wsId)}/sessions`, {
    title: input.title ?? "",
  })
}

/**
 * getSession
 * 参数：wsId workspace ID；sid 会话 ID
 * 核心流程：GET /workspaces/{wsId}/sessions/{sid}，返回单个会话
 */
export async function getSession(wsId: string, sid: string): Promise<Session> {
  return httpGet<Session>(`/workspaces/${encodeURIComponent(wsId)}/sessions/${encodeURIComponent(sid)}`)
}

/**
 * listMessages
 * 参数：wsId workspace ID；sid 会话 ID
 * 核心流程：GET /workspaces/{wsId}/sessions/{sid}/messages，返回 proto.Message[]；归一为空数组
 */
export async function listMessages(wsId: string, sid: string): Promise<SessionMessage[]> {
  const data = await httpGet<SessionMessage[] | null>(
    `/workspaces/${encodeURIComponent(wsId)}/sessions/${encodeURIComponent(sid)}/messages`,
  )
  return data ?? []
}

/**
 * summarizeSession
 * 参数：wsId workspace ID；sid 会话 ID
 * 核心流程：POST /workspaces/{wsId}/agent/sessions/{sid}/summarize 触发会话压缩；
 *           接口同步等待摘要生成完成，摘要消息通过 SSE message 事件增量推送
 */
export async function summarizeSession(wsId: string, sid: string): Promise<void> {
  await httpPost(
    `/workspaces/${encodeURIComponent(wsId)}/agent/sessions/${encodeURIComponent(sid)}/summarize`,
    {},
  )
}
