/**
 * workspace-store.ts
 * 核心流程：全局选中 workspace 状态（模块级 signal）+ 最近项目路径持久化 ——
 *           首页选中后写入（URL 同步 /w/:id），会话页/后续页面直接读取；
 *           crush server 重启后 workspace id 失效，靠持久化路径自动重建
 */
import { createSignal } from "solid-js"
import type { Workspace } from "./workspaces"

const WORKSPACE_PATH_KEY = "crush.workspace.path"
const RECENT_PROJECTS_KEY = "crush.projects"
const YOLO_KEY = "crush.workspace.yolo"
const MAX_RECENT_PROJECTS = 20

const [selectedWorkspace, setSelectedWorkspace] = createSignal<Workspace | undefined>(undefined)

/**
 * rememberWorkspace
 * 参数：ws 当前选中的工作区
 * 核心流程：路径写入最近项目列表 + 上次打开路径，供服务重启后按路径重建
 */
export function rememberWorkspace(ws: Workspace) {
  rememberProject(ws.path)
  try {
    localStorage.setItem(WORKSPACE_PATH_KEY, ws.path)
  } catch {
    // localStorage 不可用：跳过恢复能力
  }
}

/**
 * recentProjectPaths
 * 参数：无
 * 核心流程：读取本地最近项目路径，过滤非字符串/空值并去重，最多保留 20 条
 */
export function recentProjectPaths(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_PROJECTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const paths: string[] = []
    for (const item of parsed) {
      if (typeof item !== "string" || item === "" || seen.has(item)) continue
      seen.add(item)
      paths.push(item)
    }
    return paths.slice(0, MAX_RECENT_PROJECTS)
  } catch {
    return []
  }
}

/**
 * rememberProject
 * 参数：path 项目绝对路径
 * 核心流程：插到最近项目首位并去重截断；存储失败时仅本次会话可用
 */
export function rememberProject(path: string) {
  if (!path) return
  try {
    const next = [path, ...recentProjectPaths().filter((item) => item !== path)].slice(0, MAX_RECENT_PROJECTS)
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next))
  } catch {
    // localStorage 不可用：跳过持久化
  }
}

/**
 * forgetProject
 * 参数：path 要移除的项目路径
 * 核心流程：从最近项目列表剔除（删除项目时调用，避免刷新后重新出现）
 */
export function forgetProject(path: string) {
  try {
    const next = recentProjectPaths().filter((item) => item !== path)
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next))
    // 被删除的是上次打开的项目：一并清掉恢复路径，避免下次启动又重建已删项目
    if (localStorage.getItem(WORKSPACE_PATH_KEY) === path) localStorage.removeItem(WORKSPACE_PATH_KEY)
  } catch {
    // localStorage 不可用：跳过持久化
  }
}

/**
 * readYoloMap
 * 参数：无
 * 核心流程：读取按项目路径归键的 YOLO 缓存；脏数据/存储不可用时返回空表
 */
function readYoloMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(YOLO_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (path && typeof value === "boolean") out[path] = value
    }
    return out
  } catch {
    return {}
  }
}

/**
 * recalledYolo
 * 参数：path 项目绝对路径
 * 核心流程：读取该项目上次的 YOLO 开关；无记录（或路径为空）返回 undefined，交给服务端判定
 */
export function recalledYolo(path: string): boolean | undefined {
  if (!path) return undefined
  return readYoloMap()[path]
}

/**
 * rememberYolo
 * 参数：path 项目绝对路径；yolo 当前 YOLO 开关
 * 核心流程：按项目路径把开关写入本地缓存，使 workspace 被回收重建后仍能回填 YOLO
 */
export function rememberYolo(path: string, yolo: boolean) {
  if (!path) return
  try {
    const map = readYoloMap()
    map[path] = yolo
    localStorage.setItem(YOLO_KEY, JSON.stringify(map))
  } catch {
    // localStorage 不可用：跳过缓存，仅影响重建后的状态恢复
  }
}

/**
 * recalledWorkspacePath
 * 参数：无
 * 核心流程：读取上次打开的工程路径；无记录返回 undefined
 */
export function recalledWorkspacePath(): string | undefined {
  try {
    return localStorage.getItem(WORKSPACE_PATH_KEY) ?? undefined
  } catch {
    return undefined
  }
}

export { selectedWorkspace, setSelectedWorkspace }
