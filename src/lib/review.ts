/**
 * review.ts
 * 核心流程：Review 面板两个接口的对接层 ——
 *           listSessionTrackedFiles GET /workspaces/{id}/sessions/{sid}/filetracker/files → string[]
 *               （后端 Backend.FileTrackerListReadFiles 返回 []string，仅文件路径，无状态/版本/时间字段）
 *           listSessionFileHistory  GET /workspaces/{id}/sessions/{sid}/history → 会话文件历史版本列表
 *               （后端直接序列化 history.File，无 json tag → 键为 PascalCase；
 *                 若走 client 代理路径则为 proto.File snake_case，这里两种形状都归一）
 */
import { httpGet } from "./http"

/** 历史文件版本（归一化后的 proto.File / history.File 形状） */
export interface HistoryFile {
  id: string
  session_id: string
  path: string
  content: string
  version: number
  created_at: number
  updated_at: number
}

/**
 * listSessionTrackedFiles
 * 参数：wsId workspace ID；sid 会话 ID
 * 核心流程：GET filetracker/files → 会话内被读取/写入过的文件路径列表；
 *           后端可能返回 null，归一为空数组
 */
export async function listSessionTrackedFiles(wsId: string, sid: string): Promise<string[]> {
  const data = await httpGet<string[] | null>(
    `/workspaces/${encodeURIComponent(wsId)}/sessions/${encodeURIComponent(sid)}/filetracker/files`,
  )
  return Array.isArray(data) ? data.filter((p): p is string => typeof p === "string") : []
}

/**
 * firstString
 * 参数：values 候选值序列
 * 核心流程：返回第一个 string 类型的值（用于兼容 PascalCase / snake_case 双形状）
 */
function firstString(...values: unknown[]): string {
  for (const v of values) if (typeof v === "string") return v
  return ""
}

/**
 * firstNumber
 * 参数：values 候选值序列
 * 核心流程：返回第一个有限数值类型的值，兜底 0
 */
function firstNumber(...values: unknown[]): number {
  for (const v of values) if (typeof v === "number" && Number.isFinite(v)) return v
  return 0
}

/**
 * normalizeHistoryFile
 * 参数：raw 单条历史记录（形状未知）
 * 核心流程：兼容 history.File（PascalCase 键）与 proto.File（snake_case 键）两种序列化形状，
 *           缺 path 的记录视为脏数据丢弃
 */
function normalizeHistoryFile(raw: unknown): HistoryFile | null {
  if (typeof raw !== "object" || raw === null) return null
  const r = raw as Record<string, unknown>
  const path = firstString(r.path, r.Path)
  if (!path) return null
  return {
    id: firstString(r.id, r.ID),
    session_id: firstString(r.session_id, r.SessionID),
    path,
    content: firstString(r.content, r.Content),
    version: firstNumber(r.version, r.Version),
    created_at: firstNumber(r.created_at, r.CreatedAt),
    updated_at: firstNumber(r.updated_at, r.UpdatedAt),
  }
}

/**
 * listSessionFileHistory
 * 参数：wsId workspace ID；sid 会话 ID
 * 核心流程：GET history → 逐条归一化并丢弃无法解析的记录，返回按 updated_at 升序的版本列表
 */
export async function listSessionFileHistory(wsId: string, sid: string): Promise<HistoryFile[]> {
  const data = await httpGet<unknown[] | null>(
    `/workspaces/${encodeURIComponent(wsId)}/sessions/${encodeURIComponent(sid)}/history`,
  )
  if (!Array.isArray(data)) return []
  return data
    .map(normalizeHistoryFile)
    .filter((f): f is HistoryFile => f !== null)
    .sort((a, b) => a.updated_at - b.updated_at)
}
