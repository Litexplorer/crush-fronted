/**
 * question-dialog.tsx
 * 参数：无（开关与关闭函数来自全局 ui-store）
 * 核心流程：前缀 + Q 唤起的「本会话问题」列表 ——
 *           数据由会话页发布（lib/session-questions），按时间倒序展示、可搜索；
 *           ↑↓ 选择、Enter 让会话页滚动到对应消息并高亮、Esc 或点击遮罩关闭
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useLocation } from "@solidjs/router"
import { closeQuestionDialog, questionDialogOpen } from "../lib/ui-store"
import { questionIndex, requestQuestionJump, type SessionQuestion } from "../lib/session-questions"

/**
 * routeSessionId
 * 参数：pathname 当前路由路径
 * 核心流程：提取 /session/:id 的最后一段并解码，用于判断浮层是否有可展示的会话
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

/**
 * formatTime
 * 参数：seconds Unix 秒
 * 核心流程：转为本地 时:分 文本；无效时间返回空串
 */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ""
  return new Date(seconds * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

export default function QuestionDialog() {
  const location = useLocation()
  const [query, setQuery] = createSignal("")
  const [activeIndex, setActiveIndex] = createSignal(0)
  let inputRef: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined

  const currentSessionId = () => routeSessionId(location.pathname)

  /** 只有当前会话发布过索引才展示；切走会话后视为空 */
  const questions = createMemo<SessionQuestion[]>(() => {
    const index = questionIndex()
    if (!currentSessionId() || index.sessionId !== currentSessionId()) return []
    return index.items
  })

  /**
   * filtered
   * 参数：无
   * 核心流程：按输入过滤（预览或全文命中即可），倒序排列让最近的提问排在最前
   */
  const filtered = createMemo<SessionQuestion[]>(() => {
    const needle = query().trim().toLowerCase()
    const list = needle
      ? questions().filter(
          (item) => item.preview.toLowerCase().includes(needle) || item.text.toLowerCase().includes(needle),
        )
      : questions()
    return [...list].reverse()
  })

  // 打开时重置搜索与高亮，并把焦点交给搜索框
  createEffect(() => {
    if (!questionDialogOpen()) return
    setQuery("")
    setActiveIndex(0)
    queueMicrotask(() => inputRef?.focus())
  })

  /**
   * jump
   * 参数：item 选中的问句
   * 核心流程：把跳转请求发给会话页（由它滚动 + 高亮），随后关闭浮层
   */
  function jump(item: SessionQuestion) {
    requestQuestionJump(currentSessionId(), item.messageId)
    closeQuestionDialog()
  }

  /**
   * moveActive
   * 参数：delta 相对位移
   * 核心流程：在过滤结果里上下移动高亮并首尾循环
   */
  function moveActive(delta: number) {
    const total = filtered().length
    if (total === 0) return
    setActiveIndex((prev) => (prev + delta + total) % total)
  }

  // 高亮项滚动进视野：问题可能很多
  createEffect(() => {
    const index = activeIndex()
    if (!questionDialogOpen()) return
    queueMicrotask(() => {
      listRef?.querySelector<HTMLElement>(`[data-question-index="${index}"]`)?.scrollIntoView({ block: "nearest" })
    })
  })

  onMount(() => {
    /**
     * handleKeydown
     * 参数：event 全局键盘事件
     * 核心流程：打开时 Esc 关闭；方向键在搜索框的 onKeyDown 里处理
     */
    const handleKeydown = (event: KeyboardEvent) => {
      if (!questionDialogOpen() || event.key !== "Escape") return
      event.preventDefault()
      closeQuestionDialog()
    }
    document.addEventListener("keydown", handleKeydown)
    onCleanup(() => document.removeEventListener("keydown", handleKeydown))
  })

  /**
   * handleInputKeyDown
   * 参数：event 搜索框键盘事件
   * 核心流程：↑↓ 移动高亮、Enter 跳转；输入法组词时不拦截
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
    const target = filtered()[activeIndex()]
    if (target) jump(target)
  }

  return (
    <Show when={questionDialogOpen()}>
      <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[14vh]" onClick={closeQuestionDialog}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Session questions"
          class="flex max-h-[64vh] w-[460px] max-w-full flex-col overflow-hidden rounded-xl border border-edge bg-base shadow-2xl"
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
            placeholder="搜索本会话的提问…"
            aria-label="Search session questions"
            class="h-10 w-full shrink-0 border-b border-edge bg-transparent px-3 text-[13px] text-text outline-none placeholder:text-faint"
          />
          <div ref={listRef} role="listbox" aria-label="Session questions" class="min-h-0 flex-1 overflow-y-auto py-1">
            <For each={filtered()}>
              {(item, index) => {
                const active = () => index() === activeIndex()
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={active()}
                    data-question-index={index()}
                    data-question-message={item.messageId}
                    class="flex w-full items-start gap-2 px-3 py-1.5 text-left text-[12px] transition-colors"
                    classList={{
                      "bg-raised text-text": active(),
                      "text-muted hover:bg-raised/60": !active(),
                    }}
                    onMouseEnter={() => setActiveIndex(index())}
                    onClick={() => jump(item)}
                  >
                    <span class="mt-0.5 w-6 shrink-0 text-right text-[10px] text-faint">#{item.order}</span>
                    <span class="min-w-0 flex-1 truncate">{item.preview || item.text}</span>
                    <span class="shrink-0 text-[10px] text-faint">{formatTime(item.createdAt)}</span>
                    <span
                      class="shrink-0 rounded-[4px] px-1 py-0.5 text-[10px]"
                      classList={{
                        "bg-accent/15 text-accent": item.answered,
                        "bg-raised text-muted": !item.answered,
                      }}
                    >
                      {item.answered ? "已回复" : "未回复"}
                    </span>
                  </button>
                )
              }}
            </For>
            <Show when={filtered().length === 0}>
              <p class="px-3 py-6 text-center text-[12px] text-faint">
                {!currentSessionId() ? "请先打开一个会话" : questions().length === 0 ? "本会话还没有提问" : "没有匹配的提问"}
              </p>
            </Show>
          </div>
          <div class="flex shrink-0 items-center justify-between border-t border-edge px-3 py-1.5 text-[10px] text-faint">
            <span>↑↓ 选择 · Enter 跳转 · Esc 关闭</span>
            <span>{questions().length} 个提问</span>
          </div>
        </div>
      </div>
    </Show>
  )
}
