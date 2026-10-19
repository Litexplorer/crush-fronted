/**
 * question-dock.tsx
 * 参数：request 待答复的 QuestionRequest；submitting 提交中（Submit loading/禁用）；
 *       error 提交失败文案（Dock 内展示）；onSubmit 组装好的 responses 回调；
 *       onCancel 取消整个批次回调
 * 核心流程：输入框上方的问答表单卡片 —— 按 questions 逐题渲染
 *           single_choice（单选）/ multi_choice（多选）/ yes_no（Yes/No）/ free_text（输入框），
 *           本地收集答案，Submit 前做必填校验，通过后组装 QuestionResponse[] 上抛
 */
import { createSignal, For, Show } from "solid-js"
import type { QuestionItem, QuestionRequest, QuestionResponse } from "../lib/questions"

interface Props {
  request: QuestionRequest
  submitting: boolean
  error: string
  onSubmit: (responses: QuestionResponse[]) => void
  onCancel: () => void
}

/**
 * responseOf
 * 参数：item 题目；state 本题当前作答状态（单选/多选 selected、yes_no picked、free_text text）
 * 核心流程：按题型把本地作答组装成 QuestionResponse ——
 *           single/multi → selected_ids；yes_no → yes；free_text → fill_in_text
 */
function responseOf(item: QuestionItem, state: AnswerState): QuestionResponse {
  const res: QuestionResponse = { request_id: item.id }
  if (item.type === "single_choice" || item.type === "multi_choice") {
    res.selected_ids = [...state.selected]
  } else if (item.type === "yes_no") {
    if (state.picked !== null) res.yes = state.picked
  } else {
    res.fill_in_text = state.text
  }
  return res
}

/** 本题作答的本地状态：选择类存选中 id 集合，yes_no 存布尔，free_text 存文本 */
interface AnswerState {
  selected: string[]
  picked: boolean | null
  text: string
}

const EMPTY_STATE: AnswerState = { selected: [], picked: null, text: "" }

/** 必填校验：本题是否已有答案（按题型分别判断） */
function isAnswered(item: QuestionItem, state: AnswerState): boolean {
  if (item.type === "free_text") return state.text.trim().length > 0
  if (item.type === "yes_no") return state.picked !== null
  return state.selected.length > 0
}

export default function QuestionDock(props: Props) {
  const [answers, setAnswers] = createSignal<Record<string, AnswerState>>({})
  const [validationError, setValidationError] = createSignal("")

  const stateOf = (qid: string): AnswerState => answers()[qid] ?? EMPTY_STATE

  /**
   * setAnswer
   * 参数：qid 题目 ID；patch 部分状态更新
   * 核心流程：合并更新该题作答状态，并清除本批次的校验错误提示
   */
  const setAnswer = (qid: string, patch: Partial<AnswerState>) => {
    setAnswers((prev) => ({ ...prev, [qid]: { ...stateOf(qid), ...patch } }))
    setValidationError("")
  }

  /**
   * handleSubmit
   * 参数：无
   * 核心流程：逐题必填校验 —— 缺答则提示缺答数量不提交；全部有答则按题序组装 responses 上抛
   */
  function handleSubmit() {
    const missing = props.request.questions.filter((q) => !isAnswered(q, stateOf(q.id))).length
    if (missing > 0) {
      setValidationError(`${missing} question${missing > 1 ? "s" : ""} require an answer`)
      return
    }
    props.onSubmit(props.request.questions.map((q) => responseOf(q, stateOf(q.id))))
  }

  return (
    <div
      class="mb-2 rounded-[12px] border border-edge bg-deep px-4 py-3"
      data-testid="question-dock"
    >
      <div class="text-[13px] font-medium text-text">{props.request.confirm_title || "Question"}</div>
      <Show when={props.request.confirm_description}>
        <p class="mt-1 text-[12px] leading-4 text-muted">{props.request.confirm_description}</p>
      </Show>

      <div class="mt-2.5 space-y-3">
        <For each={props.request.questions}>
          {(q) => (
            <div>
              <p class="text-[12px] font-medium text-text">{q.label || q.question}</p>
              <Show when={q.description}>
                <p class="mt-0.5 text-[11px] leading-4 text-faint">{q.description}</p>
              </Show>
              <Show when={q.type === "single_choice" || q.type === "multi_choice"} fallback={
                <Show when={q.type === "yes_no"} fallback={
                  /* free_text：单行输入框 */
                  <input
                    type="text"
                    value={stateOf(q.id).text}
                    onInput={(e) => setAnswer(q.id, { text: e.currentTarget.value })}
                    placeholder="Your answer…"
                    class="mt-1.5 w-full rounded-[8px] border border-edge bg-base px-2.5 py-1.5 text-[12px] leading-4 text-text outline-none placeholder:text-faint focus:border-edge-strong"
                  />
                }>
                  {/* yes_no：Yes/No 两个互斥按钮 */}
                  <div class="mt-1.5 flex gap-2">
                    <button
                      type="button"
                      class="rounded-[8px] border px-3 py-1 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                      classList={{
                        "border-accent bg-accent/10 text-accent": stateOf(q.id).picked === true,
                        "border-edge text-muted hover:bg-raised": stateOf(q.id).picked !== true,
                      }}
                      disabled={props.submitting}
                      onClick={() => setAnswer(q.id, { picked: true })}
                    >
                      Yes
                    </button>
                    <button
                      type="button"
                      class="rounded-[8px] border px-3 py-1 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                      classList={{
                        "border-accent bg-accent/10 text-accent": stateOf(q.id).picked === false,
                        "border-edge text-muted hover:bg-raised": stateOf(q.id).picked !== false,
                      }}
                      disabled={props.submitting}
                      onClick={() => setAnswer(q.id, { picked: false })}
                    >
                      No
                    </button>
                  </div>
                </Show>
              }>
                {/* single_choice / multi_choice：选项列表，radio/checkbox 语义 */}
                <div class="mt-1.5 space-y-1">
                  <For each={q.choices ?? []}>
                    {(c) => {
                      const active = () => stateOf(q.id).selected.includes(c.id)
                      const toggle = () => {
                        const prev = stateOf(q.id).selected
                        const next =
                          q.type === "single_choice"
                            ? active() ? [] : [c.id]
                            : active()
                              ? prev.filter((id) => id !== c.id)
                              : [...prev, c.id]
                        setAnswer(q.id, { selected: next })
                      }
                      return (
                        <label class="flex cursor-pointer items-start gap-2 rounded-[8px] border border-edge px-2.5 py-1.5 transition-colors hover:bg-raised">
                          <input
                            type={q.type === "single_choice" ? "radio" : "checkbox"}
                            name={`question-${props.request.id}-${q.id}`}
                            checked={active()}
                            onChange={toggle}
                            disabled={props.submitting}
                            class="mt-0.5 accent-[var(--accent)]"
                          />
                          <span class="min-w-0">
                            <span class="block text-[12px] leading-4 text-text">{c.label}</span>
                            <Show when={c.description}>
                              <span class="block text-[11px] leading-4 text-faint">{c.description}</span>
                            </Show>
                          </span>
                        </label>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>

      <Show when={validationError() || props.error}>
        <div class="mt-2 rounded-[6px] bg-[#e5484d]/10 px-2 py-1.5 text-[12px] leading-4 text-[#e5484d]">
          {validationError() || props.error}
        </div>
      </Show>

      <div class="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          class="rounded-[8px] border border-edge px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40"
          disabled={props.submitting}
          onClick={() => props.onCancel()}
        >
          Cancel
        </button>
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-[8px] bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={props.submitting}
          onClick={handleSubmit}
        >
          <Show when={props.submitting}>
            <span class="size-3 animate-spin rounded-full border border-white/40 border-t-white" />
          </Show>
          Submit
        </button>
      </div>
    </div>
  )
}
