/**
 * inline-title.tsx
 * 核心流程：标题行内编辑 —— 默认渲染文本，双击（或聚焦后 F2）进入 input；
 *           Enter/失焦提交、Esc 取消；提交前 trim，空值或未改动直接退出编辑
 */
import { Show, createSignal } from "solid-js"

export interface InlineTitleProps {
  value: string
  onCommit: (title: string) => Promise<void> | void
  /** 进入/退出编辑态的回调：调用方据此暂停拖拽、屏蔽点击等 */
  onEditingChange?: (editing: boolean) => void
  class?: string
  inputClass?: string
  maxLength?: number
}

export function InlineTitle(props: InlineTitleProps) {
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  let inputRef: HTMLInputElement | undefined

  // 进入编辑：草稿灌入当前标题并全选，省掉手动清空
  function begin() {
    setDraft(props.value)
    setEditing(true)
    props.onEditingChange?.(true)
    queueMicrotask(() => {
      inputRef?.focus()
      inputRef?.select()
    })
  }

  // 退出编辑：统一走这里，保证回调与状态同步
  function stop() {
    setEditing(false)
    props.onEditingChange?.(false)
  }

  // 提交：trim 后为空或与原文一致就只退出编辑，不发请求
  async function commit() {
    if (!editing()) return
    const next = draft().trim()
    stop()
    if (!next || next === props.value.trim()) return
    await props.onCommit(next)
  }

  return (
    <Show
      when={editing()}
      fallback={
        <span
          class={props.class}
          tabIndex={0}
          title="双击重命名"
          onDblClick={begin}
          onKeyDown={(event) => {
            if (event.key === "F2") {
              event.preventDefault()
              begin()
            }
          }}
        >
          {props.value}
        </span>
      }
    >
      <input
        ref={inputRef}
        class={props.inputClass}
        value={draft()}
        maxLength={props.maxLength ?? 80}
        spellcheck={false}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          // 编辑态吞掉按键，避免方向键把时间线拽走
          event.stopPropagation()
          if (event.key === "Enter") {
            event.preventDefault()
            void commit()
          } else if (event.key === "Escape") {
            event.preventDefault()
            stop()
          }
        }}
      />
    </Show>
  )
}
