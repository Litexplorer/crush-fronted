/**
 * status-popover.tsx
 * 参数：wsId 当前工作区；connected 后端连接状态；onClose 关闭回调
 * 核心流程：标题栏状态浮层（复刻 opencode）——
 *           并行加载 MCP / LSP / Skills → 分区展示状态与数量；
 *           支持刷新；点击浮层外部或 Escape 关闭
 */
import { createEffect, createSignal, onMount, Show } from "solid-js"
import { listLsps, listMcp, listSkills, type LspState, type McpState, type SkillInfo } from "../lib/diagnostics"
import type { ApiError } from "../lib/http"
import InfoSections from "./info-sections"

function errorMessage(err: unknown): string {
  const e = err as ApiError
  return e?.message ?? "Unknown error"
}

export default function StatusPopover(props: { wsId?: string; connected: boolean; onClose: () => void }) {
  const [mcp, setMcp] = createSignal<McpState[]>([])
  const [lsps, setLsps] = createSignal<LspState[]>([])
  const [skills, setSkills] = createSignal<SkillInfo[]>([])
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  let rootRef: HTMLDivElement | undefined

  /**
   * load
   * 参数：无
   * 核心流程：并行拉 MCP/LSP/Skills；任一失败整体进入错误态；未选工作区时只显示 Server
   */
  async function load() {
    const wsId = props.wsId
    if (!wsId) return
    setLoading(true)
    setError("")
    try {
      const [m, l, s] = await Promise.all([listMcp(wsId), listLsps(wsId), listSkills(wsId)])
      setMcp(m)
      setLsps(l)
      setSkills(s)
    } catch (err) {
      setError(errorMessage(err))
    }
    setLoading(false)
  }

  onMount(() => void load())

  // 点击外部 / Escape 关闭
  createEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (rootRef && !rootRef.contains(e.target as Node)) props.onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose()
    }
    document.addEventListener("pointerdown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerdown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  })

  return (
    <div
      ref={rootRef}
      class="absolute right-0 top-full z-40 mt-2 flex w-[320px] flex-col overflow-hidden rounded-xl border border-edge bg-base shadow-xl"
    >
      <div class="flex items-center justify-between border-b border-edge px-3 py-2">
        <span class="text-[12px] font-medium text-text">Status</span>
        <button
          type="button"
          aria-label="Refresh status"
          title="Refresh"
          class="flex size-6 items-center justify-center rounded-[5px] text-muted transition-colors hover:bg-raised hover:text-text"
          onClick={() => void load()}
        >
          <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12.5 6.5A5 5 0 1 0 13 9" stroke-linecap="round" />
            <path d="M12.5 3v3.5H9" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>

      <div class="max-h-[60vh] overflow-y-auto p-2">
        <div class="mb-2 rounded-lg bg-deep px-2 py-1.5">
          <div class="flex items-center gap-2">
            <span classList={{ "bg-[var(--status-connected)]": props.connected, "bg-[var(--status-disconnected)]": !props.connected }} class="size-2 rounded-full" />
            <span class="text-[12px] text-text">Crush server</span>
            <span class="ml-auto text-[11px] text-faint">{props.connected ? "Connected" : "Offline"}</span>
          </div>
        </div>

        <Show
          when={props.wsId}
          fallback={<div class="px-1 py-2 text-[11px] text-faint">Select a project for details</div>}
        >
          <InfoSections
            variant="compact"
            loading={loading()}
            error={error()}
            mcp={mcp()}
            lsps={lsps()}
            skills={skills()}
          />
        </Show>
      </div>
    </div>
  )
}
