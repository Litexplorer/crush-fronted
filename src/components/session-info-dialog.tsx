/**
 * session-info-dialog.tsx
 * 参数：wsId 工作区 ID；session 当前会话；model 当前模型选择（含思考强度）；
 *       lastUsed 最近一次实际使用的模型；contextWindow 当前模型上下文窗口；
 *       onClose 关闭回调
 * 核心流程：打开时并行拉 LSP / MCP / Skills / 版本号 → 头部展示会话标题、模型与用量 →
 *           中部复用 InfoSections 分区展示 MCP / LSP / Skills → 页脚展示版本与刷新入口；
 *           Escape 或点击遮罩关闭，打开时焦点进入弹窗、关闭后还原原焦点
 */
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import type { SelectedModel } from "../lib/models"
import type { Session } from "../lib/sessions"
import { listLsps, listMcp, listSkills, type LspState, type McpState, type SkillInfo } from "../lib/diagnostics"
import { getVersion } from "../lib/version"
import { formatTokens } from "../lib/usage"
import type { ApiError } from "../lib/http"
import InfoSections from "./info-sections"

function errorMessage(err: unknown): string {
  const e = err as ApiError
  return e?.message ?? "Unknown error"
}

/** 思考强度展示：low/medium/high → Low/Medium/High */
function titleCase(value: string | undefined): string {
  if (!value) return ""
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

export default function SessionInfoDialog(props: {
  wsId: string
  session: Session | undefined
  model: SelectedModel | undefined
  lastUsed: { model: string; provider: string } | undefined
  contextWindow: number | undefined
  onClose: () => void
}) {
  const [mcp, setMcp] = createSignal<McpState[]>([])
  const [lsps, setLsps] = createSignal<LspState[]>([])
  const [skills, setSkills] = createSignal<SkillInfo[]>([])
  const [version, setVersion] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal("")
  let panelRef: HTMLDivElement | undefined
  let previousFocus: Element | null = null

  /**
   * load
   * 参数：无
   * 核心流程：并行拉 MCP / LSP / Skills / 版本号，各自独立落盘 ——
   *           任一失败只记录错误文案，其余分区照常展示
   */
  async function load() {
    setLoading(true)
    setError("")
    const results = await Promise.allSettled([
      listMcp(props.wsId),
      listLsps(props.wsId),
      listSkills(props.wsId),
      getVersion(),
    ])
    const [m, l, s, v] = results
    if (m.status === "fulfilled") setMcp(m.value)
    if (l.status === "fulfilled") setLsps(l.value)
    if (s.status === "fulfilled") setSkills(s.value)
    if (v.status === "fulfilled") setVersion(v.value.version)
    const failed = results.find((r) => r.status === "rejected")
    if (failed && failed.status === "rejected") setError(errorMessage(failed.reason))
    setLoading(false)
  }

  /**
   * focusableNodes
   * 参数：无
   * 核心流程：收集弹窗内可聚焦元素（按钮/链接/输入框等），供 Tab 焦点圈定首尾判断
   */
  function focusableNodes(): HTMLElement[] {
    if (!panelRef) return []
    return Array.from(
      panelRef.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    )
  }

  onMount(() => {
    previousFocus = document.activeElement
    // 打开即落焦点，键盘用户可以直接 Escape 关闭
    panelRef?.focus()
    void load()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        props.onClose()
        return
      }
      if (e.key !== "Tab") return
      // Tab 焦点圈定：在弹窗内首尾循环，焦点不会跑到遮罩后的页面上
      const nodes = focusableNodes()
      if (nodes.length === 0) {
        e.preventDefault()
        panelRef?.focus()
        return
      }
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const active = document.activeElement as HTMLElement | null
      const inside = !!active && !!panelRef?.contains(active)
      if (e.shiftKey) {
        if (!inside || active === first) {
          e.preventDefault()
          last.focus()
        }
        return
      }
      if (!inside || active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => {
      document.removeEventListener("keydown", onKey)
      // 关闭后把焦点还给触发按钮，避免焦点掉回 body
      if (previousFocus instanceof HTMLElement) previousFocus.focus()
    })
  })

  const totalTokens = () => (props.session?.prompt_tokens ?? 0) + (props.session?.completion_tokens ?? 0)
  const usagePercent = () => {
    const window = props.contextWindow
    if (!window || window <= 0) return undefined
    return Math.min(100, Math.round((totalTokens() / window) * 100))
  }
  const modelLabel = () => props.model?.model || props.lastUsed?.model || "unknown model"
  const providerLabel = () => props.model?.provider || props.lastUsed?.provider || ""
  const reasoningLabel = () => titleCase(props.model?.reasoning_effort)
  const costLabel = () => `$${(props.session?.cost ?? 0).toFixed(2)}`

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onPointerDown={(event) => {
        // 只有点在遮罩本身（不在弹窗内）才关闭
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-info-title"
        tabIndex={-1}
        class="flex max-h-[70vh] w-full max-w-[760px] flex-col overflow-hidden rounded-[12px] border border-edge bg-base shadow-2xl outline-none"
      >
        {/* 头部：会话标题 + 模型/供应商 + 用量与成本 */}
        <div class="flex items-start justify-between gap-3 border-b border-edge px-4 py-3">
          <div class="min-w-0">
            <div id="session-info-title" class="truncate text-[14px] font-medium text-text">
              {props.session?.title || "Untitled"}
            </div>
            <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
              <span class="text-accent">◆</span>
              <span class="truncate text-text">{modelLabel()}</span>
              <Show when={providerLabel()}>
                <span class="text-faint">via {providerLabel()}</span>
              </Show>
            </div>
            <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
              <Show when={reasoningLabel()}>
                <span>Reasoning {reasoningLabel()}</span>
                <span class="text-faint">·</span>
              </Show>
              <Show when={usagePercent()} fallback={<span class="text-faint">context —</span>}>
                {(percent) => (
                  <span>
                    {percent()}% ({formatTokens(totalTokens())}
                    {props.contextWindow ? `/${formatTokens(props.contextWindow)}` : ""})
                  </span>
                )}
              </Show>
              <span class="text-faint">·</span>
              <span>{costLabel()}</span>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close session info"
            title="Close (Esc)"
            class="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted transition-colors hover:bg-raised hover:text-text"
            onClick={props.onClose}
          >
            <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke-linecap="round" />
            </svg>
          </button>
        </div>

        {/* 中部：MCP / LSP / Skills 分区，内容超过高度时内部滚动 */}
        <div class="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <InfoSections
            variant="full"
            loading={loading()}
            error={error()}
            mcp={mcp()}
            lsps={lsps()}
            skills={skills()}
          />
        </div>

        {/* 页脚：版本信息 + 刷新入口 */}
        <div class="flex items-center gap-2 border-t border-edge px-4 py-2">
          <span class="truncate text-[11px] text-faint" title={version()}>
            {version() ? versionKey(version()) : ""}
          </span>
          <div class="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-label="Refresh session info"
              title="Refresh"
              class="flex h-7 items-center gap-1 rounded-[6px] px-2 text-[11px] text-muted transition-colors hover:bg-raised hover:text-text"
              disabled={loading()}
              onClick={() => void load()}
            >
              <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M12.5 6.5A5 5 0 1 0 13 9" stroke-linecap="round" />
                <path d="M12.5 3v3.5H9" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              Refresh
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * versionKey
 * 参数：value 后端版本串
 * 核心流程：统一加 v 前缀（后端可能已带 v，避免重复）
 */
function versionKey(value: string): string {
  return value.startsWith("v") ? value : `v${value}`
}
