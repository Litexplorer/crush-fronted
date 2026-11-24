/**
 * job-output-card.tsx
 * 核心流程：后台任务日志卡 —— 头部沿用工具卡样式，展开区是日志正文；
 *           运行中的实时日志来自上游 tool_progress 事件（按 shell_id 的尾部快照），
 *           收到就整体替换正文；任务结束后以 tool_result 的完整输出为准
 */
import { createMemo, Show } from "solid-js"
import { ClampedPreview } from "./clamped-preview"
import { jobOutputSummary, type JobOutputGroup } from "./job-output"
import { toolIcon, toolLabel, toolTone } from "./tool-visuals"

/**
 * JobOutputCard
 * 参数：group 合并后的卡片数据（按 shell_id 聚合）；live 实时尾部快照；
 *      open 展开态；onToggle 切换展开
 * 核心流程：运行中用 live 覆盖正文（快照，不拼接）→ 结束后回落到 group.content
 */
export default function JobOutputCard(props: {
  group: JobOutputGroup
  live?: string
  open: boolean
  onToggle: () => void
}) {
  const running = () => !props.group.done
  // 快照语义：运行中直接用事件里的尾部输出，结束时以工具结果为准
  const content = createMemo(() => {
    const live = props.live?.trim()
    if (live && running()) return props.live as string
    return props.group.content
  })
  const status = () => props.group.status

  return (
    <div class="overflow-hidden rounded-[8px] border border-edge bg-base transition-colors hover:bg-raised/60">
      <button
        type="button"
        class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-muted"
        onClick={() => props.onToggle()}
      >
        <span class="text-faint">{toolIcon("job_output")}</span>
        <span class={`shrink-0 font-semibold ${toolTone("bash")}`}>{toolLabel("job_output")}</span>
        <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">{jobOutputSummary(props.group)}</span>
        <Show
          when={running()}
          fallback={
            <svg
              viewBox="0 0 16 16"
              class="size-3 shrink-0 text-faint transition-transform"
              classList={{ "rotate-90": props.open }}
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            >
              <path d="m6 4 4 4-4 4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          }
        >
          <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
        </Show>
      </button>
      <Show when={props.open}>
        <div class="flex flex-col gap-1.5 border-t border-edge px-2.5 py-2">
          <div class="text-[11px] text-faint">{status()}</div>
          <Show
            when={content()}
            fallback={<div class="text-[12px] text-faint">{running() ? "waiting for output…" : "no output"}</div>}
          >
            <ClampedPreview lineHeight={18} offset={16} anchor="bottom">
              <pre class="md-pre">{content()}</pre>
            </ClampedPreview>
          </Show>
        </div>
      </Show>
    </div>
  )
}
