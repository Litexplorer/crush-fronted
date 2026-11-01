/**
 * viewport.ts
 * 参数：无
 * 核心流程：提供移动端视口判断 ——
 *           以 767px（Tailwind md 断点下沿）为界，窄于此视为移动端；
 *           matchMedia 变化时更新 signal，旋转屏幕/拖动窗口即时生效；
 *           模块级单例监听，多个组件共享同一信号
 */
import { createSignal } from "solid-js"

/** 移动端媒体查询：与 Tailwind max-md 变体保持同一条断点 */
const MOBILE_QUERY = "(max-width: 767px)"

/**
 * readIsMobile
 * 参数：无
 * 核心流程：读取当前视口是否命中移动端查询；无 matchMedia（SSR/老浏览器）时按桌面处理
 */
function readIsMobile(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  return window.matchMedia(MOBILE_QUERY).matches
}

const [isMobile, setIsMobile] = createSignal(readIsMobile())

export { isMobile }

/**
 * 监听视口变化
 * 参数：无
 * 核心流程：模块加载即绑定一次 media query change，命中即更新信号；
 *           老 Safari 只有 addListener，做兼容，重复调用不会重复绑定
 */
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const query = window.matchMedia(MOBILE_QUERY)
  const onChange = (event: MediaQueryListEvent) => setIsMobile(event.matches)
  if (typeof query.addEventListener === "function") query.addEventListener("change", onChange)
  else if (typeof query.addListener === "function") query.addListener(onChange)
}
