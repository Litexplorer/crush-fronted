/**
 * panel-questions.tsx
 * 核心流程：右侧问答索引 ——
 *           接收会话页从消息流派生的问句列表，按时间顺序渲染；
 *           点击条目回调宿主跳转到对应消息锚点；
 *           当前条目用 accent 淡背景标记，空会话展示占位文案。
 */
import { For, Show } from "solid-js"

/** 问答索引条目：由 session.tsx 从 user 消息派生 */
export interface QuestionItem {
  messageId: string
  order: number
  text: string
  preview: string
  createdAt: number
  answered: boolean
}

/**
 * formatTime
 * 参数：seconds Unix 秒
 * 核心流程：转为本地 时:分 文本；无效时间返回空串
 */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ""
  return new Date(seconds * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * QuestionIndex
 * 参数：questions 索引条目；activeId 当前选中消息 id；onJump 跳转回调
 * 核心流程：顶部展示问句总数 → 列表逐条渲染序号、预览、时间与回复状态；
 *           点击条目把 messageId 交给宿主完成滚动与高亮
 */
export default function QuestionIndex(props: {
  questions: QuestionItem[]
  activeId: string
  onJump: (messageId: string) => void
}) {
  return (
    <div class="flex min-h-0 flex-1 flex-col">
      {/* 索引头：问句数量 + 使用提示 */}
      <div class="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-edge px-3">
        <span class="text-[11px] font-medium text-muted">
          {props.questions.length} {props.questions.length === 1 ? "question" : "questions"}
        </span>
        <span class="truncate text-[10px] text-faint">Click to jump</span>
      </div>

      {/* 空会话：提示暂无问句 */}
      <Show
        when={props.questions.length > 0}
        fallback={
          <div class="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-[12px] text-faint">
            No questions yet
          </div>
        }
      >
        <div class="min-h-0 flex-1 overflow-y-auto">
          <For each={props.questions}>
            {(question) => {
              const active = () => props.activeId === question.messageId
              return (
                <button
                  type="button"
                  title={question.text}
                  aria-current={active() ? "true" : undefined}
                  class="flex w-full items-start gap-2 border-b border-edge/60 px-3 py-2.5 text-left transition-colors hover:bg-raised/60"
                  classList={{ "bg-accent/10": active() }}
                  onClick={() => props.onJump(question.messageId)}
                >
                  {/* 序号：帮助快速定位第几轮提问 */}
                  <span
                    class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-raised text-[10px] font-medium text-muted"
                    classList={{ "bg-accent/15 text-accent": active() }}
                  >
                    {question.order}
                  </span>
                  <span class="min-w-0 flex-1">
                    {/* 问句预览：最多两行，完整内容放在 title */}
                    <span class="line-clamp-2 text-[12px] leading-4 break-words text-text">{question.preview}</span>
                    <span class="mt-1 flex items-center gap-2 text-[10px] text-faint">
                      <span>{formatTime(question.createdAt)}</span>
                      <Show when={question.answered}>
                        <span class="flex items-center gap-1">
                          <span class="size-1.5 rounded-full" style={{ "background-color": "var(--status-connected)" }} />
                          answered
                        </span>
                      </Show>
                    </span>
                  </span>
                </button>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}
