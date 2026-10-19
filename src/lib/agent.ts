/**
 * agent.ts
 * 核心流程：agent 链路六个接口的对接层 ——
 *           initAgent         POST /workspaces/{id}/agent/init（body 可选，成功 200 无响应体）
 *           getAgent          GET  /workspaces/{id}/agent → proto.AgentInfo
 *           sendMessage       POST /workspaces/{id}/agent（202 受理，run 与 HTTP 连接解耦，输出走 SSE）
 *           cancel            POST /workspaces/{id}/agent/sessions/{sid}/cancel
 *           runShell          POST /workspaces/{id}/agent/sessions/{sid}/shell → proto.ShellCommandResponse
 *           setCurrentSession POST /workspaces/{id}/current-session?client_id=（空 session_id 即清除）
 */
import { httpGet, httpPost } from "./http"
import { getClientId, randomUuid } from "./clientId"

/** 对应 proto.AgentInfo（internal/proto/proto.go），UI 只读取就绪/忙碌与模型名 */
export interface AgentInfo {
  is_busy: boolean
  is_ready: boolean
  model: { id: string; name: string }
  model_cfg: { model?: string; provider?: string; reasoning_effort?: string }
}

/** 附件引用：后端按 file_path 读取内容（见 backend/files.go），前端只需传路径 */
export interface AgentAttachment {
  file_path: string
  file_name?: string
}

/** POST /agent 请求体，对应 proto.AgentMessage（后端只解码需要的字段） */
export interface SendMessageInput {
  session_id: string
  prompt: string
  run_id: string
  attachments?: AgentAttachment[]
}

/**
 * newRunId
 * 参数：无
 * 核心流程：生成本次 agent run 的关联 ID，后端原样 echo 回 RunComplete 事件
 */
export function newRunId(): string {
  return randomUuid()
}

/**
 * initAgent
 * 参数：wsId workspace ID；interactive 是否交互模式（本阶段固定 false）
 * 核心流程：POST /agent/init 触发 agent 初始化；后端不返回响应体，仅以状态码表示成败
 */
export async function initAgent(wsId: string, interactive = false): Promise<void> {
  await httpPost(`/workspaces/${encodeURIComponent(wsId)}/agent/init`, { interactive })
}

/**
 * getAgent
 * 参数：wsId workspace ID
 * 核心流程：GET /agent，返回工作区级 AgentInfo（is_ready / is_busy / 当前模型）
 */
export async function getAgent(wsId: string): Promise<AgentInfo> {
  return httpGet<AgentInfo>(`/workspaces/${encodeURIComponent(wsId)}/agent`)
}

/**
 * sendMessage
 * 参数：wsId workspace ID；input 携带 session_id / prompt / run_id
 * 核心流程：POST /agent（handlePostWorkspaceAgent），202 表示受理；
 *           run 生命周期绑定 workspace 而非本次 HTTP 连接，结束信号为 SSE 的 run_complete
 */
export async function sendMessage(wsId: string, input: SendMessageInput): Promise<void> {
  await httpPost(`/workspaces/${encodeURIComponent(wsId)}/agent`, {
    session_id: input.session_id,
    run_id: input.run_id,
    prompt: input.prompt,
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  })
}

/**
 * cancel
 * 参数：wsId workspace ID；sid 会话 ID
 * 核心流程：POST /agent/sessions/{sid}/cancel，中断该会话在跑的 run；
 *           handler 不读请求体，传空对象仅为满足 POST 形参
 */
export async function cancel(wsId: string, sid: string): Promise<void> {
  await httpPost(`/workspaces/${encodeURIComponent(wsId)}/agent/sessions/${encodeURIComponent(sid)}/cancel`, {})
}

/** 对应 proto.ShellCommandResponse：stdout/stderr 合并后的输出 + 退出码（无独立 stderr 字段） */
export interface ShellCommandResponse {
  output: string
  exit_code: number
}

/**
 * runShell
 * 参数：wsId workspace ID；sid 会话 ID；command 待执行的 shell 命令
 * 核心流程：POST agent/sessions/{sid}/shell（handlePostWorkspaceAgentSessionShell），
 *           后端在工作区目录同步执行并返回合并输出与退出码
 */
export async function runShell(wsId: string, sid: string, command: string): Promise<ShellCommandResponse> {
  return httpPost<ShellCommandResponse>(
    `/workspaces/${encodeURIComponent(wsId)}/agent/sessions/${encodeURIComponent(sid)}/shell`,
    { session_id: sid, command },
  )
}

/**
 * setCurrentSession
 * 参数：wsId workspace ID；sid 当前查看的会话 ID，null 表示清除（回到落地页语义）
 * 核心流程：POST /current-session?client_id=（requireClientID 校验 UUID），
 *           permission/question 等会话作用域事件按此路由投递
 */
export async function setCurrentSession(wsId: string, sid: string | null): Promise<void> {
  const cid = encodeURIComponent(getClientId())
  await httpPost(`/workspaces/${encodeURIComponent(wsId)}/current-session?client_id=${cid}`, {
    session_id: sid ?? "",
  })
}
