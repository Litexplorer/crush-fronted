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
 * getWorkspace
 * 参数：id workspace ID
 * 核心流程：GET /workspaces/{id}，返回单个 workspace 详情（会话页据此展示项目路径）
 */
export async function getWorkspace(id: string): Promise<Workspace> {
  return httpGet<Workspace>(`/workspaces/${encodeURIComponent(id)}`)
}

/**
 * createWorkspace
 * 参数：input.path 项目的绝对路径；input.yolo 该项目的 YOLO 开关（可选，服务端据此初始化权限模式）
 * 核心流程：POST /workspaces，body 自动附带持久化 client_id；
 *           仅在本地有 YOLO 缓存时附带 yolo，避免覆盖服务端默认值
 */
export async function createWorkspace(input: { path: string; yolo?: boolean }): Promise<Workspace> {
  const body: Record<string, unknown> = {
    path: input.path,
    client_id: getClientId(),
  }
  if (typeof input.yolo === "boolean") body.yolo = input.yolo
  return httpPost<Workspace>("/workspaces", body)
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

/** 对应后端 internal/proto/proto.go 的 Project：落盘的项目记录，无进程态 */
export interface Project {
  path: string
  data_dir: string
  last_accessed: string
}

/**
 * listProjects
 * 参数：无
 * 核心流程：GET /projects，返回服务端落盘记住的项目；后端可能返回 null，归一为空数组
 */
export async function listProjects(): Promise<Project[]> {
  const data = await httpGet<Project[] | null>("/projects")
  return data ?? []
}

/**
 * forgetProjectOnServer
 * 参数：path 项目绝对路径
 * 核心流程：DELETE /projects?path=，把项目从服务端记录移除（项目数据目录不动）
 */
export async function forgetProjectOnServer(path: string): Promise<void> {
  await httpDelete(`/projects?path=${encodeURIComponent(path)}`)
}
