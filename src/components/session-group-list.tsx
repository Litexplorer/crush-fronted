/**
 * session-group-list.tsx
 * 参数：rows 已按搜索过滤的会话行；currentSessionId 当前会话 id；onOpen 打开会话
 * 核心流程：按本地分组配置渲染组头（色块 / 组名 / 计数 / 折叠）与会话行
 *           （首字母头像 / 标题 / 副标题 / Working 或相对时间 / 归组按钮）；
 *           组名双击可改、色块点开选色、× 删除，行的文件夹按钮把会话挪进别的组
 */
import { For, Show, createMemo, createSignal } from "solid-js"
import { InlineTitle } from "./inline-title"
import {
  UNGROUPED_KEY,
  groupSessionRows,
  relativeSessionTime,
  sessionInitial,
  type SessionListGroup,
  type SessionListRow,
} from "../lib/session-groups"
import {
  assignSessionGroup,
  createSessionGroup,
  deleteSessionGroup,
  renameSessionGroup,
  sessionGroupConfig,
  setSessionGroupColor,
  toggleSessionGroupCollapsed,
} from "../lib/session-group-store"
import { PALETTE, workspaceColor } from "../lib/workspace-color"

export interface SessionGroupListProps {
  rows: SessionListRow[]
  currentSessionId?: string
  onOpen: (row: SessionListRow) => void
}

/**
 * tintOf
 * 参数：color 十六进制色值
 * 核心流程：混成低透明度底色，给头像方块与色块用，避免纯色块压过文字
 */
function tintOf(color: string | undefined, percent = 18): string {
  if (!color) return "transparent"
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`
}

/**
 * GroupNameInput
 * 参数：placeholder 占位文案；onCommit 提交组名；onCancel 放弃输入
 * 核心流程：Enter 或失焦提交、Esc 放弃；只提交一次，按键不冒泡给面板的 Esc 关闭
 */
function GroupNameInput(props: {
  placeholder: string
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = createSignal("")
  let settled = false

  function settle(commit: boolean) {
    if (settled) return
    settled = true
    if (commit) props.onCommit(draft())
    else props.onCancel()
  }

  return (
    <input
      value={draft()}
      autofocus
      placeholder={props.placeholder}
      class="w-full rounded-[6px] border border-edge bg-base px-2 py-1 text-[12px] text-text outline-none placeholder:text-faint focus:border-edge-strong"
      onInput={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => settle(true)}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === "Enter") {
          event.preventDefault()
          settle(true)
        }
        if (event.key === "Escape") {
          event.preventDefault()
          settle(false)
        }
      }}
    />
  )
}

/**
 * avatarColor
 * 参数：row 会话行；group 所属组
 * 核心流程：组有显式颜色时用组色；未分组退回项目路径哈希色，保证行与行之间仍能区分
 */
function avatarColor(row: SessionListRow, group: SessionListGroup): string | undefined {
  return group.color ?? workspaceColor(row.projectPath ?? row.workspaceId)?.solid
}

export function SessionGroupList(props: SessionGroupListProps) {
  /** 展开选色板的组 key（同时只允许一个） */
  const [colorFor, setColorFor] = createSignal("")
  /** 展开归组面板的会话 id（同时只允许一个） */
  const [assignFor, setAssignFor] = createSignal("")
  /** 是否正在输入新组名 */
  const [creating, setCreating] = createSignal(false)
  /** 建组后要立刻归入的会话 id：来自行内的「+ New group」，空串表示普通新建 */
  const [createFor, setCreateFor] = createSignal("")
  /** 未分组桶的折叠是纯展示态，不进配置 */
  const [ungroupedCollapsed, setUngroupedCollapsed] = createSignal(false)

  const groups = createMemo(() =>
    groupSessionRows(props.rows, sessionGroupConfig().groups, sessionGroupConfig().overrides),
  )

  const collapsed = (group: SessionListGroup) =>
    group.key === UNGROUPED_KEY ? ungroupedCollapsed() : group.collapsed

  /**
   * toggleGroup
   * 核心流程：用户组写回配置（下次打开仍保持），未分组桶只翻转本地状态
   */
  function toggleGroup(group: SessionListGroup) {
    if (group.key === UNGROUPED_KEY) {
      setUngroupedCollapsed((value) => !value)
      return
    }
    toggleSessionGroupCollapsed(group.key)
  }

  /**
   * commitCreate
   * 核心流程：提交组名 → 关闭输入框；来自行内请求时把该会话一并归入新组，
   *           这样用户不用建完再去点一次归组
   */
  function commitCreate(name: string) {
    const target = createFor()
    setCreating(false)
    setCreateFor("")
    const trimmed = name.trim()
    if (!trimmed) return
    const id = createSessionGroup(trimmed)
    if (id && target) {
      assignSessionGroup(target, id)
      setAssignFor("")
    }
  }

  /** cancelCreate：放弃输入，同时清掉「建完归组」的目标 */
  function cancelCreate() {
    setCreating(false)
    setCreateFor("")
  }

  /**
   * assign
   * 参数：sessionId 会话 id；groupId 目标组 id（空串表示移出分组）
   * 核心流程：写入归属后收起面板，让用户马上看到会话挪到了新组
   */
  function assign(sessionId: string, groupId: string) {
    assignSessionGroup(sessionId, groupId || undefined)
    setAssignFor("")
  }

  return (
    <div class="pb-1">
      <For each={groups()}>
        {(group) => (
          <div>
            {/* 组头：折叠箭头 + 色块 + 组名 + 计数（未分组桶不可改名/改色） */}
            <div class="group/group flex items-center gap-1.5 px-2 pt-2 pb-1">
              <button
                type="button"
                aria-label={collapsed(group) ? "Expand group" : "Collapse group"}
                aria-expanded={!collapsed(group)}
                class="flex size-4 shrink-0 items-center justify-center text-faint transition-colors hover:text-text"
                onClick={() => toggleGroup(group)}
              >
                <svg
                  viewBox="0 0 16 16"
                  class="size-3 transition-transform"
                  classList={{ "-rotate-90": collapsed(group) }}
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                >
                  <path d="M4 6.5 8 10.5l4-4" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <button
                type="button"
                aria-label="Group color"
                title={group.key === UNGROUPED_KEY ? "Ungrouped" : "Pick group color"}
                disabled={group.key === UNGROUPED_KEY}
                class="size-2.5 shrink-0 rounded-[2px] border border-edge/60 disabled:opacity-40"
                style={{ "background-color": group.key === UNGROUPED_KEY ? "var(--text-faint)" : (group.color ?? "var(--text-faint)") }}
                onClick={() => setColorFor(colorFor() === group.key ? "" : group.key)}
              />
              <Show
                when={group.key !== UNGROUPED_KEY}
                fallback={<span class="truncate text-[11px] font-medium text-muted">{group.label}</span>}
              >
                <InlineTitle
                  value={group.label}
                  onCommit={(name) => renameSessionGroup(group.key, name)}
                  class="min-w-0 truncate text-[11px] font-medium text-muted"
                  inputClass="min-w-0 text-[11px]"
                  maxLength={32}
                />
              </Show>
              <span class="ml-auto shrink-0 text-[10px] tabular-nums text-faint">{group.sessions.length}</span>
              <Show when={group.key !== UNGROUPED_KEY}>
                <button
                  type="button"
                  aria-label="Delete group"
                  title="Delete group (sessions move to Ungrouped)"
                  class="shrink-0 text-[10px] text-faint opacity-0 transition-opacity hover:text-[#e5484d] group-hover/group:opacity-100"
                  onClick={() => deleteSessionGroup(group.key)}
                >
                  <svg viewBox="0 0 16 16" class="size-3" fill="none" stroke="currentColor" stroke-width="1.6">
                    <path d="m4.5 4.5 7 7m0-7-7 7" stroke-linecap="round" />
                  </svg>
                </button>
              </Show>
            </div>

            {/* 选色：8 色板 + 恢复自动色 */}
            <Show when={colorFor() === group.key && group.key !== UNGROUPED_KEY}>
              <div class="flex flex-wrap items-center gap-1 px-6 pb-1.5">
                <For each={PALETTE}>
                  {(color) => (
                    <button
                      type="button"
                      aria-label={`Use ${color}`}
                      class="size-3.5 rounded-[2px] border border-black/10"
                      classList={{ "ring-1 ring-text": group.color === color }}
                      style={{ "background-color": color }}
                      onClick={() => {
                        setSessionGroupColor(group.key, color)
                        setColorFor("")
                      }}
                    />
                  )}
                </For>
                <button
                  type="button"
                  class="ml-1 text-[10px] text-faint hover:text-text"
                  onClick={() => {
                    setSessionGroupColor(group.key, undefined)
                    setColorFor("")
                  }}
                >
                  Auto
                </button>
              </div>
            </Show>

            <Show when={!collapsed(group)}>
              <For each={group.sessions}>
                {(row) => (
                  <div class="group/row flex items-stretch">
                    <button
                      type="button"
                      class="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-raised"
                      classList={{ "bg-raised/60": props.currentSessionId === row.id }}
                      onClick={() => props.onOpen(row)}
                    >
                      {/* 头像：首字母 + 颜色底；有组用组色，未分组按项目路径取色 */}
                      <span
                        class="flex size-5 shrink-0 items-center justify-center rounded-[4px] text-[10px] font-semibold"
                        style={{
                          "background-color": tintOf(avatarColor(row, group)),
                          color: avatarColor(row, group) ?? "var(--text-muted)",
                        }}
                      >
                        {sessionInitial(row.title || "Untitled")}
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="flex items-center gap-1">
                          <span class="min-w-0 truncate text-[12px] text-text">{row.title || "Untitled"}</span>
                          <Show when={props.currentSessionId === row.id}>
                            <span class="shrink-0 text-[9px] text-accent">current</span>
                          </Show>
                        </span>
                        <Show when={row.subtitle}>
                          <span class="block truncate text-[11px] leading-4 text-faint">{row.subtitle}</span>
                        </Show>
                      </span>
                      <Show
                        when={row.isBusy}
                        fallback={<span class="shrink-0 text-[10px] text-faint">{relativeSessionTime(row.updatedAt)}</span>}
                      >
                        <span class="shrink-0 text-[10px] font-medium text-accent">Working</span>
                      </Show>
                    </button>
                    <button
                      type="button"
                      aria-label="Move to group"
                      title="Move to group"
                      class="shrink-0 px-1 text-faint opacity-0 transition-opacity hover:text-text group-hover/row:opacity-100"
                      onClick={() => setAssignFor(assignFor() === row.id ? "" : row.id)}
                    >
                      <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M2 5.5h4l1.2 1.5H14v5.5H2z" stroke-linejoin="round" />
                        <path d="M2 5.5V4h3.5l1 1.5" stroke-linejoin="round" />
                      </svg>
                    </button>
                  </div>
                )}
              </For>
            </Show>

            {/* 归组面板：直接列出所有组，避免再套一层浮层 */}
            <Show when={group.sessions.some((row) => row.id === assignFor())}>
              <div class="flex flex-wrap items-center gap-1 px-2 pb-1.5">
                <For each={sessionGroupConfig().groups}>
                  {(target) => (
                    <button
                      type="button"
                      class="flex items-center gap-1 rounded-[4px] border border-edge px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:border-edge-strong hover:text-text"
                      onClick={() => assign(assignFor(), target.id)}
                    >
                      <span
                        class="size-2 rounded-[1px]"
                        style={{ "background-color": target.color ?? "var(--text-faint)" }}
                      />
                      {target.name}
                    </button>
                  )}
                </For>
                <button
                  type="button"
                  class="rounded-[4px] border border-dashed border-edge px-1.5 py-0.5 text-[10px] text-faint transition-colors hover:border-edge-strong hover:text-text"
                  onClick={() => {
                    setCreateFor(assignFor())
                    setCreating(true)
                  }}
                >
                  + New group
                </button>
                <Show when={sessionGroupConfig().overrides[assignFor()]}>
                  <button
                    type="button"
                    class="px-1 text-[10px] text-faint hover:text-text"
                    onClick={() => assign(assignFor(), "")}
                  >
                    Remove
                  </button>
                </Show>
                {/* 就地命名：建完立刻把这个会话归进去，不再生成「New group」这类占位组 */}
                <Show when={creating() && createFor() === assignFor()}>
                  <div class="w-full pt-1">
                    <GroupNameInput placeholder="New group name" onCommit={commitCreate} onCancel={cancelCreate} />
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        )}
      </For>

      {/* 新建组：底部入口，输入组名回车即建 */}
      <Show when={!creating()}>
        <button
          type="button"
          class="mt-1 flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] text-faint transition-colors hover:text-text"
          onClick={() => {
            setCreateFor("")
            setCreating(true)
          }}
        >
          <svg viewBox="0 0 16 16" class="size-3" fill="none" stroke="currentColor" stroke-width="1.6">
            <path d="M8 3.5v9M3.5 8h9" stroke-linecap="round" />
          </svg>
          New group
        </button>
      </Show>
      <Show when={creating() && !createFor()}>
        <div class="mt-1 px-2 py-1">
          <GroupNameInput placeholder="Group name" onCommit={commitCreate} onCancel={cancelCreate} />
        </div>
      </Show>
    </div>
  )
}

export default SessionGroupList
