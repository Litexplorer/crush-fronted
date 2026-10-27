/**
 * command-palette.tsx
 * 参数：open 是否显示；onClose 关闭回调
 * 核心流程：Ctrl+K 全局面板 ——
 *           数据来源两路：已打开的标签（跨项目）、固定动作（历史会话 / 新建会话 / 标签列表 /
 *           快捷键说明 / 布局 / 回首页）；历史会话单独一个浮层，不挤占首屏；
 *           输入按子序列模糊过滤，↑↓ 选择、Enter 执行、Esc 或点击外部关闭
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { ensureLiveWorkspace, newSession, sessionUrl } from "../lib/session-actions"
import {
  ensureSessionTab,
  openHistoryDialog,
  openModelDialog,
  openQuestionDialog,
  openSessions,
  openShortcutHelp,
  openTabSwitcher,
  toggleTabsOrientation,
  type ActiveSession,
} from "../lib/ui-store"
import { selectedWorkspace } from "../lib/workspace-store"
import { isSessionRunning } from "../lib/run-status"

interface PaletteItem {
  /** 去重与键盘高亮用的稳定键 */
  id: string
  kind: "session" | "action"
  label: string
  /** 次要说明：项目路径、消息数、快捷键 */
  hint?: string
  /** 右侧状态标记：运行中 / 标签 / 动作 */
  tag?: string
  /** 执行体；抛错时面板不关闭并展示原因 */
  run: () => Promise<void> | void
}

/**
 * fuzzyScore
 * 参数：label 候选项标题；query 输入
 * 核心流程：优先整段包含（命中位置越靠前分越高）；
 *           否则退回子序列匹配（按顺序逐个命中，越紧凑分越高），完全不命中返回 undefined
 */
function fuzzyScore(label: string, query: string): number | undefined {
  const text = label.toLowerCase()
  const needle = query.toLowerCase()
  const direct = text.indexOf(needle)
  if (direct >= 0) return 1000 - direct
  let score = 0
  let from = 0
  for (const char of needle) {
    const at = text.indexOf(char, from)
    if (at < 0) return undefined
    score += Math.max(1, 40 - at)
    from = at + 1
  }
  return score
}

export default function CommandPalette(props: { open: boolean; onClose: () => void }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [query, setQuery] = createSignal("")
  const [activeIndex, setActiveIndex] = createSignal(0)
  const [notice, setNotice] = createSignal("")
  let inputRef: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined

  // 当前工作区：优先取路由参数，其次取已选中的工作区（首页场景）
  const workspaceId = createMemo(() => {
    const match = /^\/w\/([^/?#]+)/.exec(location.pathname)
    if (match) return decodeURIComponent(match[1])
    return selectedWorkspace()?.id
  })

  /**
   * openSession
   * 参数：tab 目标会话（来自标签或工作区会话列表）
   * 核心流程：按项目路径解析有效工作区 → 登记/激活标签 → 跳转会话页
   */
  async function openSession(tab: ActiveSession) {
    const wsId = await ensureLiveWorkspace(tab.projectPath, tab.workspaceId)
    const target = { ...tab, workspaceId: wsId ?? tab.workspaceId }
    ensureSessionTab(target)
    navigate(sessionUrl(target))
  }

  // 打开时重置输入与高亮，并把焦点交给搜索框（不自动聚焦的话键盘操作要再一次点击）
  createEffect(() => {
    if (!props.open) return
    setQuery("")
    setActiveIndex(0)
    setNotice("")
    queueMicrotask(() => inputRef?.focus())
  })

  /**
   * items
   * 参数：无
   * 核心流程：标签（跨项目，优先）→（可选）当前工作区历史会话 → 固定动作；
   *           再按输入过滤并保持原有顺序
   */
  const items = createMemo<PaletteItem[]>(() => {
    const tabs = openSessions()
    const wsId = workspaceId()

    const tabItems: PaletteItem[] = tabs.map((tab) => ({
      id: `session:${tab.id}`,
      kind: "session",
      label: tab.title || "Untitled",
      hint: tab.projectPath ?? "",
      tag: isSessionRunning(tab.id) ? "运行中" : "标签",
      run: () => openSession(tab),
    }))

    const actionItems: PaletteItem[] = [
      {
        id: "action:session-history",
        kind: "action",
        label: "显示历史会话",
        hint: "按更新时间列出本项目全部会话",
        tag: "视图",
        run: () => openHistoryDialog(),
      },
      {
        id: "action:session-questions",
        kind: "action",
        label: "显示本会话提问",
        hint: "前缀 + Q：可搜索，Enter 跳转",
        tag: "视图",
        run: () => openQuestionDialog(),
      },
      {
        id: "action:model-list",
        kind: "action",
        label: "切换模型",
        hint: "前缀 + M：列出当前工作区全部模型，可搜索",
        tag: "动作",
        run: () => openModelDialog(),
      },
      {
        id: "action:new-session",
        kind: "action",
        label: "新建会话",
        hint: "Ctrl+B 后按 N 同效",
        tag: "动作",
        run: async () => {
          const ws = selectedWorkspace()
          const path = ws?.path ?? openSessions().find((tab) => tab.workspaceId === wsId)?.projectPath
          const result = await newSession({ workspaceId: ws?.id ?? wsId, projectPath: path })
          if (!result.ok) throw new Error(result.error)
          navigate(sessionUrl(result.tab))
        },
      },
      {
        id: "action:tab-switcher",
        kind: "action",
        label: "显示标签列表",
        hint: "前缀 + G：按项目分组，可搜索",
        tag: "视图",
        run: () => openTabSwitcher(),
      },
      {
        id: "action:shortcut-help",
        kind: "action",
        label: "快捷键说明",
        hint: "前缀 + ?",
        tag: "视图",
        run: () => openShortcutHelp(),
      },
      {
        id: "action:toggle-tabs-orientation",
        kind: "action",
        label: "切换标签栏布局（横向 / 纵向）",
        hint: "也影响 Ctrl+方向键的切换轴",
        tag: "动作",
        run: () => toggleTabsOrientation(),
      },
      {
        id: "action:home",
        kind: "action",
        label: "回到首页",
        hint: "选择工作区并新建会话",
        tag: "动作",
        run: () => navigate("/"),
      },
    ]

    const all = [...tabItems, ...actionItems]
    const needle = query().trim()
    if (!needle) return all
    return all
      .map((item) => {
        const byLabel = fuzzyScore(item.label, needle)
        // 标题不命中时允许命中路径/说明，方便按项目名找会话
        const byHint = item.hint ? fuzzyScore(item.hint, needle) : undefined
        const score = byLabel ?? (byHint === undefined ? undefined : byHint - 500)
        return { item, score }
      })
      .filter((entry): entry is { item: PaletteItem; score: number } => entry.score !== undefined)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item)
  })

  /**
   * execute
   * 参数：item 选中的条目
   * 核心流程：执行并关闭；执行抛错时保持面板打开并提示原因
   */
  async function execute(item: PaletteItem) {
    try {
      await item.run()
      props.onClose()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "执行失败")
    }
  }

  /**
   * moveActive
   * 参数：delta 相对位移
   * 核心流程：在过滤结果里上下移动高亮并首尾循环
   */
  function moveActive(delta: number) {
    const total = items().length
    if (total === 0) return
    setActiveIndex((prev) => (prev + delta + total) % total)
  }

  // 高亮项滚动进视野：列表可能超出面板高度
  createEffect(() => {
    const index = activeIndex()
    if (!props.open) return
    queueMicrotask(() => {
      const el = listRef?.querySelector<HTMLElement>(`[data-palette-index="${index}"]`)
      el?.scrollIntoView({ block: "nearest" })
    })
  })

  onMount(() => {
    /**
     * handleKeydown
     * 参数：event 全局键盘事件
     * 核心流程：面板打开时拦截 Esc 关闭与整体焦点（方向键在输入框上处理）
     */
    const handleKeydown = (event: KeyboardEvent) => {
      if (!props.open || event.key !== "Escape") return
      event.preventDefault()
      props.onClose()
    }
    document.addEventListener("keydown", handleKeydown)
    onCleanup(() => document.removeEventListener("keydown", handleKeydown))
  })

  /**
   * handleInputKeyDown
   * 参数：event 搜索框键盘事件
   * 核心流程：↑↓ 移动高亮、Enter 执行当前项；输入法组词时不拦截
   */
  function handleInputKeyDown(event: KeyboardEvent) {
    if (event.isComposing) return
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      moveActive(event.key === "ArrowDown" ? 1 : -1)
      return
    }
    if (event.key !== "Enter") return
    event.preventDefault()
    const item = items()[activeIndex()]
    if (item) void execute(item)
  }

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]" onClick={props.onClose}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          class="flex max-h-[70vh] w-[560px] max-w-full flex-col overflow-hidden rounded-xl border border-edge bg-base shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <input
            ref={inputRef}
            value={query()}
            onInput={(event) => {
              setQuery(event.currentTarget.value)
              setActiveIndex(0)
            }}
            onKeyDown={handleInputKeyDown}
            placeholder="搜索会话或输入命令…"
            aria-label="Search sessions and commands"
            class="h-11 w-full shrink-0 border-b border-edge bg-transparent px-3 text-[13px] text-text outline-none placeholder:text-faint"
          />
          <div ref={listRef} role="listbox" aria-label="Commands" class="min-h-0 flex-1 overflow-y-auto py-1">
            <For each={items()}>
              {(item, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index() === activeIndex()}
                  data-palette-index={index()}
                  class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors"
                  classList={{
                    "bg-raised text-text": index() === activeIndex(),
                    "text-muted hover:bg-raised/60": index() !== activeIndex(),
                  }}
                  onMouseEnter={() => setActiveIndex(index())}
                  onClick={() => void execute(item)}
                >
                  <span class="size-1.5 shrink-0 rounded-full" classList={{ "bg-accent": item.kind === "session", "bg-edge-strong": item.kind === "action" }} aria-hidden="true" />
                  <span class="min-w-0 flex-1 truncate">{item.label}</span>
                  <Show when={item.hint}>
                    <span class="max-w-[45%] shrink-0 truncate text-[11px] text-faint">{item.hint}</span>
                  </Show>
                  <Show when={item.tag}>
                    <span class="shrink-0 rounded-[4px] bg-raised px-1 py-0.5 text-[10px] text-muted">{item.tag}</span>
                  </Show>
                </button>
              )}
            </For>
            <Show when={items().length === 0}>
              <p class="px-3 py-6 text-center text-[12px] text-faint">没有匹配项</p>
            </Show>
          </div>
          <div class="flex shrink-0 items-center justify-between border-t border-edge px-3 py-1.5 text-[10px] text-faint">
            <span>↑↓ 选择 · Enter 打开 · Esc 关闭</span>
            <Show when={notice()}>
              <span class="text-[#e5484d]">{notice()}</span>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}
