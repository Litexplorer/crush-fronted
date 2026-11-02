/**
 * side-rail.tsx
 * 参数：props.label 竖排文案；props.count 数量徽标（0 不显示）；props.title 悬浮提示；
 *       props.direction 展开方向（left 表示面板在右侧向左展开，right 表示在左侧向右展开）；
 *       props.inactive 宿主已展开时置真（竖轨收成 0 宽），按钮退化为禁用态，不占 Tab 焦点
 * 核心流程：侧栏收起后留在页面边缘的 28px 竖轨 ——
 *           方向图标 + 竖排文案 + 数量徽标，整条即点击区域；
 *           点一下交给宿主展开，宿主负责持久化与移动端形态
 */
import { Show } from "solid-js"

/**
 * SideRail
 * 参数：见文件头
 * 核心流程：渲染 28px 竖轨按钮 —— 图标在上、竖排文案居中、数量徽标贴底；
 *           图标按展开方向镜像，hover 时朝该方向位移 1px 强化方向感
 */
export function SideRail(props: {
  label: string
  count: number
  title: string
  direction: "left" | "right"
  inactive?: boolean
  onExpand: () => void
}) {
  const iconClass = () =>
    props.direction === "left"
      ? "transition-transform duration-200 ease-out group-hover:-translate-x-0.5"
      : "rotate-180 transition-transform duration-200 ease-out group-hover:translate-x-0.5"

  return (
    <button
      type="button"
      aria-label={props.title}
      title={props.title}
      disabled={props.inactive}
      class="group flex h-full w-7 shrink-0 flex-col items-center gap-2 rounded-[10px] border border-edge bg-base py-2.5 text-muted transition-colors hover:border-edge-strong hover:bg-raised hover:text-text disabled:pointer-events-none"
      onClick={() => props.onExpand()}
    >
      {/* 方向图标：双箭头指向展开方向 */}
      <svg
        viewBox="0 0 16 16"
        class={`size-4 shrink-0 ${iconClass()}`}
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M8.5 4.5 5 8l3.5 3.5" />
        <path d="M12 4.5 8.5 8l3.5 3.5" />
      </svg>
      {/* 竖排文案：窄轨里横排放不下，用 writing-mode 转 90 度 */}
      <span class="text-[11px] font-medium tracking-wide" style={{ "writing-mode": "vertical-rl" }}>
        {props.label}
      </span>
      {/* 数量徽标：收起态也能看到条目数，为 0 时不占位 */}
      <Show when={props.count > 0}>
        <span class="mt-auto rounded-[5px] bg-raised px-1 py-0.5 text-[10px] leading-3 text-muted">
          {props.count}
        </span>
      </Show>
    </button>
  )
}
