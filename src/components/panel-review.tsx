/**
 * panel-review.tsx
 * 参数：props.wsId workspace ID；props.sessionId 会话 ID
 * 核心流程：右侧面板 Review tab ——
 *           先加载 filetracker/files 变更文件列表（点击行选中）；
 *           选中文件时懒加载 /history，按 Path 分组取最后两个版本，
 *           用 diff 库生成 unified diff 渲染（+ 绿 / - 红 / 双行号），顶部展示 +N/-N 统计；
 *           只有一个版本时展示 Full file 视图；列表为空显示 No changes；
 *           失败行内错误 + Retry；wsId/sessionId 变化时整体重置
 */
import { createEffect, createSignal, For, Match, on, Show, Switch } from "solid-js"
import { structuredPatch } from "diff"
import { listSessionFileHistory, listSessionTrackedFiles, type HistoryFile } from "../lib/review"

/** diff 渲染行类型：hunk 头 / 新增 / 删除 / 上下文 / 元信息（如 "\ No newline at end of file"） */
type DiffRow = {
  kind: "hunk" | "add" | "del" | "ctx" | "meta"
  oldNo: number | null
  newNo: number | null
  text: string
}

/** diff 详情视图：双版本 diff / 单版本全文 / 有跟踪记录但无历史版本 */
type DiffView =
  | { kind: "diff"; rows: DiffRow[]; additions: number; deletions: number; oldVersion: number; newVersion: number }
  | { kind: "full"; rows: DiffRow[]; version: number }
  | { kind: "noversion" }

/** 文件列表加载状态：loading → ready/error（error 可 Retry） */
type FilesState =
  | { status: "loading" }
  | { status: "ready"; files: string[] }
  | { status: "error"; message: string }

/** 单文件 diff 加载状态 */
type DiffState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; view: DiffView }
  | { status: "error"; message: string }

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
 * buildDiffRows
 * 参数：oldContent 旧版本全文；newContent 新版本全文
 * 核心流程：structuredPatch 生成 unified patch → 展开为带双行号的渲染行，
 *           并统计 +N/-N（不含 hunk 头与元信息行）
 */
function buildDiffRows(
  oldContent: string,
  newContent: string,
): { rows: DiffRow[]; additions: number; deletions: number } {
  // 生成 unified patch：hunks 内每行带 +/-/空格/反斜杠前缀
  const patch = structuredPatch("a", "b", oldContent, newContent, "", "")
  const rows: DiffRow[] = []
  let additions = 0
  let deletions = 0
  for (const hunk of patch.hunks) {
    rows.push({
      kind: "hunk",
      oldNo: null,
      newNo: null,
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    })
    let oldNo = hunk.oldStart
    let newNo = hunk.newStart
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        additions++
        rows.push({ kind: "add", oldNo: null, newNo: newNo++, text: line.slice(1) })
      } else if (line.startsWith("-")) {
        deletions++
        rows.push({ kind: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) })
      } else if (line.startsWith("\\")) {
        rows.push({ kind: "meta", oldNo: null, newNo: null, text: line })
      } else {
        rows.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) })
      }
    }
  }
  return { rows, additions, deletions }
}

/**
 * buildFullRows
 * 参数：content 单版本全文
 * 核心流程：全文按行编号渲染（Full file 视图），末尾因换行产生的空行不渲染
 */
function buildFullRows(content: string): DiffRow[] {
  const lines = content.split("\n")
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  return lines.map((text, i) => ({ kind: "ctx" as const, oldNo: null, newNo: i + 1, text }))
}

/**
 * latestVersions
 * 参数：history 会话全部历史版本；path 目标文件路径
 * 核心流程：按 Path 过滤 → 同版本去重（保留 updated_at 最新）→ 按 version 升序返回
 */
function latestVersions(history: HistoryFile[], path: string): HistoryFile[] {
  const byVersion = new Map<number, HistoryFile>()
  for (const f of history) {
    if (f.path !== path) continue
    const prev = byVersion.get(f.version)
    if (!prev || f.updated_at >= prev.updated_at) byVersion.set(f.version, f)
  }
  return [...byVersion.values()].sort((a, b) => a.version - b.version)
}

/**
 * ReviewTab
 * 参数：props.wsId workspace ID；props.sessionId 会话 ID
 * 核心流程：挂载加载变更文件列表；wsId/sessionId 变化时重置并重新加载；
 *           点击文件懒加载 /history（每个会话只拉一次并缓存），取最后两个版本生成 diff；
 *           列表为空显示 No changes，选中后下方区域展示 diff 详情
 */
export default function ReviewTab(props: { wsId: string; sessionId: string }) {
  const [filesState, setFilesState] = createSignal<FilesState>({ status: "loading" })
  const [selected, setSelected] = createSignal("")
  const [diffState, setDiffState] = createSignal<DiffState>({ status: "idle" })
  // 会话级历史缓存：undefined 表示尚未拉取；选中首个文件时请求一次
  const [history, setHistory] = createSignal<HistoryFile[]>()
  // 会话纪元序号：切换 workspace/session 时递增，在途响应回来后按此判定过期丢弃
  let epoch = 0

  /**
   * loadFiles
   * 参数：wsId workspace ID；sid 会话 ID
   * 核心流程：先写 loading 占位 → 请求变更文件列表 → 成功写 ready，失败写 error（供 Retry）
   */
  async function loadFiles(wsId: string, sid: string) {
    const my = epoch
    setFilesState({ status: "loading" })
    try {
      const files = await listSessionTrackedFiles(wsId, sid)
      if (my !== epoch) return
      setFilesState({ status: "ready", files })
    } catch (err) {
      if (my !== epoch) return
      setFilesState({ status: "error", message: errorMessage(err) })
    }
  }

  /**
   * computeDiff
   * 参数：path 选中的文件路径；hist 已加载的历史版本列表
   * 核心流程：取该文件最后两个版本 → 双版本生成 unified diff；
   *           仅一个版本 → Full file 视图；无版本 → noversion 提示
   */
  function computeDiff(path: string, hist: HistoryFile[]) {
    const versions = latestVersions(hist, path)
    if (versions.length === 0) {
      setDiffState({ status: "ready", view: { kind: "noversion" } })
      return
    }
    if (versions.length === 1) {
      setDiffState({ status: "ready", view: { kind: "full", rows: buildFullRows(versions[0].content), version: versions[0].version } })
      return
    }
    const [prev, last] = versions.slice(-2)
    const { rows, additions, deletions } = buildDiffRows(prev.content, last.content)
    setDiffState({ status: "ready", view: { kind: "diff", rows, additions, deletions, oldVersion: prev.version, newVersion: last.version } })
  }

  /**
   * loadHistory
   * 参数：wsId workspace ID；sid 会话 ID
   * 核心流程：已缓存直接返回；否则请求 /history 并写缓存（失败抛给调用方展示）
   */
  async function loadHistory(wsId: string, sid: string): Promise<HistoryFile[]> {
    const cached = history()
    if (cached) return cached
    const my = epoch
    const data = await listSessionFileHistory(wsId, sid)
    // 过期响应直接丢弃：不写缓存也不参与渲染，避免旧会话历史污染新会话
    if (my !== epoch) return []
    setHistory(data)
    return data
  }

  /**
   * selectFile
   * 参数：path 被点击的文件路径
   * 核心流程：写选中态 → 历史未加载时先请求（期间 diff 区 loading）→ 命中缓存或拉取成功后计算 diff；
   *           失败写 diff 区 error（Retry 走同一函数）
   */
  async function selectFile(path: string) {
    const my = epoch
    setSelected(path)
    setDiffState({ status: "loading" })
    try {
      const hist = await loadHistory(props.wsId, props.sessionId)
      if (my !== epoch) return
      computeDiff(path, hist)
    } catch (err) {
      if (my !== epoch) return
      setDiffState({ status: "error", message: errorMessage(err) })
    }
  }

  // 会话/工作区切换：整体重置（列表/选中/diff/历史缓存），重新拉取新会话的变更文件
  createEffect(
    on(
      () => [props.wsId, props.sessionId] as const,
      ([wsId, sid]) => {
        epoch++
        setSelected("")
        setDiffState({ status: "idle" })
        setHistory(undefined)
        if (wsId && sid) void loadFiles(wsId, sid)
        else setFilesState({ status: "ready", files: [] })
      },
    ),
  )

  // 收窄辅助：把信号快照落到局部变量后再判别，规避 TS 跨调用不收窄
  const errFiles = () => {
    const s = filesState()
    return s.status === "error" ? s : undefined
  }
  const readyFiles = () => {
    const s = filesState()
    return s.status === "ready" ? s.files : []
  }

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <Switch>
        {/* 列表加载失败：行内错误 + Retry */}
        <Match when={errFiles()}>
          {(st) => (
            <div class="flex min-h-0 flex-1 items-center justify-center gap-2 px-4">
              <span class="min-w-0 truncate text-[12px] text-[#e5484d]">{st().message}</span>
              <button
                type="button"
                class="shrink-0 text-[12px] text-accent hover:underline"
                onClick={() => void loadFiles(props.wsId, props.sessionId)}
              >
                Retry
              </button>
            </div>
          )}
        </Match>
        {/* 列表加载中 */}
        <Match when={filesState().status === "loading"}>
          <div class="flex min-h-0 flex-1 items-center justify-center">
            <span class="text-[13px] text-faint">Loading changes…</span>
          </div>
        </Match>
        {/* 空态：会话没有任何被跟踪的文件变更 */}
        <Match when={readyFiles().length === 0 && filesState().status === "ready"}>
          <div class="flex min-h-0 flex-1 items-center justify-center">
            <span class="text-[13px] text-faint">No changes</span>
          </div>
        </Match>
        {/* 就绪：上方文件列表 + 下方 diff 详情区 */}
        <Match when={filesState().status === "ready"}>
          <div class="max-h-[45%] shrink-0 overflow-y-auto border-b border-edge py-1">
            <For each={readyFiles()}>
              {(path) => (
                <button
                  type="button"
                  class="flex w-full items-center gap-1.5 px-2.5 py-[3px] text-left text-[12px] transition-colors hover:bg-raised/60"
                  classList={{
                    "bg-raised text-text": selected() === path,
                    "text-muted": selected() !== path,
                  }}
                  title={path}
                  onClick={() => void selectFile(path)}
                >
                  <span class="min-w-0 truncate">{path}</span>
                </button>
              )}
            </For>
          </div>
          <DiffArea
            wsId={props.wsId}
            sessionId={props.sessionId}
            selected={selected()}
            diffState={diffState()}
            onSelect={(path) => void selectFile(path)}
          />
        </Match>
      </Switch>
    </div>
  )
}

/**
 * DiffArea
 * 参数：props.wsId/props.sessionId 供 Retry 重拉；props.selected 当前选中路径；
 *       props.diffState diff 加载状态；props.onSelect 重试回调（复用选中流程）
 * 核心流程：按状态渲染 —— 未选中提示 / loading / 行内错误 + Retry /
 *           noversion 提示 / Full file 视图 / unified diff（头部 +N/-N 统计 + 版本区间）
 */
function DiffArea(props: {
  wsId: string
  sessionId: string
  selected: string
  diffState: DiffState
  onSelect: (path: string) => void
}) {
  return (
    <div class="min-h-0 flex-1 overflow-y-auto">
      <Switch>
        {/* 尚未选择文件 */}
        <Match when={props.diffState.status === "idle" || !props.selected}>
          <div class="flex h-full items-center justify-center">
            <span class="text-[13px] text-faint">Select a file to view its changes</span>
          </div>
        </Match>
        {/* diff 加载中 */}
        <Match when={props.diffState.status === "loading"}>
          <div class="flex h-full items-center justify-center">
            <span class="text-[13px] text-faint">Loading diff…</span>
          </div>
        </Match>
        {/* diff 加载失败：行内错误 + Retry */}
        <Match when={props.diffState.status === "error"}>
          <div class="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <span class="text-[12px] text-[#e5484d]">
              {props.diffState.status === "error" ? props.diffState.message : ""}
            </span>
            <button
              type="button"
              class="text-[12px] text-accent hover:underline"
              onClick={() => props.onSelect(props.selected)}
            >
              Retry
            </button>
          </div>
        </Match>
        {/* 文件在跟踪列表中但历史里没有版本记录（只读过、未被 agent 修改） */}
        <Match when={props.diffState.status === "ready" && props.diffState.view.kind === "noversion"}>
          <div class="flex h-full items-center justify-center">
            <span class="text-[13px] text-faint">No recorded changes for this file</span>
          </div>
        </Match>
        {/* 就绪：统计头 + 渲染行 */}
        <Match when={props.diffState.status === "ready" && props.diffState.view.kind !== "noversion"}>
          <DiffContent
            path={props.selected}
            view={props.diffState.status === "ready" ? props.diffState.view : undefined}
          />
        </Match>
      </Switch>
    </div>
  )
}

/**
 * DiffContent
 * 参数：props.path 文件路径；props.view 已就绪的 diff 视图（diff/full 二选一）
 * 核心流程：头部展示路径 + +N/-N（或 Full file · vN）+ 版本区间，下方逐行渲染
 */
function DiffContent(props: { path: string; view: DiffView | undefined }) {
  // 收窄辅助：先落到局部变量再按 kind 判别
  const view = () => {
    const v = props.view
    return v && v.kind !== "noversion" ? v : undefined
  }
  const diffV = () => {
    const v = view()
    return v?.kind === "diff" ? v : undefined
  }
  const fullV = () => {
    const v = view()
    return v?.kind === "full" ? v : undefined
  }
  return (
    <Show when={view()}>
      {(v) => (
        <div class="flex flex-col">
          {/* 统计头：路径 + 增删统计 + 版本信息 */}
          <div class="sticky top-0 z-10 flex items-center gap-2 border-b border-edge bg-base px-2.5 py-1.5">
            <span class="min-w-0 truncate font-mono text-[11px] text-text" title={props.path}>
              {props.path}
            </span>
            <span class="ml-auto flex shrink-0 items-center gap-2 text-[11px]">
              <Show when={diffV()}>
                {(d) => (
                  <>
                    <span class="text-[#3fb950]">+{d().additions}</span>
                    <span class="text-[#e5484d]">−{d().deletions}</span>
                    <span class="text-faint">
                      v{d().oldVersion} → v{d().newVersion}
                    </span>
                  </>
                )}
              </Show>
              <Show when={fullV()}>
                {(f) => <span class="text-faint">Full file · v{f().version}</span>}
              </Show>
            </span>
          </div>
          {/* diff 行：双行号 + 符号 + 内容（等宽字体，长行折行适配窄面板） */}
          <div class="py-1">
            <For each={v().rows}>
              {(row) => (
                <div
                  class="flex font-mono text-[12px] leading-5"
                  classList={{
                    "bg-[#3fb950]/10": row.kind === "add",
                    "bg-[#e5484d]/10": row.kind === "del",
                    "bg-raised/60": row.kind === "hunk",
                  }}
                >
                  <span class="w-9 shrink-0 select-none pr-1.5 text-right text-faint">
                    {row.oldNo ?? ""}
                  </span>
                  <span class="w-9 shrink-0 select-none pr-1.5 text-right text-faint">
                    {row.newNo ?? ""}
                  </span>
                  <span
                    class="w-4 shrink-0 select-none text-center"
                    classList={{
                      "text-[#3fb950]": row.kind === "add",
                      "text-[#e5484d]": row.kind === "del",
                      "text-accent": row.kind === "hunk",
                      "text-faint": row.kind === "ctx" || row.kind === "meta",
                    }}
                  >
                    {row.kind === "add" ? "+" : row.kind === "del" ? "−" : row.kind === "ctx" ? " " : ""}
                  </span>
                  <span
                    class="min-w-0 flex-1 whitespace-pre-wrap break-all"
                    classList={{
                      "text-[#3fb950]": row.kind === "add",
                      "text-[#e5484d]": row.kind === "del",
                      "text-accent": row.kind === "hunk",
                      "text-text": row.kind === "ctx",
                      "text-faint italic": row.kind === "meta",
                    }}
                  >
                    {row.text}
                  </span>
                </div>
              )}
            </For>
          </div>
        </div>
      )}
    </Show>
  )
}
