# Crush Fronted

复刻 opencode Web 界面的 Crush 前端（SolidJS），直接对接 crush server 的 HTTP/SSE API。

## 技术栈

- SolidJS + TypeScript
- Vite 6 + vite-plugin-solid
- Tailwind CSS 4（@tailwindcss/vite）
- @solidjs/router
- marked + DOMPurify + highlight.js（Markdown / 代码高亮）
- KaTeX + mermaid（数学公式 / 图表，Mermaid 按需加载）
- diff（Review 面板 unified diff）
- 包管理：npm

## 启动

```bash
npm install
npm run dev          # 默认 http://localhost:8070
```

后端需先启动：

```bash
crush server -H tcp://127.0.0.1:9027
```

## 构建

```bash
npm run build        # 产物输出到 dist/
npm run preview      # 本地预览构建产物
npm run typecheck    # 类型检查
```

## 后端代理配置

开发期 Vite 将 `/v1` 前缀请求代理到 crush 后端，目标地址读取环境变量
`CRUSH_API_TARGET`，未设置时默认 `http://127.0.0.1:9027`：

```bash
CRUSH_API_TARGET=http://127.0.0.1:9027 npm run dev
```

SSE 代理已关闭响应缓冲（`selfHandleResponse` + 立即 flush 响应头），保证
`EventSource.onopen` 及时触发。

## 已实现功能

- 首页：Projects / Sessions 两栏（280 + 720），会话搜索、Today/Yesterday/Earlier 分组，新建/删除项目
- 会话页：消息时间线（Markdown / 代码高亮 / LaTeX 公式 / Thinking 折叠 / 工具调用卡片 / 结果合并）
- 调用链：带 `├─` / `└─` 的段落或代码块自动渲染为可折叠树，也可用 `callchain` / `tree` 代码块强制启用
- LaTeX：支持 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`，KaTeX 在 DOMPurify 之后渲染，语法错误回退源码
- Mermaid：`mermaid` 代码块按需加载渲染 SVG（流式结束后才渲染），支持图表/源码切换与语法错误降级
- 聊天主链路：历史加载、乐观发送、SSE 增量更新、Stop 中断、run_complete 收敛
- 会话压缩：标题栏 Compact 按钮或输入 `/compact`，生成摘要并把历史折叠为可展开的摘要卡片
- 子 agent 卡片：任务标题、运行状态与耗时、实时 Activity 工具树、Markdown 结果、模型与 token 用量；Task/Result 默认只展示前 10 行（带渐隐与 Show more），避免长内容刷屏
- 待办 Dock：输入区上方展示会话 todo 完成进度与列表，可折叠，按 parent 缩进；随 SSE session 事件实时更新
- 用量指示器：Composer 底部显示生成中实时 `tok/s`（1s 窗口平滑估算，完成后回退服务端记账速率）与上下文占窗口百分比（随 session SSE 更新）
- 权限 Dock：Allow once / Allow for session / Deny；YOLO 开关
- Question Dock：single/multi/yes_no/free_text 四种题型
- Composer：模型选择器（显示供应商 + 完整模型名；catwalk 目录 + workspace 自定义 provider）、`@` 文件/文件夹引用（↑↓ 选择、Enter/Tab 添加、→ 进入目录、← 返回）、附件 chips
- 右侧面板：Q&A 问答索引（点击跳转到对应问句并高亮）、Files 文件树、Review（filetracker + history diff）、Terminal（shell 接口）
- 标题栏：多会话标签页（切换/关闭，关闭后自动跳到相邻标签）、新建会话、主题切换、状态浮层（Server / MCP / LSP / Skills）
- 设置弹窗：主题、工作区信息、YOLO、模型、Skills
- 断线恢复：workspace id 失效时按持久化路径自动重建（服务端重启后仍能回到原项目）

## 目录结构

```
index.html                     入口 HTML（默认 dark 主题）
src/
  main.tsx                     应用入口
  routes.tsx                   路由：/、/w/:workspaceId、/w/:workspaceId/session/:sessionId
  app.tsx                      布局：Titlebar + 主内容区
  index.css                    Tailwind 入口 + 主题变量 + Markdown 样式
  lib/                         接口层：http / workspaces / sessions / agent / events /
                               permissions / questions / models / files / review /
                               diagnostics / ui-store / workspace-store / mermaid / usage /
                               subagents（子会话 ID、prompt/title/metadata 解析与懒加载）
  components/
    titlebar.tsx               顶栏：标签页、主题、连接状态
    status-popover.tsx         MCP / LSP / Skills 状态浮层
    settings-dialog.tsx        设置弹窗
    model-select.tsx           模型选择器
    usage-meter.tsx            用量指示器（token 速率 + 上下文占比）
    file-mention.tsx           @ 文件引用浮层
    permission-dock.tsx        权限确认 Dock
    todo-dock.tsx              会话待办 Dock（进度 + 可折叠列表）
    question-dock.tsx          Question 表单
    session-panel.tsx          右侧面板（Q&A / Files / Review / Terminal）
    panel-questions.tsx        问答索引与跳转入口
    message/parts.tsx          消息分片渲染
    message/markdown.tsx       Markdown + 高亮
    message/tool-visuals.tsx   工具图标 / 摘要 / JSON 格式化
    message/subagent-card.tsx  子 agent 卡片（Task / Activity / Result，10 行预览）
    message/subagent-context.tsx 子会话缓存 Context
  pages/home.tsx               首页
  pages/session.tsx            会话页
```

## 主题

CSS 变量语义命名参考 opencode 的 `--v2-*`：`--bg-base`、`--bg-deep`、
`--text-base`、`--text-muted`、`--border-base`、`--accent`。
通过 `<html data-theme="light" | "dark">` 切换，默认 dark，选择持久化到 localStorage。
