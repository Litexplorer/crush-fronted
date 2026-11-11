/**
 * session-group-store.ts
 * 参数：无
 * 核心流程：会话分组的本地配置 ——
 *           组（名称 / 颜色 / 折叠）与「会话 → 组」的归属全部落在 localStorage，
 *           换设备不同步；所有写操作走 persist() 归一化后广播 signal 触发重渲染
 */
import { createSignal } from "solid-js"

/** 存储键：结构变更时升版本号，旧键留在本地不参与读取 */
const STORAGE_KEY = "crush.sessionGroups.v1"

/** 一个用户命名的会话分组 */
export interface SessionGroup {
  id: string
  name: string
  /** 组色（PALETTE 之一）；缺省时按组 id 哈希取色 */
  color?: string
  /** 折叠态：折叠后组内会话不渲染 */
  collapsed?: boolean
}

/** 落盘的分组配置：groups 决定顺序，overrides 记录单会话的手动归属 */
export interface SessionGroupConfig {
  version: 1
  groups: SessionGroup[]
  /** sessionId → groupId；指向已删除组的条目在分组时被忽略 */
  overrides: Record<string, string>
}

const EMPTY: SessionGroupConfig = { version: 1, groups: [], overrides: {} }

/**
 * normalizeGroup
 * 参数：value 本地存储里的任意值
 * 核心流程：只采信形状合法的字段，缺失的 id/name 直接丢弃，避免脏数据进 UI
 */
function normalizeGroup(value: unknown): SessionGroup | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === "string" ? raw.id.trim() : ""
  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  if (!id || !name) return undefined
  const group: SessionGroup = { id, name }
  if (typeof raw.color === "string" && raw.color.trim()) group.color = raw.color.trim()
  if (raw.collapsed === true) group.collapsed = true
  return group
}

/**
 * readConfig
 * 参数：无
 * 核心流程：读取并归一化本地配置；解析失败或结构不符时回退空配置，并把脏值覆盖掉
 */
function readConfig(): SessionGroupConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return EMPTY
    const parsed = JSON.parse(stored) as Record<string, unknown>
    const groups = Array.isArray(parsed.groups)
      ? parsed.groups.map(normalizeGroup).filter((group): group is SessionGroup => !!group)
      : []
    const overrides: Record<string, string> = {}
    if (parsed.overrides && typeof parsed.overrides === "object") {
      for (const [sessionId, groupId] of Object.entries(parsed.overrides as Record<string, unknown>)) {
        if (typeof groupId === "string" && groupId) overrides[sessionId] = groupId
      }
    }
    return { version: 1, groups, overrides }
  } catch {
    return EMPTY
  }
}

const [config, setConfig] = createSignal<SessionGroupConfig>(readConfig())

/**
 * persist
 * 参数：next 新的完整配置
 * 核心流程：先广播 signal（界面立刻响应）再落盘，写盘失败只影响持久化不影响本次交互
 */
function persist(next: SessionGroupConfig) {
  setConfig(next)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 隐私模式 / 配额用尽：内存态继续生效，下次刷新丢配置
  }
}

/** newGroupId：优先用 crypto.randomUUID，旧浏览器退回时间戳 + 随机数 */
function newGroupId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 当前分组配置（响应式，读 groups 和 overrides 的地方会自动订阅） */
export const sessionGroupConfig = config

/**
 * createSessionGroup
 * 参数：name 组名（调用方已 trim，空名视为无效）
 * 核心流程：同名组已存在时直接复用它的 id（不再追加），避免手滑建出两条同名记录；
 *           否则追加到配置末尾 → 返回新组 id，供调用方立刻把会话指派进去
 */
export function createSessionGroup(name: string): string | undefined {
  const trimmed = name.trim()
  if (!trimmed) return undefined
  const current = config()
  const existing = current.groups.find((group) => group.name.toLowerCase() === trimmed.toLowerCase())
  if (existing) return existing.id
  const group: SessionGroup = { id: newGroupId(), name: trimmed }
  persist({ ...current, groups: [...current.groups, group] })
  return group.id
}

/**
 * renameSessionGroup
 * 参数：id 组 id；name 新组名
 * 核心流程：改名的空名输入视为取消，保持原值不动
 */
export function renameSessionGroup(id: string, name: string) {
  const trimmed = name.trim()
  if (!trimmed) return
  const current = config()
  persist({
    ...current,
    groups: current.groups.map((group) => (group.id === id ? { ...group, name: trimmed } : group)),
  })
}

/**
 * setSessionGroupColor
 * 参数：id 组 id；color 十六进制色值（undefined / 空串表示恢复自动色）
 */
export function setSessionGroupColor(id: string, color?: string) {
  const current = config()
  persist({
    ...current,
    groups: current.groups.map((group) => {
      if (group.id !== id) return group
      if (color === undefined || color.trim() === "") {
        const { color: _drop, ...rest } = group
        return rest
      }
      return { ...group, color: color.trim() }
    }),
  })
}

/**
 * toggleSessionGroupCollapsed
 * 参数：id 组 id
 * 核心流程：折叠状态是展示态，只翻转本组，不动组顺序与归属
 */
export function toggleSessionGroupCollapsed(id: string) {
  const current = config()
  persist({
    ...current,
    groups: current.groups.map((group) =>
      group.id === id ? { ...group, collapsed: !group.collapsed } : group,
    ),
  })
}

/**
 * deleteSessionGroup
 * 参数：id 组 id
 * 核心流程：删除组的同时清掉指向它的归属，组内会话回到未分组而不是消失
 */
export function deleteSessionGroup(id: string) {
  const current = config()
  const overrides: Record<string, string> = {}
  for (const [sessionId, groupId] of Object.entries(current.overrides)) {
    if (groupId !== id) overrides[sessionId] = groupId
  }
  persist({ version: 1, groups: current.groups.filter((group) => group.id !== id), overrides })
}

/**
 * assignSessionGroup
 * 参数：sessionId 会话 id；groupId 目标组 id（undefined 表示移出分组）
 * 核心流程：写入 / 删除单条归属；归属表是唯一影响分组结果的字段
 */
export function assignSessionGroup(sessionId: string, groupId?: string) {
  const current = config()
  const overrides = { ...current.overrides }
  if (groupId) overrides[sessionId] = groupId
  else delete overrides[sessionId]
  persist({ ...current, overrides })
}
