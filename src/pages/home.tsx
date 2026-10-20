/**
 * home.tsx
 * 核心流程：首页工作区列表 + 会话列表（复刻 opencode 版式）——
 *           加载 workspace 列表 → 左栏 Projects（选中写入全局 store，URL 同步 /w/:id）
 *           → Projects 标题栏 + 按钮打开创建弹窗（POST）→ 行内 hover 删除（确认 + DELETE）
 *           → 右栏 Sessions：搜索框前端过滤 + Today/Yesterday/Earlier 分组 + New session
 */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import {
  createWorkspace,
  deleteWorkspace,
  forgetProjectOnServer,
  listProjects,
  listWorkspaces,
  type Project,
  type Workspace,
} from "../lib/workspaces"
import { createSession, listSessions, type Session } from "../lib/sessions"
import { forgetProject, recalledWorkspacePath, recalledYolo, recentProjectPaths, rememberWorkspace, selectedWorkspace, setSelectedWorkspace } from "../lib/workspace-store"
import SettingsDialog from "../components/settings-dialog"
import { listDirs, type FsDirEntry } from "../lib/fs-browser"
import type { ApiError } from "../lib/http"

type LoadState = "loading" | "ready" | "error"

/** 取路径最后一段作为展示名；空段过滤保证尾斜杠不出错 */
function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path
}

/** 取展示名首字母作为项目/会话图标的占位字形 */
function initial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase()
}

/** 从抛出的错误对象中安全取 message */
function errorMessage(err: unknown): string {
  const e = err as ApiError
  return e?.message ?? "Unknown error"
}

/** 仅存在于本地记录、尚未在服务端重建的项目 id 前缀 */
const RECENT_PROJECT_PREFIX = "recent:"

/** 是否为本地记录占位项：点击时需要先按路径重建工作区 */
function isRecentProject(ws: Workspace): boolean {
  return ws.id.startsWith(RECENT_PROJECT_PREFIX)
}

/**
 * mergeProjects
 * 参数：live 后端当前存活的工作区；saved 服务端落盘记住的项目
 * 核心流程：按本地最近打开 → 服务端记录 → 存活工作区的顺序去重合并 ——
 *           存活项目用真实 id，已失效项目用 recent: 占位，点击时再按路径重建
 */
function mergeProjects(live: Workspace[], saved: Project[] = []): Workspace[] {
  const liveByPath = new Map(live.map((ws) => [ws.path, ws]))
  const seen = new Set<string>()
  const merged: Workspace[] = []
  for (const path of [...recentProjectPaths(), ...saved.map((p) => p.path)]) {
    if (seen.has(path)) continue
    seen.add(path)
    merged.push(liveByPath.get(path) ?? { id: `${RECENT_PROJECT_PREFIX}${path}`, path })
  }
  for (const ws of live) {
    if (seen.has(ws.path)) continue
    seen.add(ws.path)
    merged.push(ws)
  }
  return merged
}

/** 会话分组：今天 / 昨天 / 更早（updated_at 为 Unix 秒） */
function groupSessions(sessions: Session[]): { label: string; items: Session[] }[] {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 86400000

  const today: Session[] = []
  const yesterday: Session[] = []
  const earlier: Session[] = []

  for (const s of sessions) {
    const at = s.updated_at * 1000
    if (at >= startOfToday) today.push(s)
    else if (at >= startOfYesterday) yesterday.push(s)
    else earlier.push(s)
  }

  return [
    { label: "Today", items: today },
    { label: "Yesterday", items: yesterday },
    { label: "Earlier", items: earlier },
  ].filter((g) => g.items.length > 0)
}

export default function Home() {
  const params = useParams<{ workspaceId?: string }>()
  const navigate = useNavigate()
  const [workspaces, setWorkspaces] = createSignal<Workspace[]>([])
  const [loadState, setLoadState] = createSignal<LoadState>("loading")
  const [loadError, setLoadError] = createSignal("")
  const [openDialog, setOpenDialog] = createSignal(false)
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [deleteTarget, setDeleteTarget] = createSignal<Workspace>()
  const [toast, setToast] = createSignal("")

  let toastTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * showToast
   * 参数：msg 提示文案
   * 核心流程：写入 toast 并在 3s 后自动清除（重置计时器避免叠写）
   */
  function showToast(msg: string) {
    setToast(msg)
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => setToast(""), 3000)
  }

  /**
   * loadWorkspaces
   * 参数：无
   * 核心流程：并行拉取存活 workspace 与服务端落盘项目 → 合并去重写入列表并进入 ready；
   *           项目接口失败时降级为仅本地记录
   */
  async function loadWorkspaces() {
    setLoadState("loading")
    try {
      // 拉取列表：存活工作区 + 服务端记住的项目（后者失败不影响主流程）
      const [data, saved] = await Promise.all([
        listWorkspaces(),
        listProjects().catch(() => [] as Project[]),
      ])
      // 服务重启后列表为空：按上次打开的路径重建工作区，恢复会话入口
      if (data.length === 0) {
        const path = recalledWorkspacePath()
        if (path) {
          // 重建上次打开的项目时带上本地 YOLO 缓存，避免权限模式被重置为关闭
          const ws = await createWorkspace({ path, yolo: recalledYolo(path) })
          rememberWorkspace(ws)
          setWorkspaces(mergeProjects([ws], saved))
          setSelectedWorkspace(ws)
          setLoadState("ready")
          navigate(`/w/${encodeURIComponent(ws.id)}`)
          return
        }
      }
      setWorkspaces(mergeProjects(data, saved))
      setLoadState("ready")
    } catch (err) {
      setLoadError(errorMessage(err))
      setLoadState("error")
    }
  }

  onMount(() => {
    // 首次进入：加载工作区列表
    void loadWorkspaces()
  })

  // URL → 选中态同步：/w/:id 刷新后从列表找回选中项；回到 / 清空选中
  createEffect(() => {
    const wsId = params.workspaceId
    if (!wsId) {
      setSelectedWorkspace(undefined)
      return
    }
    if (selectedWorkspace()?.id === wsId) return
    const ws = workspaces().find((w) => w.id === wsId)
    if (ws) setSelectedWorkspace(ws)
  })

  /**
   * handleSelect
   * 参数：ws 被点击的 workspace
   * 核心流程：本地记录占位项先按路径重建工作区再选中；
   *           其余写入全局选中 store 并把 URL 更新为 /w/:id
   */
  async function handleSelect(ws: Workspace) {
    if (isRecentProject(ws)) {
      try {
        // 失效项目：服务端 id 是内存态，按路径重建后替掉占位项（同时回填 YOLO）
        const created = await createWorkspace({ path: ws.path, yolo: recalledYolo(ws.path) })
        rememberWorkspace(created)
        setWorkspaces((prev) => prev.map((item) => (item.id === ws.id ? created : item)))
        setSelectedWorkspace(created)
        navigate(`/w/${encodeURIComponent(created.id)}`)
      } catch (err) {
        showToast(errorMessage(err))
      }
      return
    }
    rememberWorkspace(ws)
    setSelectedWorkspace(ws)
    navigate(`/w/${encodeURIComponent(ws.id)}`)
  }

  /**
   * handleDeleteConfirm
   * 参数：无（读取 deleteTarget）
   * 核心流程：DELETE /workspaces/{id} → 成功刷新列表并在删中的是选中项时清空选中；
   *           失败 toast 后端 message
   */
  async function handleDeleteConfirm() {
    const target = deleteTarget()
    if (!target) return
    // 本地记录占位：仅从最近项目移除，无需请求后端
    if (isRecentProject(target)) {
      forgetProject(target.path)
      // 同步清掉服务端记录，避免刷新后重新出现
      void forgetProjectOnServer(target.path).catch(() => undefined)
      setDeleteTarget(undefined)
      setWorkspaces((prev) => prev.filter((item) => item.id !== target.id))
      return
    }
    try {
      // 删除工作区：带 client_id 查询参数
      await deleteWorkspace(target.id)
      forgetProject(target.path)
      // 同步清掉服务端记录，避免刷新后重新出现
      void forgetProjectOnServer(target.path).catch(() => undefined)
      setDeleteTarget(undefined)
      // 删中的是选中项：清空选中并回退到 /（避免 URL 残留失效 id）
      if (selectedWorkspace()?.id === target.id) {
        setSelectedWorkspace(undefined)
        navigate("/")
      }
      await loadWorkspaces()
    } catch (err) {
      showToast(errorMessage(err))
    }
  }

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      {/* 视觉复刻 opencode 首页：外边距 8px、圆角 10px 的卡片，内容网格居中 */}
      <div class="m-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] bg-base">
        <div class="mx-auto flex w-full max-w-[1080px] flex-1 flex-col gap-6 px-6 py-10 lg:flex-row lg:items-start lg:gap-8">
          <ProjectsPanel
            workspaces={workspaces()}
            state={loadState()}
            error={loadError()}
            selectedId={selectedWorkspace()?.id}
            onRetry={() => void loadWorkspaces()}
            onSelect={handleSelect}
            onRequestDelete={setDeleteTarget}
            onRequestOpen={() => setOpenDialog(true)}
            onOpenSettings={() => setSettingsOpen(true)}
            onUnavailable={() => showToast("Not available yet")}
          />
          <SessionsPanel
            wsId={params.workspaceId}
            onError={(msg) => showToast(msg)}
            onUnavailable={() => showToast("Not available yet")}
          />
        </div>
      </div>

      <Show when={settingsOpen()}>
        <SettingsDialog
          ws={selectedWorkspace()}
          onClose={() => setSettingsOpen(false)}
          onToast={(msg) => showToast(msg)}
        />
      </Show>

      <Show when={openDialog()}>
        <OpenProjectDialog
          onClose={() => setOpenDialog(false)}
          onCreated={(ws) => {
            // 创建成功：关弹窗、刷新列表并选中新工作区（URL 同步 /w/:id）
            setOpenDialog(false)
            rememberWorkspace(ws)
            setSelectedWorkspace(ws)
            navigate(`/w/${encodeURIComponent(ws.id)}`)
            void loadWorkspaces()
          }}
          onError={(msg) => showToast(msg)}
        />
      </Show>

      <Show when={deleteTarget()}>
        {(target) => (
          <ConfirmDialog
            title="Remove project"
            description={`Remove ${basename(target().path)} from the workspace list? The directory itself will not be deleted.`}
            confirmLabel="Remove"
            onCancel={() => setDeleteTarget(undefined)}
            onConfirm={() => void handleDeleteConfirm()}
          />
        )}
      </Show>

      <Show when={toast()}>
        <div class="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-md bg-raised px-3 py-2 text-[13px] text-text shadow-lg">
          {toast()}
        </div>
      </Show>
    </div>
  )
}

function ProjectsPanel(props: {
  workspaces: Workspace[]
  state: LoadState
  error: string
  selectedId: string | undefined
  onRetry: () => void
  onSelect: (ws: Workspace) => void
  onRequestDelete: (ws: Workspace) => void
  onRequestOpen: () => void
  onOpenSettings: () => void
  onUnavailable: () => void
}) {
  // 折叠阈值：项目过多时先展示前 N 条，避免左栏被历史项目淹没
  const COLLAPSED_LIMIT = 8
  const [query, setQuery] = createSignal("")
  const [expanded, setExpanded] = createSignal(false)

  /**
   * filtered
   * 参数：无（读取 query 与 props.workspaces）
   * 核心流程：按关键字匹配项目路径或展示名，不区分大小写
   */
  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (!q) return props.workspaces
    return props.workspaces.filter(
      (ws) => ws.path.toLowerCase().includes(q) || basename(ws.path).toLowerCase().includes(q),
    )
  })

  /**
   * visible
   * 参数：无
   * 核心流程：有过滤条件或已展开时铺满结果，否则只显示前 COLLAPSED_LIMIT 条
   */
  const visible = createMemo(() => {
    const list = filtered()
    if (query().trim() !== "" || expanded()) return list
    return list.slice(0, COLLAPSED_LIMIT)
  })

  /** 被折叠的条数：0 表示无需展示展开按钮 */
  const hiddenCount = createMemo(() => filtered().length - visible().length)

  return (
    <aside class="flex w-full shrink-0 flex-col lg:w-[280px]">
      <div class="flex h-7 shrink-0 items-center justify-between pl-1 pr-1">
        <span class="text-[12px] font-medium text-muted">Projects</span>
        {/* 添加项目：打开路径输入弹窗 */}
        <button
          type="button"
          aria-label="Add project"
          title="Add project"
          class="flex size-6 items-center justify-center rounded-[6px] text-muted transition-colors hover:bg-raised hover:text-text"
          onClick={props.onRequestOpen}
        >
          <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M8 3.5v9M3.5 8h9" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      {/* 关键字过滤：同时匹配项目路径与展示名 */}
      <div class="mt-2 flex h-8 shrink-0 items-center gap-2 rounded-[6px] bg-raised px-2">
        <svg viewBox="0 0 16 16" class="size-3.5 shrink-0 text-faint" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="7" cy="7" r="4.2" />
          <path d="M10.2 10.2 13 13" stroke-linecap="round" />
        </svg>
        <input
          type="text"
          spellcheck={false}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          placeholder="Filter projects"
          aria-label="Filter projects"
          class="min-w-0 flex-1 bg-transparent text-[12px] text-text outline-none placeholder:text-faint"
        />
        <Show when={query() !== ""}>
          <button
            type="button"
            aria-label="Clear filter"
            title="Clear filter"
            class="flex size-4 shrink-0 items-center justify-center rounded-[4px] text-faint transition-colors hover:bg-edge hover:text-text"
            onClick={() => setQuery("")}
          >
            <svg viewBox="0 0 16 16" class="size-3" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round" />
            </svg>
          </button>
        </Show>
      </div>

      <div class="mt-2 min-h-0 flex-1 overflow-y-auto">
        <Show
          when={props.state !== "error"}
          fallback={
            <div class="flex flex-col items-start gap-2 rounded-[6px] px-1 py-3">
              <span class="text-[13px] leading-5 text-muted">Failed to load projects: {props.error}</span>
              <button
                type="button"
                class="rounded-[6px] border border-edge px-2 py-1 text-[12px] text-text transition-colors hover:border-edge-strong hover:bg-raised"
                onClick={props.onRetry}
              >
                Retry
              </button>
            </div>
          }
        >
          <Show
            when={props.workspaces.length > 0}
            fallback={<div class="px-1.5 py-3 text-[13px] leading-5 text-faint">No projects yet.</div>}
          >
            <Show
              when={filtered().length > 0}
              fallback={<div class="px-1.5 py-3 text-[13px] leading-5 text-faint">No matching projects.</div>}
            >
              <div class="flex flex-col gap-0.5">
                <For each={visible()}>
                  {(ws) => (
                    <div
                      class="group relative flex min-w-0 items-center rounded-[6px]"
                      classList={{ "bg-raised": props.selectedId === ws.id }}
                    >
                      <button
                        type="button"
                        class="flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-[6px] pl-1.5 pr-1 text-left transition-colors hover:bg-raised/60"
                        onClick={() => props.onSelect(ws)}
                        title={ws.path}
                      >
                        {/* 项目图标：2px 圆角方块 + 首字母 */}
                        <span class="flex size-5 shrink-0 items-center justify-center rounded-[4px] bg-edge text-[10px] font-semibold text-text">
                          {initial(basename(ws.path))}
                        </span>
                        <span class="min-w-0 flex-1 truncate text-[13px] text-text">{basename(ws.path)}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${basename(ws.path)}`}
                        class="mr-1 hidden size-5 shrink-0 items-center justify-center rounded-[4px] text-muted transition-colors group-hover:flex hover:bg-edge hover:text-text"
                        onClick={(e) => {
                          e.stopPropagation()
                          props.onRequestDelete(ws)
                        }}
                      >
                        <svg viewBox="0 0 16 16" class="size-3" fill="none" stroke="currentColor" stroke-width="1.5">
                          <path d="M3 4h10M6.5 4V3h3v1M5 4l.5 9h5L11 4" stroke-linecap="round" stroke-linejoin="round" />
                        </svg>
                      </button>
                    </div>
                  )}
                </For>
              </div>
              {/* 折叠入口：过滤中不折叠，避免命中项被藏起来 */}
              <Show when={query().trim() === "" && (expanded() || hiddenCount() > 0)}>
                <button
                  type="button"
                  class="mt-1 flex h-7 w-full items-center justify-center rounded-[6px] text-[12px] text-muted transition-colors hover:bg-raised hover:text-text"
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded() ? "Show less" : `Show all ${filtered().length} projects`}
                </button>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>

      {/* 底部固定入口：Settings / Help（本阶段仅提示） */}
      <div class="mt-4 flex shrink-0 flex-col gap-0.5">
        <button
          type="button"
          class="flex h-[34px] items-center gap-2 rounded-[6px] px-1.5 text-[13px] text-muted transition-colors hover:bg-raised hover:text-text"
          onClick={props.onOpenSettings}
        >
          <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.4">
            <circle cx="8" cy="8" r="2.4" />
            <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1" stroke-linecap="round" />
          </svg>
          Settings
        </button>
        <button
          type="button"
          class="flex h-[34px] items-center gap-2 rounded-[6px] px-1.5 text-[13px] text-muted transition-colors hover:bg-raised hover:text-text"
          onClick={props.onUnavailable}
        >
          <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.4">
            <circle cx="8" cy="8" r="6" />
            <path d="M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.6.3-.8.7-.8 1.3" stroke-linecap="round" />
            <circle cx="8" cy="11.6" r="0.7" fill="currentColor" stroke="none" />
          </svg>
          Help
        </button>
      </div>
    </aside>
  )
}

function SessionsPanel(props: {
  wsId: string | undefined
  onError: (message: string) => void
  onUnavailable: () => void
}) {
  const navigate = useNavigate()
  const [sessions, setSessions] = createSignal<Session[]>([])
  const [state, setState] = createSignal<LoadState>("loading")
  const [error, setError] = createSignal("")
  const [creating, setCreating] = createSignal(false)
  const [query, setQuery] = createSignal("")

  /**
   * loadSessions
   * 参数：wsId workspace ID
   * 核心流程：GET /workspaces/{wsId}/sessions → 成功写列表进入 ready；失败记文案进入 error
   */
  async function loadSessions(wsId: string) {
    setState("loading")
    try {
      // 拉取会话列表：成功即视为就绪
      const data = await listSessions(wsId)
      setSessions(data)
      setState("ready")
    } catch (err) {
      setError(errorMessage(err))
      setState("error")
    }
  }

  // 选中工作区变化：切换/清空会话列表数据源
  createEffect(() => {
    const wsId = props.wsId
    if (!wsId) {
      setSessions([])
      setState("loading")
      setError("")
      return
    }
    void loadSessions(wsId)
  })

  // 搜索：仅按标题前端过滤（空标题按 Untitled 参与匹配）
  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (!q) return sessions()
    return sessions().filter((s) => (s.title || "Untitled").toLowerCase().includes(q))
  })

  const groups = createMemo(() => groupSessions(filtered()))

  /**
   * handleNewSession
   * 参数：无（读取 wsId）
   * 核心流程：POST /workspaces/{wsId}/sessions → 成功跳转新会话页；失败 toast 后端 message
   */
  async function handleNewSession() {
    const wsId = props.wsId
    if (!wsId || creating()) return
    setCreating(true)
    try {
      // 创建会话：空标题由后端存储，进入会话页后再补全
      const created = await createSession(wsId)
      navigate(`/w/${encodeURIComponent(wsId)}/session/${encodeURIComponent(created.id)}`)
    } catch (err) {
      props.onError(errorMessage(err))
    }
    setCreating(false)
  }

  const newSessionButton = () => (
    <button
      type="button"
      class="flex h-7 items-center gap-1 rounded-[6px] px-2 text-[12px] text-faint transition-colors hover:bg-raised hover:text-text disabled:opacity-50"
      disabled={creating()}
      onClick={() => void handleNewSession()}
    >
      <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M8 3.5v9M3.5 8h9" stroke-linecap="round" />
      </svg>
      New session
    </button>
  )

  return (
    <section class="flex min-h-0 min-w-0 flex-1 flex-col lg:w-[720px] lg:flex-none">
      {/* 搜索框：720x36、圆角 8px、左侧放大镜 */}
      <div class="flex h-9 shrink-0 items-center gap-2 rounded-[8px] bg-raised px-2.5">
        <svg viewBox="0 0 16 16" class="size-3.5 shrink-0 text-faint" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="7" cy="7" r="4.2" />
          <path d="M10.2 10.2 13 13" stroke-linecap="round" />
        </svg>
        <input
          type="text"
          spellcheck={false}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          placeholder="Search sessions"
          class="min-w-0 flex-1 bg-transparent text-[12px] text-text outline-none placeholder:text-faint"
        />
      </div>

      <div class="mt-2 min-h-0 flex-1 overflow-y-auto">
        <Show
          when={props.wsId}
          fallback={
            <div class="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-6 text-center">
              <span class="text-[13px] font-medium text-text">Select a project to view sessions</span>
            </div>
          }
        >
          <Show
            when={state() !== "error"}
            fallback={
              <div class="flex flex-col items-start gap-2 rounded-[6px] px-1 py-3">
                <span class="text-[13px] leading-5 text-muted">Failed to load sessions: {error()}</span>
                <button
                  type="button"
                  class="rounded-[6px] border border-edge px-2 py-1 text-[12px] text-text transition-colors hover:border-edge-strong hover:bg-raised"
                  onClick={() => void loadSessions(props.wsId!)}
                >
                  Retry
                </button>
              </div>
            }
          >
            <Show
              when={state() !== "loading"}
              fallback={<div class="px-1 py-3 text-[13px] leading-5 text-faint">Loading sessions…</div>}
            >
              <Show
                when={groups().length > 0}
                fallback={
                  <div class="flex items-center justify-between px-1 py-3">
                    <span class="text-[13px] leading-5 text-faint">
                      {query().trim() ? "No matching sessions" : "No sessions yet"}
                    </span>
                    {newSessionButton()}
                  </div>
                }
              >
                <div class="flex flex-col">
                  <For each={groups()}>
                    {(group, index) => (
                      <div class="flex flex-col">
                        {/* 分组标题行：Today/Yesterday/Earlier + 右侧 New session（仅首组） */}
                        <div class="flex h-8 items-center justify-between pl-1 pr-1">
                          <span class="text-[12px] font-medium text-muted">{group.label}</span>
                          <Show when={index() === 0}>{newSessionButton()}</Show>
                        </div>
                        <div class="flex flex-col gap-0.5">
                          <For each={group.items}>
                            {(s) => (
                              <button
                                type="button"
                                class="flex h-[34px] min-w-0 w-full items-center gap-2 rounded-[6px] pl-1.5 pr-2 text-left transition-colors hover:bg-raised/60"
                                onClick={() =>
                                  navigate(
                                    `/w/${encodeURIComponent(props.wsId!)}/session/${encodeURIComponent(s.id)}`,
                                  )
                                }
                                title={s.title || "Untitled"}
                              >
                                <span class="flex size-5 shrink-0 items-center justify-center rounded-[4px] bg-edge text-[10px] font-semibold text-text">
                                  {initial(s.title || "Untitled")}
                                </span>
                                <span class="min-w-0 flex-1 truncate text-[13px] text-text">
                                  {s.title || "Untitled"}
                                </span>
                              </button>
                            )}
                          </For>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
    </section>
  )
}

function OpenProjectDialog(props: {
  onClose: () => void
  onCreated: (ws: Workspace) => void
  onError: (message: string) => void
}) {
  const [path, setPath] = createSignal("")
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal("")
  const [entries, setEntries] = createSignal<FsDirEntry[]>([])
  const [parent, setParent] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [browseError, setBrowseError] = createSignal("")
  const [active, setActive] = createSignal(-1)
  let inputRef: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let requestSeq = 0

  onMount(() => {
    // 打开弹窗即聚焦输入框，默认展示主目录下的子目录
    inputRef?.focus()
  })

  /**
   * splitPath
   * 参数：value 当前输入值
   * 核心流程：拆成「要列出的目录」+「过滤前缀」——以 / 结尾时列出该目录，
   *           否则列出其父目录并按最后一段过滤
   */
  function splitPath(value: string): { dir: string; prefix: string } {
    if (value.endsWith("/")) return { dir: value, prefix: "" }
    const idx = value.lastIndexOf("/")
    if (idx < 0) return { dir: "", prefix: value }
    if (idx === 0) return { dir: "/", prefix: value.slice(1) }
    return { dir: value.slice(0, idx), prefix: value.slice(idx + 1) }
  }

  /**
   * loadSuggestions
   * 参数：value 当前输入值
   * 核心流程：GET /fs/dirs 列出目录 → 按前缀过滤子目录；失败只提示不阻断输入；
   *           用递增序号丢弃过期响应，避免快速输入时结果错乱
   */
  async function loadSuggestions(value: string) {
    const seq = ++requestSeq
    setLoading(true)
    setBrowseError("")
    const { dir, prefix } = splitPath(value)
    try {
      const data = await listDirs(dir || undefined)
      if (seq !== requestSeq) return
      const q = prefix.toLowerCase()
      setEntries(data.entries.filter((e) => e.name.toLowerCase().startsWith(q)).slice(0, 50))
      setParent(data.parent ?? "")
      setActive(-1)
    } catch {
      if (seq !== requestSeq) return
      setEntries([])
      setBrowseError("Directory not found")
    }
    setLoading(false)
  }

  // 输入变化：120ms 防抖后刷新下一级目录
  createEffect(() => {
    const value = path()
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => void loadSuggestions(value), 120)
  })

  onCleanup(() => clearTimeout(debounceTimer))

  // 键盘上下移动选中项时，保证当前项在可视区
  createEffect(() => {
    const index = active()
    if (index < 0) return
    const el = listRef?.querySelector<HTMLElement>(`[data-index="${index}"]`)
    el?.scrollIntoView({ block: "nearest" })
  })

  /** 建议行：父目录 .. + 当前目录下的子目录 */
  const rows = createMemo(() => {
    const list: { name: string; path: string; up: boolean }[] = []
    if (parent() && parent() !== path()) list.push({ name: "..", path: parent(), up: true })
    for (const e of entries()) list.push({ name: e.name, path: e.path, up: false })
    return list
  })

  /**
   * drillTo
   * 参数：dir 目标目录
   * 核心流程：把输入值设为该目录并补 /，触发下一级补全；保持焦点便于继续输入
   */
  function drillTo(dir: string) {
    setPath(dir.endsWith("/") ? dir : `${dir}/`)
    queueMicrotask(() => inputRef?.focus())
  }

  /**
   * handleSubmit
   * 参数：无（读取 path 输入）
   * 核心流程：POST /workspaces → 成功回调 onCreated；失败把后端 message 显示在弹窗内
   */
  async function handleSubmit() {
    const value = path().trim().replace(/(.)\/+$/, "$1")
    if (!value) {
      setError("Please enter an absolute path")
      return
    }
    setSubmitting(true)
    setError("")
    try {
      // 创建工作区：body 自动携带 client_id，并按项目路径回填 YOLO
      const ws = await createWorkspace({ path: value, yolo: recalledYolo(value) })
      props.onCreated(ws)
    } catch (err) {
      setError(errorMessage(err))
      setSubmitting(false)
    }
  }

  return (
    <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/50 px-4" onClick={props.onClose}>
      <div
        class="w-full max-w-md rounded-[10px] border border-edge bg-base p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 class="text-[15px] font-semibold text-text">Open project</h2>
        <p class="mt-1 text-[13px] leading-5 text-muted">Type an absolute path; subdirectories appear as you type.</p>

        <div class="relative mt-3">
          <input
            ref={inputRef}
            type="text"
            spellcheck={false}
            placeholder="/absolute/path/to/project"
            value={path()}
            onInput={(e) => {
              setPath(e.currentTarget.value)
              setError("")
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                props.onClose()
                return
              }
              if (e.key === "ArrowDown") {
                e.preventDefault()
                setActive((i) => Math.min(i + 1, rows().length - 1))
                return
              }
              if (e.key === "ArrowUp") {
                e.preventDefault()
                setActive((i) => Math.max(i - 1, -1))
                return
              }
              if (e.key === "Tab" && active() >= 0) {
                e.preventDefault()
                drillTo(rows()[active()].path)
                return
              }
              if (e.key === "Enter") {
                e.preventDefault()
                if (active() >= 0) {
                  drillTo(rows()[active()].path)
                  return
                }
                if (!submitting()) void handleSubmit()
              }
            }}
            class="w-full rounded-[6px] border border-edge bg-deep px-2.5 py-2 text-[13px] text-text outline-none transition-colors placeholder:text-faint focus:border-edge-strong"
          />

          {/* 下一级目录建议：点击/回车下钻，Tab 补全当前高亮项 */}
          <Show when={loading() || browseError() || rows().length > 0}>
            <div
              ref={listRef}
              class="mt-1 max-h-56 overflow-y-auto rounded-[8px] border border-edge bg-base py-1"
            >
              <Show when={loading()}>
                <div class="px-2.5 py-1.5 text-[12px] text-faint">Loading…</div>
              </Show>
              <Show when={!loading() && browseError()}>
                <div class="px-2.5 py-1.5 text-[12px] text-muted">{browseError()}</div>
              </Show>
              <Show when={!loading() && !browseError()}>
                <For each={rows()}>
                  {(row, index) => (
                    <button
                      type="button"
                      data-index={index()}
                      class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] text-text transition-colors"
                      classList={{ "bg-raised": active() === index() }}
                      onMouseEnter={() => setActive(index())}
                      onClick={() => drillTo(row.path)}
                    >
                      <svg
                        viewBox="0 0 16 16"
                        class="size-3.5 shrink-0 text-muted"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.4"
                      >
                        <path
                          d="M2 5.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1H8L6.5 4H3a1 1 0 0 0-1 1v.5Z"
                          stroke-linejoin="round"
                        />
                      </svg>
                      <span class="min-w-0 flex-1 truncate">{row.name}</span>
                    </button>
                  )}
                </For>
                <Show when={rows().length === 0}>
                  <div class="px-2.5 py-1.5 text-[12px] text-faint">No subdirectories</div>
                </Show>
              </Show>
            </div>
          </Show>
        </div>

        <Show when={error()}>
          <p class="mt-2 text-[12px] leading-4 text-[#e5484d]">{error()}</p>
        </Show>
        <div class="mt-4 flex justify-end gap-2">
          <button
            type="button"
            class="rounded-[6px] border border-edge px-3 py-1.5 text-[13px] text-text transition-colors hover:bg-raised"
            onClick={props.onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting()}
            class="rounded-[6px] bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            onClick={() => void handleSubmit()}
          >
            Open
          </button>
        </div>
      </div>
    </div>
  )
}

function ConfirmDialog(props: {
  title: string
  description: string
  confirmLabel: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/50 px-4" onClick={props.onCancel}>
      <div
        class="w-full max-w-sm rounded-[10px] border border-edge bg-base p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 class="text-[15px] font-semibold text-text">{props.title}</h2>
        <p class="mt-1 break-words text-[13px] leading-5 text-muted">{props.description}</p>
        <div class="mt-4 flex justify-end gap-2">
          <button
            type="button"
            class="rounded-[6px] border border-edge px-3 py-1.5 text-[13px] text-text transition-colors hover:bg-raised"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded-[6px] bg-[#e5484d] px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
