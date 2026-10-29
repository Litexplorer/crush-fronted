/**
 * echarts.ts
 * 核心流程：ECharts 图表渲染 ——
 *           loadEcharts   首次使用时动态 import 完整 echarts，避免主包体积膨胀
 *           buildTheme    读取 CSS 变量生成主题，跟随亮/暗色切换
 *           parseOption   围栏内容按 JSON 解析（仅容错尾随逗号），不执行任何脚本
 *           renderEcharts 释放旧实例 → init（SVG 渲染器）→ setOption → 观察尺寸 → 返回销毁函数
 */
import { themeMode, type Theme } from "./themes"

type EChartsModule = typeof import("echarts")
type EChartsOption = import("echarts").EChartsOption
type ThemeOption = Parameters<EChartsModule["registerTheme"]>[1]

let echartsPromise: Promise<EChartsModule> | undefined

/** 主题名固定：每次渲染前重新注册覆盖，避免主题切换后仍用旧配色 */
const THEME_NAME = "crush-echarts"
const FONT_FAMILY = "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif"

/** 分支配色：亮色主题偏深，暗色主题偏亮，保证两种背景下都有对比度 */
const LIGHT_PALETTE = ["#1c7ed6", "#e8590c", "#2f9e44", "#c2255c", "#6741d9", "#0c8599", "#f08c00", "#495057", "#1098ad", "#a61e4d"]
const DARK_PALETTE = ["#4dabf7", "#ffa94d", "#69db7c", "#f783ac", "#b197fc", "#66d9e8", "#ffd43b", "#adb5bd", "#3bc9db", "#e599f7"]

/**
 * cssVar
 * 参数：name CSS 变量名；fallback 变量缺失时的兜底色
 * 核心流程：读取根元素计算样式，空值回退兜底色，保证图表始终有可读配色
 */
function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/**
 * buildTheme
 * 参数：theme 当前界面主题
 * 核心流程：文字/边框/浮层配色全部取自 CSS 变量，网格与轴线用弱化的边框色，
 *           使图表融入消息卡片而不是自带一套默认灰蓝
 */
function buildTheme(theme: Theme): ThemeOption {
  const dark = themeMode(theme) === "dark"
  const text = cssVar("--text-base", dark ? "#e6e6e6" : "#1f2328")
  const muted = cssVar("--text-muted", dark ? "#9aa4b2" : "#57606a")
  const faint = cssVar("--text-faint", dark ? "#6b7280" : "#8c959f")
  const panel = cssVar("--bg-raised", dark ? "#1c1f24" : "#f6f8fa")
  const border = cssVar("--border-base", dark ? "#30363d" : "#d0d7de")
  const strong = cssVar("--border-strong", dark ? "#3d444d" : "#afb8c1")

  const axis = {
    axisLine: { lineStyle: { color: border } },
    axisTick: { lineStyle: { color: border } },
    axisLabel: { color: muted },
    splitLine: { lineStyle: { color: border } },
    splitArea: { areaStyle: { color: ["transparent", "transparent"] } },
    nameTextStyle: { color: muted },
  }

  return {
    color: dark ? DARK_PALETTE : LIGHT_PALETTE,
    backgroundColor: "transparent",
    textStyle: { color: text, fontFamily: FONT_FAMILY, fontSize: 12 },
    title: { textStyle: { color: text, fontWeight: 600 }, subtextStyle: { color: muted } },
    legend: {
      textStyle: { color: muted },
      pageTextStyle: { color: muted },
      inactiveColor: faint,
      itemWidth: 12,
      itemHeight: 8,
    },
    tooltip: {
      backgroundColor: panel,
      borderColor: border,
      borderWidth: 1,
      textStyle: { color: text, fontSize: 12 },
      extraCssText: "box-shadow: 0 6px 20px rgba(0,0,0,.18); border-radius: 6px;",
      axisPointer: {
        lineStyle: { color: strong },
        crossStyle: { color: strong },
        label: { backgroundColor: panel, borderColor: border, color: text },
      },
    },
    categoryAxis: axis,
    valueAxis: axis,
    logAxis: axis,
    timeAxis: axis,
    radar: {
      axisName: { color: muted },
      splitLine: { lineStyle: { color: border } },
      splitArea: { areaStyle: { color: ["transparent", dark ? "rgba(255,255,255,.03)" : "rgba(0,0,0,.02)"] } },
    },
    dataZoom: {
      textStyle: { color: muted },
      borderColor: border,
      fillerColor: dark ? "rgba(77,171,247,.16)" : "rgba(28,126,214,.12)",
      handleStyle: { color: panel, borderColor: strong },
      moveHandleStyle: { color: strong },
      dataBackground: {
        lineStyle: { color: border },
        areaStyle: { color: dark ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.04)" },
      },
    },
    visualMap: { textStyle: { color: muted } },
    toolbox: { iconStyle: { borderColor: muted }, textStyle: { color: muted } },
  } as ThemeOption
}

/**
 * loadEcharts
 * 参数：theme 当前界面主题
 * 核心流程：动态 import 并缓存模块；每次调用都重新注册主题，让实例拿到最新 CSS 变量
 */
async function loadEcharts(theme: Theme): Promise<EChartsModule> {
  echartsPromise ??= import("echarts")
  const echarts = await echartsPromise
  echarts.registerTheme(THEME_NAME, buildTheme(theme))
  return echarts
}

/**
 * parseJson
 * 参数：text 围栏原始内容
 * 核心流程：先按标准 JSON 解析；失败后去掉尾随逗号重试一次（模型输出常见），仍失败则抛错
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return JSON.parse(text.replace(/,\s*(?=[\]}])/g, ""))
  }
}

/**
 * parseOption
 * 参数：source 围栏内的 ECharts option
 * 核心流程：拒绝非对象与非 JSON 内容（不执行脚本，与 DOMPurify 的防注入策略一致）；
 *           缺少 series 时提前报错，避免渲染出一块空白画布
 */
function parseOption(source: string): EChartsOption {
  const text = source.trim()
  if (!text) throw new Error("ECharts option is empty")

  const parsed = parseJson(text)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ECharts option must be a JSON object")
  }
  const option = parsed as EChartsOption
  if (!option.series) throw new Error("ECharts option is missing series")
  return option
}

/**
 * renderEcharts
 * 参数：target 图表容器；source option 原文；theme 当前主题
 * 核心流程：解析 option → 加载 echarts → 释放容器上的旧实例 → init（SVG 渲染器）→
 *           一次性 setOption（notMerge，避免上一份配置的系列残留）→ 监听尺寸变化重排；
 *           返回幂等的销毁函数，断开观察并 dispose 掉实例
 */
export async function renderEcharts(target: HTMLElement, source: string, theme: Theme): Promise<() => void> {
  const option = parseOption(source)
  const echarts = await loadEcharts(theme)

  // 释放容器上可能残留的实例：echarts 用 DOM 属性登记实例，直接清子节点会留下野引用
  echarts.getInstanceByDom(target)?.dispose()
  target.replaceChildren()

  const chart = echarts.init(target, THEME_NAME, { renderer: "svg" })
  chart.setOption(option, { notMerge: true })

  // 侧栏/窗口变化后重新布局；隐藏态宽高为 0，跳过以免把画布压成 0
  const observer = new ResizeObserver(() => {
    if (target.clientWidth > 0 && target.clientHeight > 0) chart.resize()
  })
  observer.observe(target)

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    observer.disconnect()
    chart.dispose()
    target.replaceChildren()
  }
}
