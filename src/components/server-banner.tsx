/**
 * server-banner.tsx
 * 参数：无（状态全部来自 lib/server-status）
 * 核心流程：内容区顶部细提示条，只在两种情况下出现 ——
 *           服务端不可用：显示重启命令并提供复制按钮，避免用户干等断线；
 *           服务端换过二进制（build_id 变化）：提示刷新页面同步前端资源，
 *           可关闭（按 build_id 记忆，同一次重启只提示一次）。
 */
import { createSignal, Show } from "solid-js"
import { copyText } from "../lib/clipboard"
import {
  dismissServerRestart,
  probeServerNow,
  reloadPage,
  serverBuildId,
  serverDown,
  serverRestarted,
} from "../lib/server-status"

/** 一键重启命令：脚本在部署根目录，前端用户可能不在同一台机器上，只能提示不能执行 */
const RESTART_COMMAND = "/root/job/ai-code/restart-server.sh restart --build"

export default function ServerBanner() {
  const [copied, setCopied] = createSignal(false)

  /**
   * handleCopy
   * 参数：无
   * 核心流程：把重启命令写入剪贴板，成功后按钮短暂变成「已复制」
   */
  async function handleCopy() {
    const ok = await copyText(RESTART_COMMAND)
    if (!ok) return
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Show when={serverDown() || serverRestarted()}>
      <div
        role="status"
        class="flex shrink-0 items-center gap-2 border-b border-edge bg-raised px-3 py-1.5 text-[11px] leading-4"
      >
        <Show
          when={serverDown()}
          fallback={
            <>
              <span class="shrink-0 text-[var(--status-connected)]">●</span>
              <span class="min-w-0 flex-1 truncate text-muted">
                服务端已重启（build {serverBuildId()}），刷新页面以同步前端资源
              </span>
              <button
                type="button"
                class="shrink-0 rounded-[4px] px-2 py-0.5 text-[11px] transition-colors hover:bg-base"
                onClick={reloadPage}
              >
                刷新页面
              </button>
              <button
                type="button"
                aria-label="关闭提示"
                class="shrink-0 rounded-[4px] px-2 py-0.5 text-[11px] text-faint transition-colors hover:bg-base"
                onClick={dismissServerRestart}
              >
                忽略
              </button>
            </>
          }
        >
          <span class="shrink-0 text-[var(--status-disconnected)]">●</span>
          <span class="min-w-0 flex-1 truncate text-muted">
            服务端未连接 · 执行 <code class="text-text">{RESTART_COMMAND}</code>
          </span>
          <button
            type="button"
            class="shrink-0 rounded-[4px] px-2 py-0.5 text-[11px] transition-colors hover:bg-base"
            onClick={() => void handleCopy()}
          >
            {copied() ? "已复制" : "复制命令"}
          </button>
          <button
            type="button"
            class="shrink-0 rounded-[4px] px-2 py-0.5 text-[11px] transition-colors hover:bg-base"
            onClick={probeServerNow}
          >
            重试
          </button>
        </Show>
      </div>
    </Show>
  )
}
