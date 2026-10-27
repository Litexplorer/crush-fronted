/**
 * key-prefix.ts
 * 核心流程：快捷键「前缀模式」——
 *           按 Ctrl+B 进入待命，接下来 2 秒内按方向键才会切换标签；
 *           前缀被用掉/超时/按了别的键都立即退出，避免状态残留
 */
import { createSignal } from "solid-js"

/** 前缀待命时长：够按下第二个键，又不会长时间改动方向键的含义 */
export const PREFIX_TTL_MS = 2000

const [prefixActive, setPrefixActive] = createSignal(false)

let timer: ReturnType<typeof setTimeout> | undefined

/** 前缀是否处于待命状态：标签栏用来显示提示 */
export { prefixActive }

/**
 * armPrefix
 * 参数：无
 * 核心流程：进入待命并重置 2 秒超时；重复按 Ctrl+B 只顺延，不叠加
 */
export function armPrefix() {
  setPrefixActive(true)
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = undefined
    setPrefixActive(false)
  }, PREFIX_TTL_MS)
}

/**
 * cancelPrefix
 * 参数：无
 * 核心流程：立即退出待命并清掉超时；非方向键、打开命令面板时调用
 */
export function cancelPrefix() {
  if (timer) {
    clearTimeout(timer)
    timer = undefined
  }
  setPrefixActive(false)
}

/**
 * consumePrefix
 * 参数：无
 * 核心流程：若正在待命则消费掉（退出待命）并返回 true；
 *           方向键处理逻辑据此判断本次按键是否该被当成标签切换
 */
export function consumePrefix(): boolean {
  if (!prefixActive()) return false
  cancelPrefix()
  return true
}
