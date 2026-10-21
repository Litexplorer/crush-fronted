/**
 * info-sections.tsx
 * 参数：loading 加载中；mcp / lsps / skills 数据源；error 错误文案；variant 展示密度
 * 核心流程：统一渲染 MCP / LSP / Skills 三段 ——
 *           compact（标题栏状态浮层）：限条数、紧凑行；
 *           full（会话信息弹窗）：带计数与工具数、不截断，由外层容器滚动；
 *           两种模式共用状态点与空态文案，避免两处渲染逻辑漂移
 */
import { For, Show } from "solid-js"
import type { LspState, McpState, SkillInfo } from "../lib/diagnostics"

/** 状态点颜色：connected/运行中 绿，disabled 灰，启动中/异常 黄 */
export function dotClass(state: string | number): string {
  if (state === "connected" || (typeof state === "number" && state > 0)) return "bg-[var(--status-connected)]"
  if (state === "disabled") return "bg-[var(--status-disconnected)]"
  return "bg-[#f5a623]"
}

export interface InfoSectionsProps {
  loading: boolean
  error: string
  mcp: McpState[]
  lsps: LspState[]
  skills: SkillInfo[]
  variant?: "compact" | "full"
}

export default function InfoSections(props: InfoSectionsProps) {
  const full = () => props.variant === "full"
  /** 行高与字号：浮层更紧凑，弹窗略宽松 */
  const rowClass = () => (full() ? "gap-2 px-1 py-1.5" : "gap-2 px-1 py-1")
  const textClass = () => (full() ? "text-[12.5px]" : "text-[12px]")
  const countText = () => (props.loading ? "…" : undefined)
  const activeMcp = () => props.mcp.filter((m) => m.state === "connected")
  const activeLsp = () => props.lsps.filter((l) => l.state > 0)
  /** 截断条数：浮层限条数，弹窗靠滚动展示全部 */
  const limit = (n: number) => (full() ? Number.POSITIVE_INFINITY : n)

  return (
    <>
      <Show when={props.error}>
        <div class="mb-2 rounded-md border border-[#e5484d]/40 bg-[#e5484d]/10 px-2 py-1.5 text-[11px] text-[#e5484d]">
          {props.error}
        </div>
      </Show>

      <section class="mb-2">
        <div class="flex items-center justify-between px-1 py-1">
          <span class="text-[11px] font-medium text-muted">MCP</span>
          <span class="text-[11px] text-faint">
            {countText() ?? `${activeMcp().length}/${props.mcp.length}`}
          </span>
        </div>
        <For each={props.mcp.slice(0, limit(props.mcp.length))}>
          {(m) => (
            <div class={`flex items-center rounded-[5px] ${rowClass()}`}>
              <span class={`size-1.5 shrink-0 rounded-full ${dotClass(m.state)}`} />
              <span class={`min-w-0 flex-1 truncate text-text ${textClass()}`}>{m.name}</span>
              <Show
                when={full() && m.tool_count !== undefined}
                fallback={<span class="shrink-0 text-[11px] text-faint">{m.state}</span>}
              >
                <span class="shrink-0 text-[11px] text-faint">
                  {m.state === "connected" ? `${m.tool_count} tools` : m.state}
                </span>
              </Show>
            </div>
          )}
        </For>
        <Show when={!props.loading && props.mcp.length === 0}>
          <div class="px-1 py-1 text-[11px] text-faint">No MCP servers</div>
        </Show>
      </section>

      <section class="mb-2">
        <div class="flex items-center justify-between px-1 py-1">
          <span class="text-[11px] font-medium text-muted">LSPs</span>
          <span class="text-[11px] text-faint">
            {countText() ?? `${activeLsp().length}/${props.lsps.length}`}
          </span>
        </div>
        <For each={props.lsps.filter((l) => l.state > 0).slice(0, limit(8))}>
          {(l) => (
            <div class={`flex items-center rounded-[5px] ${rowClass()}`}>
              <span class={`size-1.5 shrink-0 rounded-full ${dotClass(l.state)}`} />
              <span class={`min-w-0 flex-1 truncate text-text ${textClass()}`}>{l.name}</span>
              <Show when={full()}>
                <span class="shrink-0 text-[11px] text-faint">running</span>
              </Show>
            </div>
          )}
        </For>
        <Show when={!props.loading && activeLsp().length === 0}>
          <div class="px-1 py-1 text-[11px] text-faint">No running language servers</div>
        </Show>
      </section>

      <section>
        <div class="flex items-center justify-between px-1 py-1">
          <span class="text-[11px] font-medium text-muted">Skills</span>
          <span class="text-[11px] text-faint">{countText() ?? String(props.skills.length)}</span>
        </div>
        <For each={props.skills.slice(0, limit(6))}>
          {(s) => (
            <div class={`flex items-center rounded-[5px] ${rowClass()}`} title={s.description}>
              <span class={`min-w-0 flex-1 truncate text-text ${textClass()}`}>{s.name}</span>
              <Show when={full() && s.source}>
                <span class="shrink-0 text-[11px] text-faint">{s.source}</span>
              </Show>
            </div>
          )}
        </For>
        <Show when={!props.loading && props.skills.length === 0}>
          <div class="px-1 py-1 text-[11px] text-faint">No skills</div>
        </Show>
      </section>
    </>
  )
}
