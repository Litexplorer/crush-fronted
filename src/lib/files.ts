/**
 * files.ts
 * 核心流程：workspace 文件目录接口对接层 ——
 *           listWorkspaceFiles GET /workspaces/{id}/files?path=<相对目录>&depth=<层数>
 *           返回 proto.FileEntry{name,path,is_dir,size}；
 *           depth=1 只列当前一层，depth>1 由后端递归拉平成同一结构；
 *           后端不提供读取任意文件内容的接口，文件条目仅展示元信息
 */
import { httpGet } from "./http"

/** 对应 internal/proto/files.go 的 proto.FileEntry；path 相对 workspace 工作目录 */
export interface FileEntry {
  name: string
  path: string
  is_dir: boolean
  size: number
}

/**
 * listWorkspaceFiles
 * 参数：wsId workspace ID；dir 相对目录（空串表示根目录）；depth 递归层数（1 或不传为单层）
 * 核心流程：GET /workspaces/{wsId}/files?path=dir&depth=N → 返回文件列表（递归时扁平、path 仍相对根）；
 *           后端可能返回 null，归一为空数组
 */
export async function listWorkspaceFiles(wsId: string, dir = "", depth = 1): Promise<FileEntry[]> {
  const params = new URLSearchParams()
  if (dir) params.set("path", dir)
  if (depth > 1) params.set("depth", String(depth))
  const qs = params.toString()
  const data = await httpGet<FileEntry[] | null>(
    `/workspaces/${encodeURIComponent(wsId)}/files${qs ? `?${qs}` : ""}`,
  )
  return data ?? []
}
