import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"

/**
 * {CRUSH_API_TARGET}
 * crush 后端地址，开发期通过 /v1 前缀代理转发，默认本机 9027 端口
 */
const crushApiTarget = process.env.CRUSH_API_TARGET ?? "http://127.0.0.1:9027"

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    allowedHosts: ['chen-server', 'kfc.test.huya.info'],
    port: 8070,
    proxy: {
      "/v1": {
        target: crushApiTarget,
        changeOrigin: true,
        // SSE 流式响应（events 接口）：http-proxy 默认把响应头缓冲到首个 body 分片才发送，
        // 而 events 建连初期没有数据，浏览器 EventSource 会一直停在 connecting、拿不到 onopen，
        // 进而导致 current-session 上报（要求在 SSE 建立后）永远不触发。
        // 这里改为自行转发：响应头一到就 writeHead + flushHeaders 下发给浏览器。
        selfHandleResponse: true,
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes, _req, res) => {
            if (res.headersSent) return
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
            const contentType = proxyRes.headers["content-type"]
            if (typeof contentType === "string" && contentType.includes("text/event-stream")) {
              res.flushHeaders()
            }
            // 后端中途断开时 pipe 不会替我们调 end：补一次收尾，否则浏览器这条 SSE 会半开挂着
            // 永不结束，每重启一次后端就漏一条，占满同源连接池后所有请求永久排队（表现是永远 loading）
            proxyRes.on("close", () => {
              if (!res.writableEnded) res.end()
            })
            proxyRes.pipe(res)
          })
          proxy.on("error", (_err, _req, res) => {
            // vite 自带的 error handler 在 headersSent 之后直接 return，响应永不结束；
            // 这里只在已开始流式输出时兜底结束，未下发响应头的情况仍交给 vite 回 500
            const out = res as unknown as { headersSent?: boolean; writableEnded?: boolean; end?: () => void }
            if (out?.headersSent && !out.writableEnded) out.end?.()
          })
        },
      },
    },
  },
})
