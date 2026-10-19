/**
 * workspaces.ts
 * 核心流程：workspace 三个接口的对接层 ——
 *           listWorkspaces   GET  /workspaces
 *           createWorkspace  POST /workspaces（body 带 client_id）
 *           deleteWorkspace  DELETE /workspaces/{id}?client_id=
 */
import { httpDelete, httpGet, httpPost } from "./http"
import { getClientId } from "./clientId"

/** 对应后端 internal/proto/proto.go 的 Workspace，UI 只声明读取的字段，其余留空 */
export interface Workspace {
  id: string
  path: string
  data_dir?: string
  version?: string
  yolo?: boolean
  debug?: boolean
  client_id?: string
  env?: string[]
  channels?: string[]
}

/**
 * listWorkspaces
 * 参数：无
 * 核心流程：GET /workspaces，返回 proto.Workspace[]；后端可能返回 null，归一为空数组
 */
export async function listWorkspaces(): Promise<Workspace[]> {
  const data = await httpGet<Workspace[] | null>("/workspaces")
  return data ?? []
}

/**
 * createWorkspace
 * 参数：input.path 项目的绝对路径
 * 核心流程：POST /workspaces，body 自动附带持久化 client_id，返回创建（或幂等命中）的 workspace
 */
export async function createWorkspace(input: { path: string }): Promise<Workspace> {
  return httpPost<Workspace>("/workspaces", {
    path: input.path,
    client_id: getClientId(),
  })
}

/**
 * deleteWorkspace
 * 参数：id workspace ID
 * 核心流程：DELETE /workspaces/{id}，client_id 走查询参数（requireClientID 校验 UUID）
 */
export async function deleteWorkspace(id: string): Promise<void> {
  const cid = encodeURIComponent(getClientId())
  await httpDelete(`/workspaces/${encodeURIComponent(id)}?client_id=${cid}`)
}
