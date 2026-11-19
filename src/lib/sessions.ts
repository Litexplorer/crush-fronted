/**
 * sessions.ts
 * 核心流程：会话四个接口的对接层 ——
 *           listSessions   GET  /workspaces/{id}/sessions
 *           createSession  POST /workspaces/{id}/sessions（后端只读取 title 字段）
 *           getSession     GET  /workspaces/{id}/sessions/{sid}
 *           renameSession  PUT  /workspaces/{id}/sessions/{sid}/title
 *           listMessages   GET  /workspaces/{id}/sessions/{sid}/messages
 *           listMessagesPage 同接口的 limit/before 分页版（X-Has-More 标记还有更早历史）
 */
import { httpGet, httpGetResult, httpPost, httpPut } from "./http"

/**
 * COMPACT_TIMEOUT_MS
 * 压缩接口的专用超时：compress 是同步等待大模型生成整段摘要，
 * 线上实测 29~46s，用默认 20s 会先掐断请求再误报「请求超时，请重试」
 */
const COMPACT_TIMEOUT_MS = 10 * 60 * 1000

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
  /** prompt 缓存累计（老服务端不返回，缺省按 0 处理） */
  cache_read_tokens?: number
  cache_write_tokens?: number
  uncached_input_tokens?: number
  summary_message_id: string
  /** 首条 user 消息首行：会话列表的副标题（老服务端不返回该字段） */
  subtitle?: string
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
 * renameSession
 * 参数：wsId workspace ID；sid 会话 ID；title 新标题（调用方 trim 过、非空）
 * 核心流程：PUT /workspaces/{wsId}/sessions/{sid}/title —— 后端只更新 title，
 *           不动用量/成本/todos；标题变更再经 SSE session 事件推给其他客户端
 */
export async function renameSession(wsId: string, sid: string, title: string): Promise<Session> {
  return httpPut<Session>(`/workspaces/${encodeURIComponent(wsId)}/sessions/${encodeURIComponent(sid)}/title`, {
    title,
  })
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

/** 分页参数：limit 取多少条，before 从哪条消息往前翻（空表示最新一页） */
export interface MessagePageOptions {
  limit: number
  before?: string
  signal?: AbortSignal
}

/** 一页消息 + 是否还有更早的历史（后端用 X-Has-More 响应头标记） */
export interface MessagePage {
  messages: SessionMessage[]
  hasMore: boolean
}

/**
 * listMessagesPage
 * 参数：wsId workspace ID；sid 会话 ID；opts.limit 页大小；opts.before 游标消息 ID；opts.signal 取消
 * 核心流程：GET .../messages?limit=&before= → 读 X-Has-More 判断是否还有更早的历史，
 *           避免一次把几十 MB 的工具输出全量拉到前端
 */
export async function listMessagesPage(wsId: string, sid: string, opts: MessagePageOptions): Promise<MessagePage> {
  const query = new URLSearchParams({ limit: String(opts.limit) })
  if (opts.before) query.set("before", opts.before)
  const result = await httpGetResult<SessionMessage[] | null>(
    `/workspaces/${encodeURIComponent(wsId)}/sessions/${encodeURIComponent(sid)}/messages?${query.toString()}`,
    { signal: opts.signal },
  )
  return {
    messages: result.data ?? [],
    hasMore: result.headers.get("X-Has-More") === "true",
  }
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
    // 压缩要把整段会话重新喂给大模型，线上实测 29~46s，默认 20s 必然误报「请求超时」
    { timeoutMs: COMPACT_TIMEOUT_MS },
  )
}
