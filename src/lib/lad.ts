/**
 * lad.ts
 * 核心流程：梯形图（LAD）渲染 ——
 *           loadLad    首次使用时动态 import schematex/ladder，避免主包体积膨胀
 *           renderLad  文本 DSL → AST → SVG 字符串，明暗主题跟随当前 UI 主题
 */
import { themeMode, type Theme } from "./themes"

type LadApi = typeof import("schematex/ladder")

let ladPromise: Promise<LadApi> | undefined

/**
 * loadLad
 * 核心流程：单次动态导入并缓存 Promise，多图并发只加载一次
 */
function loadLad(): Promise<LadApi> {
  ladPromise ??= import("schematex/ladder")
  return ladPromise
}

/**
 * renderLad
 * 参数：source 梯形图 DSL 原文；currentTheme 当前 UI 主题 id
 * 核心流程：解析 DSL 得到 AST → 按主题明暗与正文同字号渲染 SVG；
 *           语法错误由调用方捕获并回退为源码展示
 */
export async function renderLad(source: string, currentTheme: Theme): Promise<string> {
  const { parseLadderDSL, renderLadder } = await loadLad()
  const ast = parseLadderDSL(source)
  return renderLadder(ast, {
    theme: themeMode(currentTheme) === "light" ? "light" : "dark",
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif",
    fontSize: 12,
    padding: 16,
  })
}
