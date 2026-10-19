/**
 * panel-terminal.tsx
 * 参数：props.wsId workspace ID；props.sessionId 会话 ID
 * 核心流程：右侧面板 Terminal tab ——
 *           底部命令输入行（$ 前缀 + Run 按钮，Enter 提交），调用 shell 接口同步执行；
 *           输出区按执行序渲染每次命令的输出与退出码（stdout/stderr 后端合并返回，无独立字段）；
 *           命令历史保存在组件内（最多 50 条），上箭头调出历史命令、下箭头回退；
 *           运行中禁用输入并显示 spinner；失败显示错误文本且不清空历史；
 *           wsId/sessionId 变化时整体重置（历史/输入/错误/运行态）
 */
import { createEffect, createSignal, For, on, Show } from "solid-js"
import { runShell } from "../lib/agent"

/** 单条执行记录：命令 + 合并输出 + 退出码 */
interface TermEntry {
  command: string
  output: string
  exit_code: number
}

/** 命令历史与输出记录的保留上限 */
const MAX_HISTORY = 50

/**
 * errorMessage
 * 参数：err 抛出的错误对象
 * 核心流程：从 ApiError 形状中安全取出 message，兜底 Unknown error
 */
function errorMessage(err: unknown): string {
  const e = err as { message?: string }
  return e?.message ?? "Unknown error"
}

/**
 * TerminalTab
 * 参数：props.wsId workspace ID；props.sessionId 会话 ID
 * 核心流程：输出区（flex-1 滚动）+ 底部输入行；提交后 POST shell 渲染响应；
 *           epoch 序号保证会话切换后丢弃在途响应
 */
export default function TerminalTab(props: { wsId: string; sessionId: string }) {
  const [entries, setEntries] = createSignal<TermEntry[]>([])
  // 可调出的历史命令栈（最多 50 条）；histIndex == 长度表示当前在草稿态
  const [cmdHistory, setCmdHistory] = createSignal<string[]>([])
  const [input, setInput] = createSignal("")
  const [running, setRunning] = createSignal(false)
  const [error, setError] = createSignal("")
  let histIndex = 0
  // 上箭头进入历史前暂存未提交草稿，回退到末尾时还原
  let draftBackup = ""
  // 会话纪元序号：切换后丢弃在途响应
  let epoch = 0
  let scrollRef: HTMLDivElement | undefined

  /**
   * run
   * 参数：无（读取 input()）
   * 核心流程：校验非空且空闲 → 入历史栈（截断到 50）→ POST shell →
   *           成功追加执行记录（含 exit_code）；失败仅展示错误文本，不清空历史
   */
  async function run() {
    const wsId = props.wsId
    const sid = props.sessionId
    const command = input().trim()
    if (!command || running() || !wsId || !sid) return
    const my = epoch
    setInput("")
    setError("")
    setRunning(true)
    // 命令入栈：保留最近 50 条；游标移到栈顶（草稿态）
    setCmdHistory((prev) => [...prev, command].slice(-MAX_HISTORY))
    histIndex = cmdHistory().length
    draftBackup = ""
    try {
      // 同步执行：后端返回合并输出 + 退出码
      const resp = await runShell(wsId, sid, command)
      if (my !== epoch) return
      setEntries((prev) =>
        [...prev, { command, output: resp?.output ?? "", exit_code: resp?.exit_code ?? 0 }].slice(-MAX_HISTORY),
      )
    } catch (err) {
      if (my !== epoch) return
      setError(errorMessage(err))
    } finally {
      if (my === epoch) setRunning(false)
    }
  }

  /**
   * handleKeyDown
   * 参数：e 输入框键盘事件
   * 核心流程：Enter 提交；上箭头沿历史栈回溯（首次进入前暂存草稿）、
   *           下箭头前进，回到栈顶时还原草稿
   */
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault()
      void run()
      return
    }
    const hist = cmdHistory()
    if (e.key === "ArrowUp" && hist.length > 0) {
      e.preventDefault()
      if (histIndex === hist.length) draftBackup = input()
      histIndex = Math.max(0, histIndex - 1)
      setInput(hist[histIndex])
    } else if (e.key === "ArrowDown" && histIndex < hist.length) {
      e.preventDefault()
      histIndex = Math.min(hist.length, histIndex + 1)
      // 回到末尾：还原进入历史前的草稿
      setInput(histIndex === hist.length ? draftBackup : hist[histIndex])
    }
  }

  // 会话/工作区切换：清空输出、命令历史、输入、错误与运行态，作废在途请求
  createEffect(
    on(
      () => [props.wsId, props.sessionId] as const,
      () => {
        epoch++
        setEntries([])
        setCmdHistory([])
        setInput("")
        setError("")
        setRunning(false)
        histIndex = 0
        draftBackup = ""
      },
    ),
  )

  // 新输出到达：自动滚到底部
  createEffect(() => {
    entries()
    queueMicrotask(() => {
      const el = scrollRef
      if (el) el.scrollTop = el.scrollHeight
    })
  })

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* 输出区：按执行顺序渲染命令 / 输出 / 退出码 */}
      <div ref={scrollRef} class="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
        <Show
          when={entries().length > 0}
          fallback={<div class="text-[13px] text-faint">Run a command to see its output</div>}
        >
          <For each={entries()}>
            {(en) => (
              <div class="mb-3 font-mono text-[12px] leading-5">
                <div class="break-all text-text">
                  <span class="select-none text-accent">$ </span>
                  {en.command}
                </div>
                <Show when={en.output}>
                  <pre class="whitespace-pre-wrap break-all text-muted">{en.output}</pre>
                </Show>
                <div
                  class="mt-0.5 text-[11px]"
                  classList={{ "text-faint": en.exit_code === 0, "text-[#e5484d]": en.exit_code !== 0 }}
                >
                  exit {en.exit_code}
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>

      {/* 错误条：请求失败展示，历史保留不清空 */}
      <Show when={error()}>
        <div class="mx-2.5 mb-1.5 rounded-[8px] border border-[#e5484d]/40 bg-[#e5484d]/10 px-2 py-1 text-[11px] leading-4 text-[#e5484d]">
          {error()}
        </div>
      </Show>

      {/* 输入行：$ 前缀 + 命令输入 + Run（运行中禁用并显示 spinner） */}
      <div class="flex shrink-0 items-center gap-1.5 border-t border-edge px-2.5 py-2">
        <span class="shrink-0 select-none font-mono text-[12px] text-accent">$</span>
        <input
          type="text"
          value={input()}
          spellcheck={false}
          autocomplete="off"
          disabled={running()}
          placeholder="Run a command…"
          class="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-text outline-none placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-50"
          onInput={(e) => setInput(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          class="flex shrink-0 items-center gap-1.5 rounded-[8px] bg-accent px-2.5 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={running() || !input().trim()}
          onClick={() => void run()}
        >
          <Show when={running()}>
            <span class="size-2.5 animate-spin rounded-full border border-white/40 border-t-white" />
          </Show>
          Run
        </button>
      </div>
    </div>
  )
}
