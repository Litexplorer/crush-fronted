/**
 * session-groups.ts
 * 核心流程：把打开的会话标签按项目分组 ——
 *           分组键用 projectPath（workspace id 是服务端内存态，重启后会变），
 *           标题栏、标签列表浮层、命令面板共用同一份分组与配色，避免三处顺序不一致
 */
import type { SessionGroup } from "./session-group-store"
import type { ActiveSession } from "./ui-store"
import { workspaceColor } from "./workspace-color"

export interface SessionTabGroup {
  /** 分组键：用户分组为 group:<id>，否则是项目绝对路径（缺失时退化为 workspace id） */
  key: string
  /** 用户分组 id：非空表示这一组由用户命名、可改名改色 */
  groupId?: string
  /** 展示用分组名：用户组取组名，项目组取路径最后一段 */
  label: string
  /** 分组配色（色条 / 色点）：用户组取组色，项目组按路径哈希 */
  solid?: string
  tabs: ActiveSession[]
}

/**
 * projectLabel
 * 参数：key 分组键（项目绝对路径，缺失时为 workspace id）
 * 核心流程：取路径最后一段作为项目名，取不到时回退原值
 */
export function projectLabel(key: string): string {
  const parts = key.replace(/\/+$/, "").split("/").filter(Boolean)
  return parts[parts.length - 1] || key
}

/**
 * groupSessionTabs
 * 参数：tabs 已打开的会话标签；userGroups 用户命名的分组；overrides 单会话归属
 * 核心流程：归属到用户分组的标签按 group:<id> 聚成一组（组名与组色取配置）；
 *           其余标签沿用「按项目分组」的老规则，配色按路径固定——
 *           两种分组共存，组顺序都按首次出现顺序，拖拽换位不会跳来跳去
 */
export function groupSessionTabs(
  tabs: ActiveSession[],
  userGroups: SessionGroup[] = [],
  overrides: Record<string, string> = {},
): SessionTabGroup[] {
  const byId = new Map(userGroups.map((group) => [group.id, group]))
  const groups = new Map<string, SessionTabGroup>()
  for (const tab of tabs) {
    const owner = byId.get(overrides[tab.id] ?? "")
    const key = owner ? `group:${owner.id}` : tab.projectPath || tab.workspaceId
    const existing = groups.get(key)
    if (existing) {
      existing.tabs.push(tab)
      continue
    }
    groups.set(key, {
      key,
      groupId: owner?.id,
      label: owner ? owner.name : projectLabel(key),
      solid: owner ? (owner.color ?? workspaceColor(owner.id)?.solid) : workspaceColor(tab.projectPath ?? tab.workspaceId)?.solid,
      tabs: [tab],
    })
  }
  return [...groups.values()]
}

/** 会话列表行：面板渲染需要的字段，由 Session + 项目路径拼成 */
export interface SessionListRow {
  id: string
  title: string
  /** 首条 user 消息首行（后端 subtitle），缺失时退化为空 */
  subtitle?: string
  workspaceId: string
  projectPath?: string
  messageCount: number
  /** Unix 秒 */
  updatedAt: number
  isBusy: boolean
}

/** 一排会话：用户命名的组，或最后一组「未分组」 */
export interface SessionListGroup {
  key: string
  label: string
  color?: string
  collapsed: boolean
  sessions: SessionListRow[]
}

/** 未分组桶的 key：不参与配置，永远排在最后 */
export const UNGROUPED_KEY = "__ungrouped__"

/**
 * groupSessionRows
 * 参数：rows 已过滤的会话行；groups 用户定义的组；overrides 单会话归属
 * 核心流程：按配置顺序建组（空组也保留，便于先建组再归位）→ 逐行按 overrides
 *           落组，未命中或指向已删组时进未分组 → 组内按更新时间倒序 →
 *           未分组桶非空时追加到最后
 */
export function groupSessionRows(
  rows: SessionListRow[],
  groups: SessionGroup[],
  overrides: Record<string, string>,
): SessionListGroup[] {
  const buckets = new Map<string, SessionListGroup>()
  for (const group of groups) {
    buckets.set(group.id, {
      key: group.id,
      label: group.name,
      color: group.color ?? workspaceColor(group.id)?.solid,
      collapsed: group.collapsed === true,
      sessions: [],
    })
  }
  const ungrouped: SessionListGroup = {
    key: UNGROUPED_KEY,
    label: "Ungrouped",
    collapsed: false,
    sessions: [],
  }
  const byUpdatedAt = (a: SessionListRow, b: SessionListRow) => b.updatedAt - a.updatedAt
  for (const row of rows) {
    const target = overrides[row.id]
    const bucket = target ? buckets.get(target) : undefined
    ;(bucket ?? ungrouped).sessions.push(row)
  }
  for (const bucket of buckets.values()) bucket.sessions.sort(byUpdatedAt)
  ungrouped.sessions.sort(byUpdatedAt)
  const result = groups.map((group) => buckets.get(group.id)).filter((bucket): bucket is SessionListGroup => !!bucket)
  if (ungrouped.sessions.length > 0) result.push(ungrouped)
  return result
}

/**
 * relativeSessionTime
 * 参数：updatedAt Unix 秒；now 毫秒时间戳（便于测试注入）
 * 核心流程：秒 → 分钟 → 小时 → 天 → 周 → 月 → 年，取到第一个能表达的量级，
 *           与列表里的 6d / 23h / 31m 一致
 */
export function relativeSessionTime(updatedAt: number, now = Date.now()): string {
  if (!updatedAt) return ""
  const seconds = Math.max(0, Math.floor(now / 1000) - updatedAt)
  if (seconds < 60) return "now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  if (days < 30) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}y`
}

/**
 * sessionInitial
 * 参数：title 会话标题
 * 核心流程：取第一个字母或数字作为头像字符（大写），取不到时用 #
 */
export function sessionInitial(title: string): string {
  const match = /[\p{L}\p{N}]/u.exec(title || "")
  return match ? match[0].toUpperCase() : "#"
}
