/**
 * permission-dock.tsx
 * 参数：request 待裁决的 PermissionRequest；responding 提交中（按钮 loading/禁用）；
 *       error 提交失败文案（Dock 内展示，成功后由父级清空）；onAction 用户决定回调
 * 核心流程：输入框上方的权限裁决卡片 —— 警示色左边框圆角卡片，展示工具名/描述/路径/参数摘要，
 *           三个按钮 Allow once / Allow for session / Deny 分别映射 allow / allow_session / deny
 */
import { Show } from "solid-js"
import type { PermissionAction, PermissionRequest } from "../lib/permissions"

interface Props {
  request: PermissionRequest
  responding: boolean
  error: string
  onAction: (action: PermissionAction) => void
}

/**
 * summarizeParams
 * 参数：request 权限请求（读 tool_name 与 params）
 * 核心流程：参数摘要 —— bash 取 command；edit/write/multi_edit 取 file_path；
 *           其余工具 JSON 压平后截前 120 字符；params 缺失返回空串
 */
function summarizeParams(request: PermissionRequest): string {
  const params = request.params as Record<string, unknown> | undefined
  if (!params || typeof params !== "object") return ""
  const name = request.tool_name.toLowerCase()
  if (name === "bash") {
    return typeof params.command === "string" ? params.command : ""
  }
  if (name === "edit" || name === "write" || name === "multi_edit") {
    return typeof params.file_path === "string" ? params.file_path : ""
  }
  // 其余工具：JSON 摘要截断，避免长载荷撑爆卡片
  const text = JSON.stringify(params) ?? ""
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}

export default function PermissionDock(props: Props) {
  const summary = () => summarizeParams(props.request)

  return (
    <div
      class="mb-2 rounded-[12px] border border-edge border-l-[3px] border-l-[#f5a623] bg-deep px-4 py-3"
      data-testid="permission-dock"
    >
      <div class="flex items-center gap-2">
        <svg viewBox="0 0 16 16" class="size-3.5 shrink-0 text-[#f5a623]" fill="currentColor">
          <path d="M8 1.5 15 14H1L8 1.5Zm0 4.25a.75.75 0 0 0-.75.75v2.5a.75.75 0 0 0 1.5 0v-2.5A.75.75 0 0 0 8 5.75Zm0 6.5a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Z" />
        </svg>
        <span class="text-[13px] font-medium text-text">
          Permission required · <span class="font-mono">{props.request.tool_name}</span>
        </span>
      </div>

      <Show when={props.request.description}>
        <p class="mt-1.5 text-[12px] leading-4 text-muted">{props.request.description}</p>
      </Show>

      <Show when={props.request.path}>
        <p class="mt-1 break-all font-mono text-[12px] leading-4 text-muted">{props.request.path}</p>
      </Show>

      <Show when={summary()}>
        <pre class="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-[6px] bg-base px-2 py-1.5 font-mono text-[11px] leading-4 text-muted">
          {summary()}
        </pre>
      </Show>

      <Show when={props.error}>
        <div class="mt-2 rounded-[6px] bg-[#e5484d]/10 px-2 py-1.5 text-[12px] leading-4 text-[#e5484d]">
          {props.error}
        </div>
      </Show>

      <div class="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          class="rounded-[8px] border border-[#e5484d]/50 px-3 py-1.5 text-[12px] font-medium text-[#e5484d] transition-colors hover:bg-[#e5484d]/10 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={props.responding}
          onClick={() => props.onAction("deny")}
        >
          Deny
        </button>
        <button
          type="button"
          class="rounded-[8px] border border-edge px-3 py-1.5 text-[12px] font-medium text-text transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40"
          disabled={props.responding}
          onClick={() => props.onAction("allow_session")}
        >
          Allow for session
        </button>
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-[8px] bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={props.responding}
          onClick={() => props.onAction("allow")}
        >
          <Show when={props.responding}>
            <span class="size-3 animate-spin rounded-full border border-white/40 border-t-white" />
          </Show>
          Allow once
        </button>
      </div>
    </div>
  )
}
