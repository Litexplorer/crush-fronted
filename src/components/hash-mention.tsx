/**
 * hash-mention.tsx
 * 参数：wsId workspace ID；onPick 选中候选回调；onClose 关闭回调
 * 核心流程：Composer 的 # 引用浮层 ——
 *           打开时并行加载 skills 与 mcp states → 顶部搜索框过滤 →
 *           键盘/鼠标选中后回调，由调用方决定插入文本或附加正文
 */
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { buildMentionItems, filterMentionItems, loadMentionSources, type MentionItem } from "../lib/mentions"
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

export default function HashMention(props: {
  wsId: string
  onPick: (item: MentionItem) => void
  onClose: () => void
}) {
  const [all, setAll] = createSignal<MentionItem[]>([])
  const [query, setQuery] = createSignal("")
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [active, setActive] = createSignal(0)
  let inputRef: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined

  /** 过滤后候选：search 走名称/描述分档匹配 */
  const rows = () => filterMentionItems(all(), query())

  /**
   * load
   * 参数：无
   * 核心流程：并行拉取 skills 与 mcp → 合并成候选列表；失败进入行内错误态
   */
  async function load() {
    setLoading(true)
    setError("")
    try {
      const sources = await loadMentionSources(props.wsId)
      setAll(buildMentionItems(sources))
    } catch (err) {
      setError(errorMessage(err))
    }
    setLoading(false)
    queueMicrotask(() => inputRef?.focus())
  }

  onMount(() => {
    // 打开即加载候选并聚焦搜索框，键盘可直接接管
    void load()
    queueMicrotask(() => inputRef?.focus())
  })

  // Escape 关闭；挂在 document 上，焦点在列表按钮时也能关闭
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

  /**
   * handleKeyDown
   * 参数：e 搜索框键盘事件
   * 核心流程：↑↓ 循环移动 → Enter/Tab 选中当前行；其余按键留给输入框
   */
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
        props.onPick(next[active()])
        break
    }
  }

  // 选中行变化时保证可见
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
          aria-controls="hash-mention-list"
          aria-autocomplete="list"
          onInput={(e) => {
            setQuery(e.currentTarget.value)
            setActive(0)
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search skills and MCP servers…"
          class="w-full bg-transparent text-[13px] leading-5 text-text outline-none placeholder:text-faint"
        />
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
            <div ref={listRef} id="hash-mention-list" role="listbox" aria-label="Skills and MCP servers" class="flex flex-col gap-0.5">
              <For each={rows()}>
                {(item, i) => (
                  <button
                    type="button"
                    data-row-index={i()}
                    role="option"
                    aria-selected={active() === i()}
                    class="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start text-[13px] transition-colors hover:bg-raised"
                    classList={{ "bg-raised": active() === i() }}
                    onMouseEnter={() => setActive(i())}
                    onClick={() => props.onPick(item)}
                  >
                    <Show
                      when={item.kind === "skill"}
                      fallback={
                        <svg viewBox="0 0 16 16" class="size-3.5 shrink-0 text-muted" fill="none" stroke="currentColor" stroke-width="1.4">
                          <path d="M5 3.5v3M11 3.5v3M3.5 6.5h9v2a4.5 4.5 0 0 1-9 0v-2Z" stroke-linejoin="round" />
                          <path d="M8 13v1.5" stroke-linecap="round" />
                        </svg>
                      }
                    >
                      <svg viewBox="0 0 16 16" class="size-3.5 shrink-0 text-accent" fill="none" stroke="currentColor" stroke-width="1.4">
                        <path d="M3.5 3.5h9v9h-9z" stroke-linejoin="round" />
                        <path d="M6 6.5h4M6 9h4" stroke-linecap="round" />
                      </svg>
                    </Show>
                    <span class="shrink-0 max-w-[140px] truncate text-text">{item.name}</span>
                    <span class="min-w-0 flex-1 truncate text-[11px] text-faint">
                      {item.kind === "skill"
                        ? item.description
                        : item.toolCount > 0
                          ? `${item.toolCount} tools`
                          : "MCP server"}
                    </span>
                    <span class="shrink-0 rounded-[4px] border border-edge px-1 text-[10px] text-faint">
                      {item.kind === "skill" ? "skill" : "mcp"}
                    </span>
                  </button>
                )}
              </For>
              <Show when={rows().length === 0}>
                <div class="px-2 py-3 text-center text-[12px] text-faint">
                  {all().length === 0 ? "No skills or MCP servers" : "No matches"}
                </div>
              </Show>
            </div>
          </Show>
        </Show>
      </div>

      <div class="flex shrink-0 items-center gap-2 border-t border-edge px-2 py-1.5 text-[10px] text-faint">
        <span>↑↓ 选择</span>
        <span>Enter/Tab 插入</span>
        <span>Esc 关闭</span>
      </div>
    </div>
  )
}
