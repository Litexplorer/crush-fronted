/**
 * smoke-echarts.tsx
 * 核心流程：ECharts 渲染冒烟页 —— 生成覆盖常见图形类型的 Markdown 围栏，
 *           交给真实的 MarkdownText 组件渲染，并把每块的状态与 SVG 节点数写入 #report 供核对
 */
import { render } from "solid-js/web"
import "./index.css"
import { MarkdownText } from "./components/message/markdown"
import { setTheme } from "./lib/ui-store"

const seriesData = Array.from({ length: 200 }, (_, index) => [index, Math.round(Math.sin(index / 12) * 40 + 60)])

const cases: Array<[string, unknown]> = [
  [
    "折线 + 面积",
    {
      title: { text: "CPU 使用率" },
      tooltip: { trigger: "axis" },
      legend: { data: ["node-a", "node-b"] },
      xAxis: { type: "category", boundaryGap: false, data: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] },
      yAxis: { type: "value", axisLabel: { formatter: "{value}%" } },
      series: [
        { name: "node-a", type: "line", smooth: true, areaStyle: {}, data: [42, 55, 61, 48, 70, 63, 58] },
        { name: "node-b", type: "line", smooth: true, data: [30, 34, 45, 52, 41, 39, 47] },
      ],
    },
  ],
  [
    "柱状 + 堆叠",
    {
      tooltip: { trigger: "axis" },
      legend: { data: ["读", "写", "其他"] },
      xAxis: { type: "category", data: ["Q1", "Q2", "Q3", "Q4"] },
      yAxis: { type: "value" },
      series: [
        { name: "读", type: "bar", data: [320, 302, 341, 374] },
        { name: "写", type: "bar", data: [120, 132, 101, 134] },
        { name: "其他", type: "bar", data: [60, 72, 71, 64] },
      ],
    },
  ],
  [
    "横向柱状 + 负值",
    {
      tooltip: { trigger: "axis" },
      xAxis: { type: "value" },
      yAxis: { type: "category", data: ["A", "B", "C", "D"] },
      series: [
        {
          type: "bar",
          data: [120, -80, 45, -140],
          label: { show: true, position: "right" },
        },
      ],
    },
  ],
  [
    "饼图",
    {
      tooltip: { trigger: "item" },
      legend: { bottom: 0 },
      series: [
        {
          type: "pie",
          radius: ["40%", "68%"],
          data: [
            { name: "搜索", value: 1048 },
            { name: "直连", value: 735 },
            { name: "邮件", value: 580 },
            { name: "联盟", value: 484 },
            { name: "视频", value: 300 },
          ],
        },
      ],
    },
  ],
  [
    "散点 + visualMap",
    {
      tooltip: { trigger: "item" },
      visualMap: { min: 0, max: 100, dimension: 2, orient: "horizontal", left: "center", bottom: 0 },
      xAxis: { type: "value" },
      yAxis: { type: "value" },
      series: [
        {
          type: "scatter",
          symbolSize: 12,
          data: Array.from({ length: 60 }, (_, index) => [
            (index * 13) % 100,
            (index * 29) % 100,
            (index * 37) % 100,
          ]),
        },
      ],
    },
  ],
  [
    "雷达图",
    {
      tooltip: {},
      legend: { bottom: 0 },
      radar: {
        indicator: [
          { name: "延迟", max: 100 },
          { name: "吞吐", max: 100 },
          { name: "稳定", max: 100 },
          { name: "成本", max: 100 },
          { name: "可维护", max: 100 },
        ],
      },
      series: [
        {
          type: "radar",
          data: [
            { name: "方案 A", value: [80, 65, 90, 45, 70] },
            { name: "方案 B", value: [60, 85, 70, 75, 50] },
          ],
        },
      ],
    },
  ],
  [
    "仪表盘",
    {
      tooltip: { formatter: "{a} <br/>{b}: {c}%" },
      series: [
        {
          type: "gauge",
          name: "健康度",
          progress: { show: true },
          detail: { formatter: "{value}%", fontSize: 18 },
          data: [{ value: 72, name: "健康度" }],
        },
      ],
    },
  ],
  [
    "漏斗图",
    {
      tooltip: { trigger: "item" },
      legend: { bottom: 0 },
      series: [
        {
          type: "funnel",
          left: "10%",
          right: "10%",
          data: [
            { name: "曝光", value: 100 },
            { name: "点击", value: 80 },
            { name: "加购", value: 60 },
            { name: "下单", value: 40 },
            { name: "支付", value: 20 },
          ],
        },
      ],
    },
  ],
  [
    "桑基图",
    {
      tooltip: { trigger: "item" },
      series: [
        {
          type: "sankey",
          data: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }, { name: "e" }],
          links: [
            { source: "a", target: "c", value: 5 },
            { source: "b", target: "c", value: 3 },
            { source: "b", target: "d", value: 8 },
            { source: "c", target: "e", value: 6 },
            { source: "d", target: "e", value: 4 },
          ],
        },
      ],
    },
  ],
  [
    "矩形树图",
    {
      tooltip: { trigger: "item" },
      series: [
        {
          type: "treemap",
          roam: false,
          nodeClick: false,
          breadcrumb: { show: false },
          data: [
            { name: "src", value: 40, children: [{ name: "lib", value: 25 }, { name: "components", value: 15 }] },
            { name: "docs", value: 20 },
            { name: "assets", value: 30 },
            { name: "tests", value: 10 },
          ],
        },
      ],
    },
  ],
  [
    "旭日图",
    {
      tooltip: {},
      series: [
        {
          type: "sunburst",
          radius: ["15%", "90%"],
          data: [
            { name: "前端", children: [{ name: "solid", value: 30 }, { name: "vite", value: 20 }] },
            { name: "后端", children: [{ name: "go", value: 40 }, { name: "node", value: 10 }] },
          ],
        },
      ],
    },
  ],
  [
    "K 线图",
    {
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross", crossStyle: { color: "#999" } },
      },
      xAxis: { type: "category", data: ["1", "2", "3", "4", "5", "6", "7"] },
      yAxis: { type: "value", scale: true },
      series: [
        {
          type: "candlestick",
          data: [
            [20, 34, 10, 38],
            [40, 35, 30, 50],
            [31, 38, 33, 44],
            [38, 15, 5, 42],
            [25, 30, 20, 35],
            [30, 28, 22, 36],
            [28, 40, 26, 44],
          ],
        },
      ],
    },
  ],
  [
    "箱线图",
    {
      tooltip: { trigger: "item" },
      xAxis: { type: "category", data: ["A", "B", "C", "D"] },
      yAxis: { type: "value", splitArea: { show: true } },
      series: [
        {
          type: "boxplot",
          data: [
            [10, 20, 30, 40, 55],
            [5, 18, 28, 35, 60],
            [12, 22, 32, 45, 50],
            [8, 15, 25, 33, 48],
          ],
        },
      ],
    },
  ],
  [
    "热力图",
    {
      tooltip: { position: "top" },
      grid: { height: "60%", top: "12%" },
      xAxis: { type: "category", data: ["12a", "1a", "2a", "3a", "4a", "5a", "6a", "7a", "8a", "9a", "10a", "11a"] },
      yAxis: { type: "category", data: ["Sat", "Fri", "Thu", "Wed", "Tue", "Mon", "Sun"] },
      visualMap: { min: 0, max: 10, calculable: true, orient: "horizontal", left: "center", bottom: "2%" },
      series: [
        {
          type: "heatmap",
          data: Array.from({ length: 84 }, (_, index) => [index % 12, Math.floor(index / 12), (index * 7) % 10]),
          label: { show: false },
        },
      ],
    },
  ],
  [
    "关系图",
    {
      tooltip: {},
      legend: { bottom: 0 },
      series: [
        {
          type: "graph",
          layout: "force",
          roam: true,
          label: { show: true },
          force: { repulsion: 120, edgeLength: 60 },
          data: [
            { name: "agent", symbolSize: 34 },
            { name: "tools", symbolSize: 26 },
            { name: "session", symbolSize: 26 },
            { name: "provider", symbolSize: 22 },
            { name: "mcp", symbolSize: 22 },
          ],
          links: [
            { source: "agent", target: "tools" },
            { source: "agent", target: "session" },
            { source: "agent", target: "provider" },
            { source: "tools", target: "mcp" },
            { source: "session", target: "mcp" },
          ],
        },
      ],
    },
  ],
  [
    "双 Y 轴",
    {
      tooltip: { trigger: "axis" },
      legend: { data: ["请求量", "错误率"] },
      xAxis: { type: "category", data: ["09", "10", "11", "12", "13", "14"] },
      yAxis: [
        { type: "value", name: "请求量" },
        { type: "value", name: "错误率", axisLabel: { formatter: "{value}%" } },
      ],
      series: [
        { name: "请求量", type: "bar", data: [220, 300, 280, 410, 380, 460] },
        { name: "错误率", type: "line", yAxisIndex: 1, smooth: true, data: [1.2, 0.8, 2.4, 1.1, 0.6, 1.9] },
      ],
    },
  ],
  [
    "大数据 + dataZoom",
    {
      tooltip: { trigger: "axis" },
      dataZoom: [{ type: "inside" }, { type: "slider", height: 22, bottom: 4 }],
      xAxis: { type: "value" },
      yAxis: { type: "value" },
      series: [{ type: "line", showSymbol: false, data: seriesData }],
    },
  ],
  [
    "尾随逗号容错",
    '{"xAxis":{"type":"category","data":["a","b","c"],},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[3,8,5]},],}',
  ],
  [
    "语法错误应显示源码",
    "这不是合法 JSON",
  ],
  [
    "缺少 series 应报错",
    { title: { text: "只有标题" }, xAxis: { type: "category", data: ["a"] }, yAxis: { type: "value" } },
  ],
]

/**
 * buildMarkdown
 * 核心流程：每个用例包成一个 echarts 围栏，字符串内容按原样写入，用于验证解析失败的降级
 */
function buildMarkdown(): string {
  return cases
    .map(([title, option]) => {
      const body = typeof option === "string" ? option : JSON.stringify(option, null, 2)
      return `## ${title}\n\n\`\`\`echarts\n${body}\n\`\`\``
    })
    .join("\n\n")
}

const root = document.getElementById("root")!

render(
  () => (
    <div style="padding:24px;max-width:1080px;margin:0 auto">
      <button
        type="button"
        id="theme-toggle"
        onClick={() => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light")}
      >
        Toggle theme
      </button>
      <MarkdownText text={buildMarkdown()} />
    </div>
  ),
  root,
)

/**
 * collectReport
 * 核心流程：读取每个 echarts 块的渲染状态、SVG 节点数与画布尺寸，附带最近的标题便于定位
 */
function collectReport() {
  return [...document.querySelectorAll<HTMLElement>("[data-echarts]")].map((block) => {
    const heading = block.previousElementSibling?.tagName === "H2" ? block.previousElementSibling.textContent : ""
    const diagram = block.querySelector<HTMLElement>(".echarts-diagram")
    return {
      title: heading ?? "",
      state: block.dataset.state ?? "",
      view: block.dataset.view ?? "",
      svg: diagram?.querySelectorAll("svg").length ?? 0,
      svgNodes: diagram?.querySelector("svg")?.childElementCount ?? 0,
      size: diagram ? `${diagram.clientWidth}x${diagram.clientHeight}` : "",
    }
  })
}

window.setInterval(() => {
  const report = collectReport()
  ;(window as unknown as { __echartsReport: unknown }).__echartsReport = report
  const pre = document.getElementById("report")
  if (pre) pre.textContent = JSON.stringify(report, null, 2)
}, 1000)
