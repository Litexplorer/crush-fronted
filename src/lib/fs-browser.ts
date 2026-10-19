/**
 * fs-browser.ts
 * 核心流程：文件系统目录浏览接口对接层 ——
 *           listDirs GET /v1/fs/dirs?path=<绝对路径>
 *           返回当前目录、父目录与子目录列表，供 Open project 路径补全
 */
import { httpGet } from "./http"

/** 单个目录条目（后端已过滤为目录） */
export interface FsDirEntry {
  name: string
  path: string
  is_dir: boolean
  size: number
}

/** 目录列表响应 */
export interface FsDirList {
  path: string
  parent: string
  entries: FsDirEntry[]
}

/**
 * listDirs
 * 参数：path 绝对目录；为空时后端回退到用户主目录
 * 核心流程：GET /fs/dirs → 返回目录列表；失败抛出 ApiError 由调用方静默处理
 */
export async function listDirs(path?: string): Promise<FsDirList> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ""
  return httpGet<FsDirList>(`/fs/dirs${query}`)
}
