/**
 * session-groups.ts
 * 核心流程：把打开的会话标签按项目分组 ——
 *           分组键用 projectPath（workspace id 是服务端内存态，重启后会变），
 *           标题栏、标签列表浮层、命令面板共用同一份分组与配色，避免三处顺序不一致
 */
import type { ActiveSession } from "./ui-store"
import { workspaceColor } from "./workspace-color"

export interface SessionTabGroup {
  /** 分组键：项目绝对路径，缺失时退化为 workspace id */
  key: string
  /** 展示用项目名（路径最后一段） */
  label: string
  /** 项目配色（色条 / 色点） */
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
 * 参数：tabs 已打开的会话标签
 * 核心流程：按首次出现顺序建立项目分组，组内保持标签原顺序；
 *           配色按分组键固定，同一项目在任何界面都是同一个颜色
 */
export function groupSessionTabs(tabs: ActiveSession[]): SessionTabGroup[] {
  const groups = new Map<string, SessionTabGroup>()
  for (const tab of tabs) {
    const key = tab.projectPath || tab.workspaceId
    const existing = groups.get(key)
    if (existing) {
      existing.tabs.push(tab)
      continue
    }
    groups.set(key, {
      key,
      label: projectLabel(key),
      solid: workspaceColor(tab.projectPath ?? tab.workspaceId)?.solid,
      tabs: [tab],
    })
  }
  return [...groups.values()]
}
