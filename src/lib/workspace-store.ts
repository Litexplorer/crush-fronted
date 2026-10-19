/**
 * workspace-store.ts
 * 核心流程：全局选中 workspace 状态（模块级 signal）+ 最近项目路径持久化 ——
 *           首页选中后写入（URL 同步 /w/:id），会话页/后续页面直接读取；
 *           crush server 重启后 workspace id 失效，靠持久化路径自动重建
 */
import { createSignal } from "solid-js"
import type { Workspace } from "./workspaces"

const WORKSPACE_PATH_KEY = "crush.workspace.path"

const [selectedWorkspace, setSelectedWorkspace] = createSignal<Workspace | undefined>(undefined)

/**
 * rememberWorkspace
 * 参数：ws 当前选中的工作区
 * 核心流程：把路径写入 localStorage，供服务重启后按路径重建工作区
 */
export function rememberWorkspace(ws: Workspace) {
  try {
    localStorage.setItem(WORKSPACE_PATH_KEY, ws.path)
  } catch {
    // localStorage 不可用：跳过恢复能力
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
