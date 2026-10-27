/**
 * tab-switcher.tsx
 * 参数：无（开关与开关函数来自全局 ui-store）
 * 核心流程：前缀 + G 唤起的标签列表 ——
 *           按项目分组列出已打开的会话标签，顶部搜索框按会话标题 / 项目名过滤，
 *           ↑↓ 选择、Enter 打开、Esc 或点击遮罩关闭；当前会话高亮，运行中的标签带转圈
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import {
  closeTabSwitcher,
  openSessions,
  setActiveSession,
  tabSwitcherOpen,
  type ActiveSession,
} from "../lib/ui-store"
import { groupSessionTabs } from "../lib/session-groups"
import { ensureLiveWorkspace, sessionUrl } from "../lib/session-actions"
import { isSessionRunning } from "../lib/run-status"

/**
 * routeSessionId
 * 参数：pathname 当前路由路径
 * 核心流程：提取 /session/:id 的最后一段并解码，用于高亮当前会话
 */
function routeSessionId(pathname: string): string {
  const match = /\/session\/([^/]+)\/?$/.exec(pathname)
  if (!match) return ""
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

export default function TabSwitcher() {
  const navigate = useNavigate()
  const location = useLocation()
  const [query, setQuery] = createSignal("")
  const [activeIndex, setActiveIndex] = createSignal(0)
  let inputRef: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined

  const currentSessionId = () => routeSessionId(location.pathname)

  /**
   * groups
   * 参数：无
   * 核心流程：按项目分组后按关键词过滤（会话标题或项目名命中即可），丢弃空分组，
   *           保证列表里不会出现只剩标题的空壳
   */
  const groups = createMemo(() => {
    const needle = query().trim().toLowerCase()
    return groupSessionTabs(openSessions())
      .map((group) => ({
        ...group,
        tabs: needle
          ? group.tabs.filter(
              (tab) =>
                (tab.title || "Untitled").toLowerCase().includes(needle) || group.label.toLowerCase().includes(needle),
            )
          : group.tabs,
      }))
      .filter((group) => group.tabs.length > 0)
  })

  /** 展平后的可见顺序：键盘上下移动以它为准，与渲染顺序一致 */
  const flatTabs = createMemo<ActiveSession[]>(() => groups().flatMap((group) => group.tabs))

  /** 选中项在展平列表里的下标：渲染时用于判断高亮 */
  const indexOfTab = (tab: ActiveSession) => flatTabs().findIndex((candidate) => candidate.id === tab.id)

  // 打开时重置搜索与高亮，并把焦点交给搜索框
  createEffect(() => {
    if (!tabSwitcherOpen()) return
    setQuery("")
    setActiveIndex(0)
    queueMicrotask(() => inputRef?.focus())
  })

  /**
   * openTab
   * 参数：tab 目标标签
   * 核心流程：先按项目路径解析有效工作区（服务端重启后 id 会变）→ 设为当前会话并跳转 → 关闭浮层
   */
  async function openTab(tab: ActiveSession) {
    const workspaceId = await ensureLiveWorkspace(tab.projectPath, tab.workspaceId)
    const target = { ...tab, workspaceId: workspaceId ?? tab.workspaceId }
    setActiveSession(target)
    closeTabSwitcher()
    navigate(sessionUrl(target))
  }

  /**
   * moveActive
   * 参数：delta 相对位移
   * 核心流程：在展平列表里上下移动高亮并首尾循环
   */
  function moveActive(delta: number) {
    const total = flatTabs().length
    if (total === 0) return
    setActiveIndex((prev) => (prev + delta + total) % total)
  }

  // 高亮项滚动进视野：列表可能超出面板高度
  createEffect(() => {
    const index = activeIndex()
    if (!tabSwitcherOpen()) return
    queueMicrotask(() => {
      listRef?.querySelector<HTMLElement>(`[data-switcher-index="${index}"]`)?.scrollIntoView({ block: "nearest" })
    })
  })

  onMount(() => {
    /**
     * handleKeydown
     * 参数：event 全局键盘事件
     * 核心流程：打开时 Esc 关闭；方向键在搜索框的 onKeyDown 里处理
     */
    const handleKeydown = (event: KeyboardEvent) => {
      if (!tabSwitcherOpen() || event.key !== "Escape") return
      event.preventDefault()
      closeTabSwitcher()
    }
    document.addEventListener("keydown", handleKeydown)
    onCleanup(() => document.removeEventListener("keydown", handleKeydown))
  })

  /**
   * handleInputKeyDown
   * 参数：event 搜索框键盘事件
   * 核心流程：↑↓ 移动高亮、Enter 打开当前项；输入法组词时不拦截
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
    const target = flatTabs()[activeIndex()]
    if (target) void openTab(target)
  }

  return (
    <Show when={tabSwitcherOpen()}>
      <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[14vh]" onClick={closeTabSwitcher}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Open tabs"
          class="flex max-h-[64vh] w-[440px] max-w-full flex-col overflow-hidden rounded-xl border border-edge bg-base shadow-2xl"
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
            placeholder="搜索标签…"
            aria-label="Search open tabs"
            class="h-10 w-full shrink-0 border-b border-edge bg-transparent px-3 text-[13px] text-text outline-none placeholder:text-faint"
          />
          <div ref={listRef} role="listbox" aria-label="Open tabs" class="min-h-0 flex-1 overflow-y-auto py-1">
            <For each={groups()}>
              {(group) => (
                <div class="mb-1">
                  {/* 分组头：项目名 + 色条，与顶栏的分组顺序、配色保持一致 */}
                  <div class="flex items-center gap-1.5 px-3 pb-1 pt-2">
                    <span
                      aria-hidden="true"
                      class="h-2.5 w-[2px] shrink-0 rounded-full"
                      style={{ "background-color": group.solid ?? "transparent" }}
                    />
                    <span class="truncate text-[10px] font-semibold uppercase tracking-wide text-faint">{group.label}</span>
                    <span class="text-[10px] text-faint">{group.tabs.length}</span>
                  </div>
                  <For each={group.tabs}>
                    {(tab) => {
                      const index = () => indexOfTab(tab)
                      const active = () => index() === activeIndex()
                      const current = () => tab.id === currentSessionId()
                      return (
                        <button
                          type="button"
                          role="option"
                          aria-selected={active()}
                          data-switcher-index={index()}
                          data-switcher-tab={tab.id}
                          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors"
                          classList={{
                            "bg-raised text-text": active(),
                            "text-muted hover:bg-raised/60": !active(),
                          }}
                          onMouseEnter={() => setActiveIndex(index())}
                          onClick={() => void openTab(tab)}
                        >
                          <span
                            aria-hidden="true"
                            class="size-1.5 shrink-0 rounded-full"
                            style={{ "background-color": group.solid ?? "transparent" }}
                          />
                          <span class="min-w-0 flex-1 truncate">{tab.title || "Untitled"}</span>
                          <Show when={isSessionRunning(tab.id)}>
                            <svg
                              viewBox="0 0 16 16"
                              class="size-3 shrink-0 animate-spin text-accent"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="1.6"
                              role="status"
                              aria-label="Running"
                            >
                              <path d="M8 2.5a5.5 5.5 0 1 0 5.5 5.5" stroke-linecap="round" />
                            </svg>
                          </Show>
                          <Show when={current()}>
                            <span class="shrink-0 text-[10px] text-accent">current</span>
                          </Show>
                        </button>
                      )
                    }}
                  </For>
                </div>
              )}
            </For>
            <Show when={groups().length === 0}>
              <p class="px-3 py-6 text-center text-[12px] text-faint">没有匹配的标签</p>
            </Show>
          </div>
          <div class="flex shrink-0 items-center justify-between border-t border-edge px-3 py-1.5 text-[10px] text-faint">
            <span>↑↓ 选择 · Enter 打开 · Esc 关闭</span>
            <span>{openSessions().length} 个标签</span>
          </div>
        </div>
      </div>
    </Show>
  )
}
