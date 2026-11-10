/**
 * subagent-report-card.tsx
 * 参数：report 后台子 agent 跑完后写入父会话的回执分片（part.type = sub_agent_report）
 * 核心流程：后台派发的子 agent 不再由工具调用那张卡承载结果，答复以回执消息的形式
 *          回到父会话；这里把回执渲染成独立卡片 ——
 *          header  子 agent 名字 + 实际模型 + 失败标记 + 展开箭头
 *          body    答复 Markdown，默认限高预览，可滚动展开全文
 */
import { createSignal, Show } from "solid-js"
import { MarkdownText } from "./markdown"
import { ClampedPreview } from "./clamped-preview"
import { toolIcon } from "./tool-visuals"
import type { SubagentReportPartData } from "../../lib/subagents"

export default function SubagentReportCard(props: { report: SubagentReportPartData }) {
  const [open, setOpen] = createSignal(false)
  const failed = () => props.report.failed === true
  const label = () => props.report.label || "sub-agent"
  const model = () => props.report.model || ""
  const output = () => props.report.output || ""

  return (
    <div
      class="w-full overflow-hidden rounded-[8px] border bg-base transition-colors"
      classList={{
        "border-[#e5484d]/50": failed(),
        "border-edge hover:border-edge-strong": !failed(),
      }}
    >
      <button
        type="button"
        class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-raised/60"
        classList={{ "text-[#e5484d]": failed(), "text-muted": !failed() }}
        aria-expanded={open()}
        onClick={() => setOpen((value) => !value)}
      >
        <span classList={{ "text-[#e5484d]": failed(), "text-accent": !failed() }}>{toolIcon("agent_dispatch")}</span>
        <span class="shrink-0 font-medium text-text">Sub-agent report</span>
        <span class="min-w-0 flex-1 truncate text-text">{label()}</span>
        <Show when={model()}>
          <span class="hidden shrink-0 truncate font-mono text-[10px] text-faint sm:block">{model()}</span>
        </Show>
        <span class="shrink-0 text-[11px]" classList={{ "text-[#e5484d]": failed(), "text-[var(--status-connected)]": !failed() }}>
          {failed() ? "Failed" : "Reported"}
        </span>
        <svg
          viewBox="0 0 16 16"
          class="size-3 shrink-0 text-faint transition-transform"
          classList={{ "rotate-90": open() }}
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
        >
          <path d="m6 4 4 4-4 4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <Show when={open()}>
        <div class="border-t border-edge px-3 py-2 text-[12px]">
          <Show when={output()} fallback={<div class="text-[11px] leading-4 text-faint">No output</div>}>
            <ClampedPreview lines={8} lineHeight={20} expandedMaxHeight={520} tone={failed() ? "error" : "text"}>
              <MarkdownText text={output()} />
            </ClampedPreview>
          </Show>
        </div>
      </Show>
    </div>
  )
}
