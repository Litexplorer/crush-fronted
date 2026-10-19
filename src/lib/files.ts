/**
 * files.ts
 * 核心流程：workspace 文件目录接口对接层 ——
 *           listWorkspaceFiles GET /workspaces/{id}/files?path=<相对目录>
 *           返回 proto.FileEntry{name,path,is_dir,size}；
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
 * 参数：wsId workspace ID；dir 相对目录（空串表示根目录）
 * 核心流程：GET /workspaces/{wsId}/files?path=dir → 返回目录下条目列表；
 *           后端可能返回 null，归一为空数组
 */
export async function listWorkspaceFiles(wsId: string, dir = ""): Promise<FileEntry[]> {
  const query = dir ? `?path=${encodeURIComponent(dir)}` : ""
  const data = await httpGet<FileEntry[] | null>(
    `/workspaces/${encodeURIComponent(wsId)}/files${query}`,
  )
  return data ?? []
}
