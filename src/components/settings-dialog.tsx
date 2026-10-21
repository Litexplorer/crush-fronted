/**
 * settings-dialog.tsx
 * 参数：ws 当前工作区；onClose 关闭；onToast 轻提示
 * 核心流程：设置弹窗（对齐 opencode 设置面板结构）——
 *           Appearance 主题切换 / Workspace 信息 / Permissions YOLO 开关 / Model 选择 / Skills 数量
 */
import { createSignal, For, onMount, Show } from "solid-js"
import type { Workspace } from "../lib/workspaces"
import { getSkip, setSkip } from "../lib/permissions"
import { listSkills, type SkillInfo } from "../lib/diagnostics"
import ThemeSelect from "./theme-select"
import { rememberYolo } from "../lib/workspace-store"
import ModelSelect from "./model-select"

export default function SettingsDialog(props: {
  ws: Workspace | undefined
  onClose: () => void
  onToast: (msg: string) => void
}) {
  const [yolo, setYolo] = createSignal<boolean | undefined>(undefined)
  const [yoloPending, setYoloPending] = createSignal(false)
  const [skills, setSkills] = createSignal<SkillInfo[]>([])

  onMount(() => {
    // 选中工作区时加载 YOLO 状态与 Skills 概览
    const wsId = props.ws?.id
    if (!wsId) return
    void getSkip(wsId)
      .then((skip) => {
        setYolo(skip)
        if (props.ws?.path) rememberYolo(props.ws.path, skip)
      })
      .catch(() => setYolo(false))
    void listSkills(wsId)
      .then(setSkills)
      .catch(() => setSkills([]))
  })

  /**
   * toggleYolo
   * 核心流程：乐观切换 YOLO → POST skip；失败回滚并 toast
   */
  async function toggleYolo() {
    const wsId = props.ws?.id
    if (!wsId || yoloPending() || yolo() === undefined) return
    const prev = yolo() === true
    setYolo(!prev)
    setYoloPending(true)
    try {
      await setSkip(wsId, !prev)
      // 同步写入按项目路径的缓存：workspace 被回收重建后可回填
      if (props.ws?.path) rememberYolo(props.ws.path, !prev)
    } catch {
      setYolo(prev)
      props.onToast("Failed to update permissions")
    }
    setYoloPending(false)
  }

  return (
    <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/50 px-4" onClick={props.onClose}>
      <div
        class="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-[10px] border border-edge bg-base shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex shrink-0 items-center justify-between border-b border-edge px-4 py-3">
          <h2 class="text-[15px] font-semibold text-text">Settings</h2>
          <button
            type="button"
            aria-label="Close settings"
            class="flex size-7 items-center justify-center rounded-[6px] text-muted transition-colors hover:bg-raised hover:text-text"
            onClick={props.onClose}
          >
            <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke-linecap="round" />
            </svg>
          </button>
        </div>

        <div class="flex flex-col gap-4 overflow-y-auto p-4">
          <section class="flex flex-col gap-2">
            <span class="text-[11px] font-medium uppercase tracking-wide text-faint">Appearance</span>
            <div class="flex items-center justify-between rounded-lg border border-edge px-3 py-2">
              <span class="text-[13px] text-text">Theme</span>
              <div class="w-[240px] max-w-[60%]">
                <ThemeSelect trigger="field" />
              </div>
            </div>
          </section>

          <section class="flex flex-col gap-2">
            <span class="text-[11px] font-medium uppercase tracking-wide text-faint">Workspace</span>
            <div class="rounded-lg border border-edge px-3 py-2">
              <Show when={props.ws} fallback={<span class="text-[12px] text-faint">No project selected</span>}>
                {(ws) => (
                  <div class="flex flex-col gap-0.5">
                    <span class="truncate text-[13px] text-text" title={ws().path}>
                      {ws().path}
                    </span>
                    <span class="truncate text-[11px] text-faint">{ws().id}</span>
                  </div>
                )}
              </Show>
            </div>
          </section>

          <Show when={props.ws}>
            <section class="flex flex-col gap-2">
              <span class="text-[11px] font-medium uppercase tracking-wide text-faint">Permissions</span>
              <div class="flex items-center justify-between rounded-lg border border-edge px-3 py-2">
                <div class="flex min-w-0 flex-col">
                  <span class="text-[13px] text-text">YOLO mode</span>
                  <span class="text-[11px] text-faint">Skip permission prompts</span>
                </div>
                <button
                  type="button"
                  disabled={yoloPending() || yolo() === undefined}
                  class="flex rounded-[7px] border px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-40"
                  classList={{
                    "border-[#f5a623]/60 bg-[#f5a623]/10 text-[#f5a623]": yolo() === true,
                    "border-edge text-muted hover:bg-raised": yolo() !== true,
                  }}
                  onClick={() => void toggleYolo()}
                >
                  {yolo() === true ? "On" : "Off"}
                </button>
              </div>
            </section>

            <section class="flex flex-col gap-2">
              <span class="text-[11px] font-medium uppercase tracking-wide text-faint">Model</span>
              <div class="flex items-center justify-between rounded-lg border border-edge px-2 py-1.5">
                <ModelSelect wsId={props.ws!.id} onToast={props.onToast} />
                <span class="pr-1 text-[11px] text-faint">large</span>
              </div>
            </section>

            <section class="flex flex-col gap-2">
              <span class="text-[11px] font-medium uppercase tracking-wide text-faint">Skills</span>
              <div class="flex flex-col gap-1 rounded-lg border border-edge px-3 py-2">
                <span class="text-[12px] text-muted">{skills().length} available</span>
                <For each={skills().slice(0, 5)}>
                  {(s) => <span class="truncate text-[12px] text-text">{s.name}</span>}
                </For>
              </div>
            </section>
          </Show>
        </div>
      </div>
    </div>
  )
}
