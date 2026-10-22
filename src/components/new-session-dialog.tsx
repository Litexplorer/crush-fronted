/**
 * new-session-dialog.tsx
 * 参数：open 是否显示；currentTitle 当前会话标题（缺失表示无当前会话，覆盖不可用）；
 *       busy 创建中；onClose 关闭；onChoose 选择打开方式（tab 追加 / replace 覆盖当前标签位）
 * 核心流程：新建会话的询问弹窗 —— 两个选项 + 键盘收起；
 *           覆盖当前只替换标签位，旧会话仍留在历史里，因此不做二次确认
 */
import { createEffect, onCleanup, onMount, Show } from "solid-js"

export type NewSessionMode = "tab" | "replace"

export default function NewSessionDialog(props: {
  open: boolean
  currentTitle?: string
  busy: boolean
  onClose: () => void
  onChoose: (mode: NewSessionMode) => void
}) {
  let tabButtonRef: HTMLButtonElement | undefined

  onMount(() => {
    /**
     * handleKeydown
     * 参数：event 键盘事件
     * 核心流程：Esc 关闭，屏蔽弹窗内的默认滚动行为
     */
    const handleKeydown = (event: KeyboardEvent) => {
      if (!props.open) return
      if (event.key !== "Escape") return
      event.preventDefault()
      props.onClose()
    }
    document.addEventListener("keydown", handleKeydown)
    onCleanup(() => document.removeEventListener("keydown", handleKeydown))
  })

  createEffect(() => {
    // 打开时把焦点放到默认项，避免弹窗出现后键盘操作断档
    if (props.open) queueMicrotask(() => tabButtonRef?.focus())
  })

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/50 px-4" onClick={props.onClose}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="New session"
          class="flex w-full max-w-sm flex-col overflow-hidden rounded-[10px] border border-edge bg-base shadow-xl"
          onClick={(event) => event.stopPropagation()}
        >
          <div class="flex shrink-0 items-center justify-between border-b border-edge px-4 py-3">
            <h2 class="text-[15px] font-semibold text-text">New session</h2>
            <button
              type="button"
              aria-label="Close dialog"
              class="flex size-7 items-center justify-center rounded-[6px] text-muted transition-colors hover:bg-raised hover:text-text"
              onClick={props.onClose}
            >
              <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke-linecap="round" />
              </svg>
            </button>
          </div>

          <div class="flex flex-col gap-2 p-3">
            {/* 选项一：追加标签，当前会话原样保留 */}
            <button
              type="button"
              ref={tabButtonRef}
              disabled={props.busy}
              class="flex flex-col items-start gap-0.5 rounded-[8px] border border-edge px-3 py-2.5 text-left transition-colors hover:border-edge-strong hover:bg-raised disabled:opacity-40"
              onClick={() => props.onChoose("tab")}
            >
              <span class="text-[13px] font-medium text-text">Open in new tab</span>
              <span class="text-[11px] text-faint">Keep the current session open</span>
            </button>

            {/* 选项二：占用当前标签位，替代原会话展示位置 */}
            <button
              type="button"
              disabled={props.busy || !props.currentTitle}
              class="flex flex-col items-start gap-0.5 rounded-[8px] border border-edge px-3 py-2.5 text-left transition-colors hover:border-edge-strong hover:bg-raised disabled:opacity-40"
              onClick={() => props.onChoose("replace")}
            >
              <span class="text-[13px] font-medium text-text">Replace current tab</span>
              <span class="line-clamp-2 text-[11px] text-faint">
                {props.currentTitle
                  ? `Take over the tab of "${props.currentTitle}". The session stays in history.`
                  : "No current session to replace"}
              </span>
            </button>
          </div>

          <div class="flex shrink-0 items-center justify-between border-t border-edge px-4 py-2 text-[11px] text-faint">
            <span>Esc to cancel</span>
            <span>Ctrl+Shift+N replaces directly</span>
          </div>
        </div>
      </div>
    </Show>
  )
}
