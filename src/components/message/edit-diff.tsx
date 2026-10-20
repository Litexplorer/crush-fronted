/**
 * edit-diff.tsx
 * 参数：props.data 解析好的编辑前后内容（含路径与统计）
 * 核心流程：用 diff 库把 old_content/new_content 转成行级 patch →
 *           左右两栏配对渲染（左 Before / 右 After），删除与新增逐行对齐；
 *           顶部展示文件路径与 +N/−N，超高时内部滚动
 */
import { createMemo, For, Show } from "solid-js"
import { structuredPatch } from "diff"
import { parseToolInput } from "./tool-visuals"

/** 编辑 diff 数据源：整文件前后内容由 tool_result.metadata 提供 */
export interface EditDiffData {
  filePath: string
  oldContent: string
  newContent: string
}

/** 单元格：行号 + 文本 */
interface DiffCell {
  no: number
  text: string
}

/** 渲染行：hunk 头/元信息占满整行，pair 为左右两栏 */
type DiffRow =
  | { kind: "hunk" | "meta"; text: string }
  | { kind: "pair"; left: DiffCell | null; right: DiffCell | null; changed: boolean }

/**
 * parseEditsDiff
 * 参数：input multiedit 的输入对象（file_path + edits 数组）；filePath 展示用路径
 * 核心流程：把每条 edit 的 old_string/new_string 按行拼成前后两份文本，
 *           使 structuredPatch 能逐条产出独立的变更块（用于 metadata 缺失时的兜底）；
 *           全部 old_string 为空（新建文件）时前文本留空，呈现纯新增
 */
function parseEditsDiff(input: Record<string, unknown>, filePath: string): EditDiffData | undefined {
  const edits = Array.isArray(input.edits) ? input.edits : undefined
  if (!edits || edits.length === 0) return undefined
  const oldParts: string[] = []
  const newParts: string[] = []
  for (const item of edits) {
    if (!item || typeof item !== "object") continue
    const op = item as Record<string, unknown>
    const oldString = typeof op.old_string === "string" ? op.old_string : ""
    const newString = typeof op.new_string === "string" ? op.new_string : ""
    if (oldString === "" && newString === "") continue
    oldParts.push(oldString)
    newParts.push(newString)
  }
  if (oldParts.length === 0) return undefined
  // 每条片段补齐换行后再拼接：行数一一对应，diff 逐条产出独立变更块，且不出现「No newline」噪声行
  const terminate = (part: string) => (part === "" || part.endsWith("\n") ? part : `${part}\n`)
  const oldContent = oldParts.every((part) => part === "") ? "" : oldParts.map(terminate).join("")
  const newContent = newParts.map(terminate).join("")
  if (oldContent === newContent) return undefined
  return { filePath, oldContent, newContent }
}

/**
 * parseEditDiff
 * 参数：inputRaw 工具输入 JSON；metadata tool_result 的 metadata 字符串
 * 核心流程：优先用 metadata 的整文件 old_content/new_content（可展示真实行号与上下文）；
 *           结果尚未返回时回退到输入：edit 取 old_string/new_string，
 *           multiedit 取 edits 数组逐条拼接（仅展示替换片段）；
 *           两者都没有则返回 undefined，由调用方回退原始 JSON 视图
 */
export function parseEditDiff(inputRaw: string | undefined, metadata: string | undefined): EditDiffData | undefined {
  const input = parseToolInput(inputRaw)
  const filePath = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : ""

  if (metadata) {
    try {
      // 解析后端 metadata：编辑成功时附带整文件前后内容
      const meta = JSON.parse(metadata) as Record<string, unknown>
      const oldContent = meta.old_content
      const newContent = meta.new_content
      if (typeof oldContent === "string" && typeof newContent === "string") {
        if (oldContent !== newContent) return { filePath, oldContent, newContent }
      }
    } catch {
      // metadata 非 JSON：继续尝试 input 兜底
    }
  }

  const oldString = input.old_string
  const newString = input.new_string
  if (typeof oldString === "string" && typeof newString === "string" && oldString !== newString) {
    return { filePath, oldContent: oldString, newContent: newString }
  }
  return parseEditsDiff(input, filePath)
}

/**
 * buildRows
 * 参数：oldContent 编辑前内容；newContent 编辑后内容
 * 核心流程：structuredPatch 生成 hunk → 逐行转成左右配对行；
 *           连续删除/新增按索引配对，不足一侧补空行，上下文行两侧同文
 */
function buildRows(oldContent: string, newContent: string): { rows: DiffRow[]; additions: number; deletions: number } {
  const patch = structuredPatch("before", "after", oldContent, newContent, "", "")
  const rows: DiffRow[] = []
  let additions = 0
  let deletions = 0

  for (const hunk of patch.hunks) {
    rows.push({ kind: "hunk", text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` })
    let oldNo = hunk.oldStart
    let newNo = hunk.newStart
    let removed: DiffCell[] = []
    let added: DiffCell[] = []

    // 落盘当前删除/新增块：按序号左右配对，多出的一侧补空
    const flush = () => {
      const count = Math.max(removed.length, added.length)
      for (let i = 0; i < count; i++) {
        rows.push({ kind: "pair", left: removed[i] ?? null, right: added[i] ?? null, changed: true })
      }
      removed = []
      added = []
    }

    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        additions++
        added.push({ no: newNo++, text: line.slice(1) })
      } else if (line.startsWith("-")) {
        deletions++
        removed.push({ no: oldNo++, text: line.slice(1) })
      } else if (line.startsWith("\\")) {
        flush()
        rows.push({ kind: "meta", text: line })
      } else {
        flush()
        rows.push({
          kind: "pair",
          left: { no: oldNo++, text: line.slice(1) },
          right: { no: newNo++, text: line.slice(1) },
          changed: false,
        })
      }
    }
    flush()
  }

  return { rows, additions, deletions }
}

/**
 * EditDiff
 * 参数：props.data 编辑前后内容与文件路径
 * 核心流程：构建行级 patch 后渲染左右两栏对照表；
 *           左栏删除行标红、右栏新增行标绿，上下文行保持正文色
 */
export default function EditDiff(props: { data: EditDiffData }) {
  const view = createMemo(() => buildRows(props.data.oldContent, props.data.newContent))

  const pair = (row: DiffRow) => (row.kind === "pair" ? row : undefined)

  return (
    <div class="overflow-hidden rounded-[8px] border border-edge">
      {/* 头部：文件路径 + 增删统计 */}
      <div class="flex items-center gap-2 border-b border-edge bg-raised/40 px-2.5 py-1.5">
        <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-text" title={props.data.filePath}>
          {props.data.filePath || "diff"}
        </span>
        <span class="shrink-0 text-[11px] text-[#3fb950]">+{view().additions}</span>
        <span class="shrink-0 text-[11px] text-[#e5484d]">−{view().deletions}</span>
      </div>
      {/* 栏目标题：左右对照语义 */}
      <div class="grid grid-cols-2 border-b border-edge bg-raised/20 text-[10px] uppercase tracking-wide text-faint">
        <span class="truncate px-2.5 py-1">Before</span>
        <span class="truncate border-l border-edge px-2.5 py-1">After</span>
      </div>
      {/* diff 主体：左右两栏同一网格行，行高自动对齐 */}
      <div class="max-h-[420px] overflow-auto">
        <Show
          when={view().rows.length > 0}
          fallback={<div class="px-2.5 py-3 text-[12px] text-faint">No line changes</div>}
        >
          <div class="grid grid-cols-2 font-mono text-[12px] leading-5">
            <For each={view().rows}>
              {(row) => (
                <Show
                  when={pair(row)}
                  fallback={
                    <div
                      class="col-span-2 truncate border-t border-edge bg-raised/40 px-2.5 py-0.5 text-[11px]"
                      classList={{
                        "text-accent": row.kind === "hunk",
                        "text-faint italic": row.kind === "meta",
                      }}
                    >
                      {row.kind === "hunk" || row.kind === "meta" ? row.text : ""}
                    </div>
                  }
                >
                  {(p) => (
                    <>
                      <div
                        class="flex min-w-0 border-t border-edge/60 border-r px-2 py-0.5"
                        classList={{
                          "bg-[#e5484d]/10": p().changed && !!p().left,
                          "bg-raised/20": p().changed && !p().left,
                        }}
                      >
                        <span class="w-8 shrink-0 select-none pr-2 text-right text-faint">{p().left?.no ?? ""}</span>
                        <span
                          class="min-w-0 flex-1 whitespace-pre-wrap break-words"
                          classList={{
                            "text-[#e5484d]": p().changed && !!p().left,
                            "text-text": !p().changed,
                          }}
                        >
                          {p().left?.text ?? ""}
                        </span>
                      </div>
                      <div
                        class="flex min-w-0 border-t border-edge/60 px-2 py-0.5"
                        classList={{
                          "bg-[#3fb950]/10": p().changed && !!p().right,
                          "bg-raised/20": p().changed && !p().right,
                        }}
                      >
                        <span class="w-8 shrink-0 select-none pr-2 text-right text-faint">{p().right?.no ?? ""}</span>
                        <span
                          class="min-w-0 flex-1 whitespace-pre-wrap break-words"
                          classList={{
                            "text-[#3fb950]": p().changed && !!p().right,
                            "text-text": !p().changed,
                          }}
                        >
                          {p().right?.text ?? ""}
                        </span>
                      </div>
                    </>
                  )}
                </Show>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}
