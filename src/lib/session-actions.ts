/**
 * session-actions.ts
 * 核心流程：新建会话的唯一入口 ——
 *           rebuildWorkspace  按项目路径重建 workspace（服务端重启后 id 失效时用）
 *           newSession        先用已知 workspace id 建会话（快速路径），失败再重建重试；
 *                             成功后按 replaceSessionId 决定「顶替当前标签位」还是「追加标签」
 *           sessionUrl        会话页地址（标题栏、首页共用）
 */
import { createSession } from "./sessions"
import { createWorkspace } from "./workspaces"
import { recalledYolo, rememberWorkspace, selectedWorkspace, setSelectedWorkspace } from "./workspace-store"
import { ensureSessionTab, replaceSessionTab, retargetSessionTabs, type ActiveSession } from "./ui-store"

/** 会话页地址 */
export function sessionUrl(tab: ActiveSession): string {
  return `/w/${encodeURIComponent(tab.workspaceId)}/session/${encodeURIComponent(tab.id)}`
}

export interface NewSessionOptions {
  /** 已知的 workspace id（当前标签记录值），优先复用以免多一次解析往返 */
  workspaceId?: string
  /** 项目路径：workspace 失效时按路径重建，也是新标签的归属项目 */
  projectPath?: string
  /** 被替换的会话 id：新会话占据该标签位；缺省时追加新标签 */
  replaceSessionId?: string
}

export type NewSessionResult =
  | { ok: true; tab: ActiveSession }
  | { ok: false; error: string }

/**
 * rebuildWorkspace
 * 参数：path 项目路径
 * 核心流程：POST /workspaces 重建工作区 → 记住并设为当前选中 → 同路径标签批量换新 id；
 *           失败返回 undefined，由调用方决定错误文案
 */
async function rebuildWorkspace(path: string): Promise<string | undefined> {
  try {
    const ws = await createWorkspace({ path, yolo: recalledYolo(path) })
    rememberWorkspace(ws)
    setSelectedWorkspace(ws)
    retargetSessionTabs(path, ws.id)
    return ws.id
  } catch {
    return undefined
  }
}

/**
 * ensureLiveWorkspace
 * 参数：path 项目路径；fallbackId 标签里记录的 workspace id
 * 核心流程：当前选中的工作区路径一致时直接复用；
 *           否则按路径重建/幂等获取工作区，并批量刷新同路径标签的 id
 */
export async function ensureLiveWorkspace(path: string | undefined, fallbackId: string | undefined): Promise<string | undefined> {
  const current = selectedWorkspace()
  if (path && current?.path === path) return current.id
  if (path) {
    try {
      const ws = await createWorkspace({ path, yolo: recalledYolo(path) })
      rememberWorkspace(ws)
      setSelectedWorkspace(ws)
      retargetSessionTabs(path, ws.id)
      return ws.id
    } catch {
      // 路径已不可用：退回标签记录的 id，由会话页给出具体错误
    }
  }
  return fallbackId
}

/** 从抛出的错误对象中安全取 message（与首页 toast 保持一致） */
function errorMessage(err: unknown): string {
  const e = err as { message?: string }
  return e?.message ?? "Unknown error"
}

/**
 * newSession
 * 参数：options 见 NewSessionOptions
 * 核心流程：解析 workspace（已知 id 优先，缺失才重建）→ POST 建会话 →
 *           会话失效消息时按路径重建并重试一次 → 登记标签（替换位或追加）→ 返回新标签
 */
export async function newSession(options: NewSessionOptions = {}): Promise<NewSessionResult> {
  const path = options.projectPath
  let wsId = options.workspaceId || selectedWorkspace()?.id

  // 没有可用 workspace id：先按路径重建，避免直接打无效请求
  if (!wsId) {
    if (!path) return { ok: false, error: "Workspace unavailable" }
    wsId = await rebuildWorkspace(path)
    if (!wsId) return { ok: false, error: "Workspace unavailable" }
  }

  let created
  try {
    created = await createSession(wsId)
  } catch (err) {
    // 服务端重启后 workspace 已不在内存：按路径重建一次再重试
    const message = errorMessage(err)
    const rebuilt = path && /workspace not found/i.test(message) ? await rebuildWorkspace(path) : undefined
    if (!rebuilt) return { ok: false, error: message }
    wsId = rebuilt
    try {
      created = await createSession(wsId)
    } catch (retryErr) {
      return { ok: false, error: errorMessage(retryErr) }
    }
  }

  const tab: ActiveSession = {
    id: created.id,
    title: created.title || "Untitled",
    workspaceId: wsId,
    projectPath: path,
  }

  // 登记标签：有替换目标时顶替其位置，否则追加（旧标签已不存在时退化为追加）
  if (options.replaceSessionId) replaceSessionTab(options.replaceSessionId, tab)
  else ensureSessionTab(tab)

  return { ok: true, tab }
}
