/**
 * session-panel.tsx
 * 参数：wsId workspace ID；sessionId 会话 ID（任一变化即重置文件树状态）
 * 核心流程：会话页右侧面板骨架 —— 顶部 Files / Review / Terminal 三个 tab；
 *           Files：懒加载文件树（目录可展开/折叠、目录优先按名排序、
 *           人类可读大小、失败行内错误 + Retry、空目录 No files、超 200 条截断提示）；
 *           Review：变更文件列表 + 历史版本 unified diff（见 panel-review.tsx）；
 *           Terminal：命令执行与输出展示（见 panel-terminal.tsx）；
 *           折叠与宽度由宿主（session.tsx）控制，本组件不持久化任何状态
 */
import { createEffect, createSignal, For, Match, on, Show, Switch } from "solid-js"
import { listWorkspaceFiles, type FileEntry } from "../lib/files"
import QuestionIndex, { type QuestionItem } from "./panel-questions"
import ReviewTab from "./panel-review"
import TerminalTab from "./panel-terminal"

/** 面板 tab 标识 */
type PanelTab = "questions" | "files" | "review" | "terminal"

/** 目录条目截断上限：超过时只渲染前 200 条并提示 */
const MAX_CHILDREN = 200

/** 目录加载状态：loading → ready/error（error 可 Retry 重新加载） */
type DirState =
  | { status: "loading" }
  | { status: "ready"; entries: FileEntry[] }
  | { status: "error"; message: string }

/** tab 栏配置（顺序即渲染顺序） */
const PANEL_TABS: { id: PanelTab; label: string }[] = [
  { id: "questions", label: "Q&A" },
  { id: "files", label: "Files" },
  { id: "review", label: "Review" },
  { id: "terminal", label: "Terminal" },
]

/**
 * formatBytes
 * 参数：n 字节数
 * 核心流程：字节数转人类可读字符串（B/KB/MB/GB/TB，1024 进制，保留 1 位小数）
 */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—"
  if (n < 1024) return `${n} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = n
  let i = -1
  do {
    value /= 1024
    i++
  } while (value >= 1024 && i < units.length - 1)
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

/**
 * sortEntries
 * 参数：entries 目录条目列表
 * 核心流程：目录优先、其次按名称不区分大小写升序，返回新数组（不改入参）
 */
function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  })
}

/**
 * errorMessage
 * 参数：err 抛出的错误对象
 * 核心流程：从 ApiError 形状中安全取出 message，兜底 Unknown error
 */
function errorMessage(err: unknown): string {
  const e = err as { message?: string }
  return e?.message ?? "Unknown error"
}

/**
 * SessionPanel
 * 参数：props.wsId workspace ID；props.sessionId 会话 ID；
 *       props.questions 问答索引；props.activeQuestionId 当前问句；props.onJump 跳转回调
 * 核心流程：渲染 tab 栏并切换内容区 —— Q&A 挂载问答索引，
 *           Files 挂载文件树，Review 挂载变更 diff 视图，Terminal 挂载命令执行视图
 */
export default function SessionPanel(props: {
  wsId: string
  sessionId: string
  questions: QuestionItem[]
  activeQuestionId: string
  onJump: (messageId: string) => void
}) {
  const [tab, setTab] = createSignal<PanelTab>("questions")

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Tab 栏：Q&A / Files / Review / Terminal */}
      <div class="flex h-10 shrink-0 items-center gap-1 border-b border-edge px-2">
        <For each={PANEL_TABS}>
          {(t) => (
            <button
              type="button"
              class="rounded-[6px] px-2.5 py-1 text-[12px] font-medium transition-colors"
              classList={{
                "bg-raised text-text": tab() === t.id,
                "text-muted hover:bg-raised/60 hover:text-text": tab() !== t.id,
              }}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          )}
        </For>
      </div>

      {/* 内容区：各 tab 独立挂载（切换即卸载重挂，状态自然重置） */}
      <Switch fallback={<FileTree wsId={props.wsId} sessionId={props.sessionId} />}>
        <Match when={tab() === "questions"}>
          <QuestionIndex
            questions={props.questions}
            activeId={props.activeQuestionId}
            onJump={props.onJump}
          />
        </Match>
        <Match when={tab() === "review"}>
          <ReviewTab wsId={props.wsId} sessionId={props.sessionId} />
        </Match>
        <Match when={tab() === "terminal"}>
          <TerminalTab wsId={props.wsId} sessionId={props.sessionId} />
        </Match>
      </Switch>
    </div>
  )
}

/**
 * FileTree
 * 参数：props.wsId workspace ID；props.sessionId 会话 ID
 * 核心流程：挂载即加载根目录；展开集合与目录缓存保存在组件内，
 *           wsId/sessionId 变化时整体重置并重新拉取根目录；
 *           目录行点击展开/折叠（首次展开触发请求，失败后再次展开会重试）
 */
function FileTree(props: { wsId: string; sessionId: string }) {
  const [dirs, setDirs] = createSignal<Map<string, DirState>>(new Map())
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())

  /**
   * loadDir
   * 参数：wsId workspace ID；dir 相对目录（空串为根）
   * 核心流程：先写 loading 占位 → 请求目录列表 → 成功写 ready，失败写 error（保留 message 供行内展示）
   */
  async function loadDir(wsId: string, dir: string) {
    setDirs((prev) => new Map(prev).set(dir, { status: "loading" }))
    try {
      const entries = await listWorkspaceFiles(wsId, dir)
      setDirs((prev) => new Map(prev).set(dir, { status: "ready", entries }))
    } catch (err) {
      setDirs((prev) => new Map(prev).set(dir, { status: "error", message: errorMessage(err) }))
    }
  }

  /**
   * toggleDir
   * 参数：dir 相对目录路径
   * 核心流程：翻转展开集合；从未加载过或上次失败时发起（重新）加载
   */
  function toggleDir(dir: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })
    // 按需加载：目录尚未请求过、或上次请求失败时，展开即（重新）拉取
    const state = dirs().get(dir)
    if (!state || state.status === "error") void loadDir(props.wsId, dir)
  }

  // 会话/工作区切换：清空展开状态与目录缓存，重新加载新 workspace 的根目录
  createEffect(
    on(
      () => [props.wsId, props.sessionId] as const,
      ([wsId]) => {
    setDirs(new Map())
    setExpanded(new Set<string>())
    if (wsId) void loadDir(wsId, "")
      },
    ),
  )

  return (
    <div class="min-h-0 flex-1 overflow-y-auto py-1.5">
      <DirChildren
        path=""
        depth={0}
        wsId={props.wsId}
        dirs={dirs()}
        expanded={expanded()}
        onToggle={toggleDir}
        onRetry={(dir) => void loadDir(props.wsId, dir)}
      />
    </div>
  )
}

/**
 * DirChildren
 * 参数：path 目录相对路径（空串为根）；depth 缩进层级；wsId workspace ID；
 *       dirs/expanded 共享状态快照（由父级响应式传入）；onToggle 展开切换；onRetry 失败重试
 * 核心流程：按该目录的加载状态渲染 —— loading 提示 / 行内错误 + Retry /
 *           空目录 No files / 子条目列表（目录优先排序，超 200 条截断并提示）
 */
function DirChildren(props: {
  path: string
  depth: number
  wsId: string
  dirs: Map<string, DirState>
  expanded: ReadonlySet<string>
  onToggle: (dir: string) => void
  onRetry: (dir: string) => void
}) {
  const indent = () => ({ "padding-left": `${10 + props.depth * 14}px` })
  // 状态访问器：按分支收窄类型，供 Switch/Match 消费
  const errorState = () => {
    const s = props.dirs.get(props.path)
    return s?.status === "error" ? s : undefined
  }
  const readyState = () => {
    const s = props.dirs.get(props.path)
    return s?.status === "ready" ? s : undefined
  }

  return (
    <Switch>
      {/* 加载失败：行内错误 + Retry（重新请求当前目录） */}
      <Match when={errorState()}>
        {(st) => (
          <div class="flex items-center gap-2 py-1 pr-2 text-[12px] text-[#e5484d]" style={indent()}>
            <span class="min-w-0 truncate">{st().message}</span>
            <button
              type="button"
              class="shrink-0 text-[12px] text-accent hover:underline"
              onClick={() => props.onRetry(props.path)}
            >
              Retry
            </button>
          </div>
        )}
      </Match>
      {/* 就绪：条目列表（空目录显示 No files、超 200 条截断提示） */}
      <Match when={readyState()}>
        {(st) => (
          <DirList
            entries={st().entries}
            depth={props.depth}
            wsId={props.wsId}
            dirs={props.dirs}
            expanded={props.expanded}
            onToggle={props.onToggle}
            onRetry={props.onRetry}
          />
        )}
      </Match>
      {/* 未加载/加载中：占位提示 */}
      <Match when={true}>
        <div class="py-1 text-[12px] text-faint" style={indent()}>Loading…</div>
      </Match>
    </Switch>
  )
}

/**
 * DirList
 * 参数：entries 已就绪的目录条目；其余同 DirChildren
 * 核心流程：排序后渲染条目列表；空目录显示 No files；超过 200 条截断并追加提示行
 */
function DirList(props: {
  entries: FileEntry[]
  depth: number
  wsId: string
  dirs: Map<string, DirState>
  expanded: ReadonlySet<string>
  onToggle: (dir: string) => void
  onRetry: (dir: string) => void
}) {
  const sorted = () => sortEntries(props.entries)
  const visible = () => sorted().slice(0, MAX_CHILDREN)
  const hiddenCount = () => sorted().length - visible().length

  return (
    <Show
      when={sorted().length > 0}
      fallback={<div class="py-1 text-[12px] text-faint" style={{ "padding-left": `${10 + props.depth * 14}px` }}>No files</div>}
    >
      <For each={visible()}>
        {(entry) => (
          <TreeNode
            entry={entry}
            depth={props.depth}
            wsId={props.wsId}
            dirs={props.dirs}
            expanded={props.expanded}
            onToggle={props.onToggle}
            onRetry={props.onRetry}
          />
        )}
      </For>
      <Show when={hiddenCount() > 0}>
        <div
          class="py-1 text-[12px] text-faint"
          style={{ "padding-left": `${10 + (props.depth + 1) * 14}px` }}
        >
          Showing {visible().length} of {sorted().length} entries
        </div>
      </Show>
    </Show>
  )
}

/**
 * TreeNode
 * 参数：entry 单个文件/目录条目；depth 缩进层级；其余同 DirChildren
 * 核心流程：目录行点击展开/折叠（chevron 旋转指示），展开时递归渲染 DirChildren；
 *           文件行只展示名称与人类可读大小（后端无内容读取接口，不做预览）
 */
function TreeNode(props: {
  entry: FileEntry
  depth: number
  wsId: string
  dirs: Map<string, DirState>
  expanded: ReadonlySet<string>
  onToggle: (dir: string) => void
  onRetry: (dir: string) => void
}) {
  const indent = () => ({ "padding-left": `${10 + props.depth * 14}px` })
  const isOpen = () => props.expanded.has(props.entry.path)

  return (
    <div>
      <Show
        when={props.entry.is_dir}
        fallback={
          <div
            class="flex items-center gap-1.5 py-[3px] pr-2 text-[12px] text-text"
            style={indent()}
            title={`${props.entry.path} · ${formatBytes(props.entry.size)}`}
          >
            <FileIcon />
            <span class="min-w-0 truncate">{props.entry.name}</span>
            <span class="ml-auto shrink-0 text-[11px] text-faint">{formatBytes(props.entry.size)}</span>
          </div>
        }
      >
        <button
          type="button"
          class="flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-[12px] text-text transition-colors hover:bg-raised/60"
          style={indent()}
          onClick={() => props.onToggle(props.entry.path)}
        >
          <span
            class="shrink-0 text-muted transition-transform duration-150"
            classList={{ "rotate-90": isOpen() }}
          >
            <ChevronIcon />
          </span>
          <FolderIcon />
          <span class="min-w-0 truncate">{props.entry.name}</span>
        </button>
        <Show when={isOpen()}>
          <DirChildren
            path={props.entry.path}
            depth={props.depth + 1}
            wsId={props.wsId}
            dirs={props.dirs}
            expanded={props.expanded}
            onToggle={props.onToggle}
            onRetry={props.onRetry}
          />
        </Show>
      </Show>
    </div>
  )
}

/** ChevronIcon：目录展开指示箭头（展开态由外层 rotate-90 控制） */
function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="m6 4 4 4-4 4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  )
}

/** FolderIcon：目录条目图标 */
function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" class="size-3.5 shrink-0 text-muted" fill="none" stroke="currentColor" stroke-width="1.5">
      <path
        d="M2 4.5c0-.8.7-1.5 1.5-1.5h2.6l1.4 1.5h5c.8 0 1.5.7 1.5 1.5V12c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5V4.5Z"
        stroke-linejoin="round"
      />
    </svg>
  )
}

/** FileIcon：文件条目图标 */
function FileIcon() {
  return (
    <svg viewBox="0 0 16 16" class="size-3.5 shrink-0 text-faint" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M4.5 2h4.6l2.9 3.4V13a1 1 0 0 1-1 1h-6.5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" stroke-linejoin="round" />
      <path d="M9 2v3.5h3.2" stroke-linejoin="round" />
    </svg>
  )
}
