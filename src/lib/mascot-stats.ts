/**
 * mascot-stats.ts
 * 核心流程：跨组件只读的「当前模型上下文窗口」——
 *           会话页的 ModelSelect 上报后写入这里，鲸鱼娘定时巡检据此算上下文占比；
 *           离开会话页写回 undefined，避免拿旧窗口算新会话
 */
import { createSignal } from "solid-js"

const [contextWindow, setContextWindow] = createSignal<number | undefined>(undefined)

export { contextWindow }

/**
 * rememberContextWindow
 * 参数：value 当前模型的上下文窗口（token 数），未知时传 undefined
 * 核心流程：直接写入信号，供 lib/mascot-report 读取
 */
export function rememberContextWindow(value: number | undefined) {
  setContextWindow(value)
}
