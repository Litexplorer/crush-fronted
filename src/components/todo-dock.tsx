/**
 * todo-dock.tsx
 * 核心流程：会话待办 Dock —— 头部展示完成进度与折叠态当前项预览，
 *           展开后按 parent 层级缩进列出全部条目；
 *           完成项勾选并划线，进行项用强调色圆点标记。
 */
import { For, Show, createMemo } from "solid-js"
import type { SessionTodo } from "../lib/sessions"

/**
 * todoDepths
 * 参数：todos 待办列表
 * 核心流程：以 content 为键回溯 parent 链得到缩进层级；
 *           遇到环引用或缺失父项立即停止，避免死循环
 */
function todoDepths(todos: SessionTodo[]): Map<string, number> {
  const parentOf = new Map(todos.map((todo) => [todo.content, todo.parent ?? ""]))
  const depths = new Map<string, number>()
  for (const todo of todos) {
    let depth = 0
    const seen = new Set([todo.content])
    let cur = todo.parent ?? ""
    while (cur) {
      if (seen.has(cur) || !parentOf.has(cur)) break
      seen.add(cur)
      depth++
      cur = parentOf.get(cur) ?? ""
    }
    depths.set(todo.content, depth)
  }
  return depths
}

/**
 * activeTodo
 * 参数：todos 待办列表
 * 核心流程：优先进行中，其次第一个待办，最后回落到末条（通常已完成）
 */
function activeTodo(todos: SessionTodo[]): SessionTodo | undefined {
  return (
    todos.find((todo) => todo.status === "in_progress") ??
    todos.find((todo) => todo.status === "pending") ??
    todos[todos.length - 1]
  )
}

/**
 * StatusIcon
 * 参数：status 待办状态（pending / in_progress / completed）
 * 核心流程：完成渲染勾选圈，进行中渲染脉冲圆点，其余渲染空心圈
 */
function StatusIcon(props: { status: string }) {
  return (
    <Show
      when={props.status === "completed"}
      fallback={
        <Show
          when={props.status === "in_progress"}
          fallback={<span class="mt-[5px] size-2.5 shrink-0 rounded-full border border-faint/60" />}
        >
          <span class="mt-[3px] flex size-3 shrink-0 items-center justify-center">
            <span class="size-2 animate-pulse rounded-full bg-accent" />
          </span>
        </Show>
      }
    >
      <svg
        viewBox="0 0 16 16"
        class="mt-[3px] size-3 shrink-0"
        fill="none"
        stroke="var(--status-connected)"
        stroke-width="1.6"
      >
        <circle cx="8" cy="8" r="6" />
        <path d="m5 8 2 2 4-4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </Show>
  )
}

/**
 * TodoDock
 * 参数：todos 会话待办；collapsed 折叠态；onToggle 折叠切换回调
 * 核心流程：无待办时不渲染（宿主负责判断）；头部进度 + 预览，展开列表按层级缩进
 */
export default function TodoDock(props: {
  todos: SessionTodo[]
  collapsed: boolean
  onToggle: () => void
}) {
  const total = createMemo(() => props.todos.length)
  const done = createMemo(() => props.todos.filter((todo) => todo.status === "completed").length)
  const depths = createMemo(() => todoDepths(props.todos))
  const preview = createMemo(() => activeTodo(props.todos)?.content ?? "")

  return (
    <div class="mb-2 overflow-hidden rounded-xl border border-edge bg-base">
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-raised"
        aria-expanded={!props.collapsed}
        aria-label={props.collapsed ? "Expand todos" : "Collapse todos"}
        onClick={props.onToggle}
      >
        <svg viewBox="0 0 16 16" class="size-3.5 shrink-0 text-muted" fill="none" stroke="currentColor" stroke-width="1.4">
          <path d="M3 8.5 5.5 11 8 8.5 10.5 11 13 8.5" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M3 4.5h10" stroke-linecap="round" />
        </svg>
        <span class="shrink-0 text-[12px] font-medium tabular-nums text-text">
          {done()}/{total()}
        </span>
        <Show when={props.collapsed}>
          <span class="min-w-0 flex-1 truncate text-[12px] text-faint">{preview()}</span>
        </Show>
        <svg
          viewBox="0 0 16 16"
          class="ml-auto size-3.5 shrink-0 text-faint transition-transform"
          classList={{ "rotate-180": !props.collapsed }}
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
        >
          <path d="m4 6 4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <Show when={!props.collapsed}>
        <div class="max-h-[180px] overflow-y-auto border-t border-edge px-3 py-2">
          <For each={props.todos}>
            {(todo) => (
              <div
                class="flex items-start gap-2 py-0.5"
                style={{ "padding-left": `${(depths().get(todo.content) ?? 0) * 14}px` }}
              >
                <StatusIcon status={todo.status} />
                <span
                  class="min-w-0 break-words text-[12px] leading-5"
                  classList={{
                    "text-faint line-through": todo.status === "completed",
                    "text-text": todo.status === "in_progress",
                    "text-muted": todo.status !== "completed" && todo.status !== "in_progress",
                  }}
                  title={todo.status === "in_progress" ? todo.active_form || todo.content : todo.content}
                >
                  {todo.content}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
