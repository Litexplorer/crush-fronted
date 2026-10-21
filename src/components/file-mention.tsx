/**
 * file-mention.tsx
 * 参数：wsId workspace ID；onPick 选中文件回调；onClose 关闭回调
 * 核心流程：Composer 的 @ 文件选择浮层 ——
 *           打开时加载根目录 → 键盘/鼠标选中行 → 文件或文件夹作为附件回调；
 *           目录可下钻（→ / 点击主行）、回退（← / Backspace）、顶部输入框按名称过滤
 */
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { listWorkspaceFiles, type FileEntry } from "../lib/files"
import type { ApiError } from "../lib/http"

/**
 * errorMessage
 * 参数：err 未知错误
 * 核心流程：取 ApiError.message，兜底 Unknown error
 */
function errorMessage(err: unknown): string {
  const e = err as ApiError
  return e?.message ?? "Unknown error"
}

type MentionRow = {
  entry: FileEntry
  // true 表示「附加当前目录」行，Enter/Tab 只附加、不继续下钻
  attachOnly: boolean
}

/** @ 引用默认递归层数：一次拉平足够深的工作区树，搜索才能跨目录命中 */
const MENTION_DEPTH = 4
/** 浮层最多渲染的候选行数：避免上千条 DOM 节点拖慢输入 */
const MAX_RENDERED_ROWS = 200

export default function FileMention(props: {
  wsId: string
  onPick: (entry: FileEntry) => void
  onClose: () => void
}) {
  const [dir, setDir] = createSignal("")
  const [entries, setEntries] = createSignal<FileEntry[]>([])
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  let inputRef: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined
  let loadSeq = 0

  /**
   * load
   * 参数：path 相对目录
   * 核心流程：GET /files?path → 写列表、重置选中行并聚焦搜索框；失败进入行内错误态
   */
  async function load(path: string) {
    const seq = ++loadSeq
    setLoading(true)
    setError("")
    setActive(0)
    try {
      // 递归拉取当前目录：扁平结果让搜索能命中更深层的文件
      const data = await listWorkspaceFiles(props.wsId, path, MENTION_DEPTH)
      // 只接受最后一次请求结果，避免快速下钻时旧响应覆盖新目录
      if (seq !== loadSeq) return
      setEntries(data)
      setDir(path)
    } catch (err) {
      if (seq !== loadSeq) return
      setError(errorMessage(err))
    }
    setLoading(false)
    queueMicrotask(() => inputRef?.focus())
  }

  onMount(() => {
    // 打开即加载根目录并聚焦搜索框，键盘可直接接管
    void load("")
    queueMicrotask(() => inputRef?.focus())
  })

  // Escape 关闭；监听在 document 上，焦点在面包屑等位置时也能关闭
  createEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        props.onClose()
      }
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  /** 当前目录路径拆成面包屑：根 + 逐级目录 */
  const crumbs = () => {
    const parts = dir().split("/").filter(Boolean)
    return [{ name: "workspace", path: "" }, ...parts.map((p, i) => ({ name: p, path: parts.slice(0, i + 1).join("/") }))]
  }

  /** 过滤后条目：无查询时目录优先、路径升序；有查询时同时匹配名称与相对路径 */
  const visible = () => {
    const q = query().trim().toLowerCase()
    return [...entries()]
      .filter((e) => !q || e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q))
      .sort((a, b) => (a.is_dir === b.is_dir ? a.path.localeCompare(b.path) : a.is_dir ? -1 : 1))
  }

  /** 键盘可选行：第 0 行固定为「附加当前目录」，其后是过滤后的条目（只渲染上限内） */
  const rows = (): MentionRow[] => {
    const current: FileEntry = {
      name: dir() ? (dir().split("/").pop() ?? "workspace") : "workspace",
      path: dir() || ".",
      is_dir: true,
      size: 0,
    }
    return [
      { entry: current, attachOnly: true },
      ...visible()
        .slice(0, MAX_RENDERED_ROWS)
        .map((entry) => ({ entry, attachOnly: false })),
    ]
  }

  /** 上移一级目录；已在根目录时无操作 */
  function goUp() {
    const parts = dir().split("/").filter(Boolean)
    if (parts.length === 0) return
    parts.pop()
    setQuery("")
    void load(parts.join("/"))
  }

  /** 进入子目录 */
  function enter(path: string) {
    setQuery("")
    void load(path)
  }

  /** 选中行：文件与文件夹都作为附件回调 */
  function attach(row: MentionRow | undefined) {
    if (row) props.onPick(row.entry)
  }

  /** 搜索框键盘：↑↓ 移动，Enter/Tab 添加，→ 进入目录，←/Backspace(空查询) 返回上级 */
  function handleKeyDown(e: KeyboardEvent) {
    const next = rows()
    if (next.length === 0) return
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        e.stopPropagation()
        setActive((i) => (i + 1) % next.length)
        break
      case "ArrowUp":
        e.preventDefault()
        e.stopPropagation()
        setActive((i) => (i - 1 + next.length) % next.length)
        break
      case "Enter":
      case "Tab":
        e.preventDefault()
        e.stopPropagation()
        attach(next[active()])
        break
      case "ArrowRight":
        e.preventDefault()
        e.stopPropagation()
        {
          const row = next[active()]
          if (row.entry.is_dir && !row.attachOnly) enter(row.entry.path)
        }
        break
      case "ArrowLeft":
        e.preventDefault()
        e.stopPropagation()
        if (query()) setQuery("")
        else goUp()
        break
      case "Backspace":
        // 查询为空时返回上级；有内容时保留正常删除行为
        if (!query()) {
          e.preventDefault()
          e.stopPropagation()
          goUp()
        }
        break
    }
  }

  // 选中行变化时保证可见（列表可能滚动）
  createEffect(() => {
    const i = active()
    rows()
    listRef?.querySelector<HTMLElement>(`[data-row-index="${i}"]`)?.scrollIntoView({ block: "nearest" })
  })

  return (
    <div class="absolute bottom-full left-0 z-30 mb-2 flex max-h-80 w-[420px] flex-col overflow-hidden rounded-xl border border-edge bg-base shadow-xl">
      <div class="shrink-0 border-b border-edge p-2">
        <input
          ref={inputRef}
          value={query()}
          role="combobox"
          aria-expanded="true"
          aria-controls="file-mention-list"
          aria-autocomplete="list"
          onInput={(e) => {
            setQuery(e.currentTarget.value)
            setActive(0)
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search files…"
          class="w-full bg-transparent text-[13px] leading-5 text-text outline-none placeholder:text-faint"
        />
      </div>

      {/* 面包屑：点击任意层级回退 */}
      <div class="flex shrink-0 flex-wrap items-center gap-1 border-b border-edge px-2 py-1.5">
        <For each={crumbs()}>
          {(c, i) => (
            <>
              <Show when={i() > 0}>
                <span class="text-[11px] text-faint">/</span>
              </Show>
              <button
                type="button"
                class="max-w-[120px] truncate rounded-[4px] px-1 text-[11px] text-muted transition-colors hover:bg-raised hover:text-text"
                onClick={() => void load(c.path)}
              >
                {c.name}
              </button>
            </>
          )}
        </For>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-1">
        <Show
          when={!error()}
          fallback={<div class="px-2 py-3 text-[12px] text-[#e5484d]">{error()}</div>}
        >
          <Show
            when={!loading()}
            fallback={<div class="px-2 py-3 text-center text-[12px] text-muted">Loading…</div>}
          >
            <div
              ref={listRef}
              id="file-mention-list"
              role="listbox"
              aria-label="Files and folders"
              class="flex flex-col gap-0.5"
            >
              <For each={rows()}>
                {(row, i) => (
                  <div
                    data-row-index={i()}
                    role="option"
                    aria-selected={active() === i()}
                    class="group flex items-center rounded-md transition-colors hover:bg-raised"
                    classList={{ "bg-raised": active() === i() }}
                  >
                    {/* 当前目录行只负责附加；普通目录主行负责下钻 */}
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={row.attachOnly ? "Attach this folder" : row.entry.name}
                      class="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-start text-[13px]"
                      onClick={() => {
                        if (row.attachOnly) {
                          attach(row)
                          return
                        }
                        if (row.entry.is_dir) {
                          enter(row.entry.path)
                          return
                        }
                        attach(row)
                      }}
                    >
                      <Show
                        when={row.entry.is_dir}
                        fallback={
                          <svg viewBox="0 0 16 16" class="size-3.5 shrink-0 text-faint" fill="none" stroke="currentColor" stroke-width="1.4">
                            <path d="M4 2.5h5l3 3v8H4z" stroke-linejoin="round" />
                          </svg>
                        }
                      >
                        <svg viewBox="0 0 16 16" class="size-3.5 shrink-0 text-muted" fill="none" stroke="currentColor" stroke-width="1.4">
                          <path d="M2 5.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1H8L6.5 4H3a1 1 0 0 0-1 1v.5Z" stroke-linejoin="round" />
                        </svg>
                      </Show>
                      <span class="min-w-0 flex-1 truncate text-text">
                        {row.attachOnly ? "Attach this folder" : row.entry.path}
                      </span>
                      <span class="max-w-[150px] shrink-0 truncate text-[11px] text-faint">
                        {row.attachOnly
                          ? dir() || "/"
                          : row.entry.is_dir
                            ? "→"
                            : row.entry.size > 0
                              ? `${row.entry.size} B`
                              : ""}
                      </span>
                    </button>
                    {/* 目录额外提供「作为附件」按钮：Enter/Esc 之外也可用鼠标直接附加 */}
                    <Show when={row.entry.is_dir && !row.attachOnly}>
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={`Attach folder ${row.entry.name}`}
                        title="Attach folder"
                        class="mr-1 flex size-6 shrink-0 items-center justify-center rounded-[4px] text-muted opacity-0 transition-opacity hover:bg-edge hover:text-text group-hover:opacity-100"
                        onClick={() => attach(row)}
                      >
                        <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.6">
                          <path d="M8 3.5v9M3.5 8h9" stroke-linecap="round" />
                        </svg>
                      </button>
                    </Show>
                  </div>
                )}
              </For>
              <Show when={visible().length === 0}>
                <div class="px-2 py-3 text-center text-[12px] text-faint">No files in this folder</div>
              </Show>
              {/* 递归结果超出渲染上限时提示缩小搜索，而不是静默截断 */}
              <Show when={visible().length > MAX_RENDERED_ROWS}>
                <div class="px-2 py-2 text-center text-[11px] text-faint">
                  Showing first {MAX_RENDERED_ROWS} of {visible().length} matches — refine the search
                </div>
              </Show>
            </div>
          </Show>
        </Show>
      </div>

      <div class="flex shrink-0 items-center gap-2 border-t border-edge px-2 py-1.5 text-[10px] text-faint">
        <span>↑↓ 选择</span>
        <span>Enter/Tab 添加</span>
        <span>→ 进入文件夹</span>
        <span>← 返回</span>
        <span>搜索覆盖子目录</span>
      </div>
    </div>
  )
}
