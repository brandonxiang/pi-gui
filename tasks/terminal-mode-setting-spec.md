# Spec: 界面模式选择 — 对话 / 终端

## Objective

在 **Settings** 弹窗中添加一个下拉选择器，让用户在两种界面模式间切换：

1. **对话模式（Chat）** — 当前行为，主界面右侧显示 agent 对话面板
2. **终端模式（Terminal）** — 主界面右侧替换为一个完整的 web terminal（xterm.js），并自动在对应 session 的 `cwd` 目录下打开终端

> 默认值为「对话模式」。切换模式不影响会话历史、侧边栏结构或 Pi Sessions 列表。

## 技术方案概览

```
┌─────────────────┐     ┌──────────────┐     ┌──────────┐
│  Settings 下拉框   │────▶ App.tsx      │────▶ 条件渲染   │
│  对话 / 终端      │     │ panelMode 状态 │     │ TerminalPanel│
└─────────────────┘     └──────────────┘     └─────┬────┘
                                                   │ WS connect
                                                   ▼
                                            ┌──────────────┐
                                            │ server/index.ts│
                                            │ WebSocket /api/│
                                            │ terminal?cwd=  │
                                            │ + node-pty    │
                                            └──────────────┘
```

## Commands

```bash
Build:     pnpm run build
Dev:       pnpm run dev
Test:      pnpm run test
```

## Tech Stack

| 层级 | 技术 | 版本 |
|------|------|------|
| 浏览器终端 | `@xterm/xterm` | 6.0.0 |
| 自动适配容器 | `@xterm/addon-fit` | 0.11.0 |
| WebSocket 客户端 | 浏览器原生 `WebSocket` | — |
| WebSocket 服务端 | `ws` | 8.21.0 |
| 伪终端 | `node-pty` | 1.1.0 |
| 框架 (已有) | React + Fastify + Vite | — |

## Files / 文件变更

```
ADD  client/TerminalPanel.tsx   — xterm.js React 组件
EDIT client/App.tsx             — panelMode 状态 + 条件渲染 + Settings 下拉框
EDIT server/index.ts            — WebSocket 终端端点
EDIT client/styles.css          — 终端面板样式
EDIT package.json               — 已安装依赖（无需再改）
```

## Code Style

```tsx
// TerminalPanel.tsx — xterm.js 封装组件
// - useRef 管理 Terminal 实例和 div 容器
// - useEffect 负责初始化 xterm、创建 WebSocket、绑定 resize 和 data 事件
// - 组件卸载时 cleanup terminal + WebSocket
// - 不依赖任何外部 UI 组件库

// 关键模式：
// 1. xterm 只初始化一次，通过 ref 持有实例
// 2. WebSocket 连接依赖 cwd，cwd 变化时重新连接
// 3. fit addon 在 mount 后和 resize 时自动调用
// 4. 暗色背景，终端信息通过 props 可配
```

## Testing Strategy

- 终端模式涉及 `node-pty`（本地进程）和 `WebSocket`，适合手动验证
- 可以编写 `server/index.test.ts` 验证 WebSocket 终端端点能正常接收连接和返回数据（使用 `ws` 测试客户端 + `node-pty` mock）
- UI 侧通过 `pnpm run dev` 手动测试模式切换和终端输入输出

## Boundaries

- **Always:**
  - 面板模式选择持久化到 localStorage (`my-pi-panel-mode`)
  - 切换模式时保持当前会话和 Pi session 状态不变
  - 终端关闭/切换模式时 kill 对应的 PTY 进程
  - WebSocket 连接断开时清理所有资源

- **Ask first:**
  - 修改 PTY 的 shell 类型（默认 `$SHELL` 或 `zsh`）
  - 添加终端主题/字号设置
  - 支持同时打开多个终端

- **Never:**
  - 不要在客户端暴露 `node-pty` 或 `spawn` 逻辑
  - 不要覆盖用户的 `SHELL` 环境变量
  - 不要暴露任何 API 密钥到终端环境变量

## Success Criteria

1. [ ] Settings 弹窗中出现「模式」下拉框，选项为「对话模式」「终端模式」
2. [ ] 选择「终端模式」后右侧面板显示一个全屏的 xterm.js 终端
3. [ ] 终端自动在 Pi session 的 `cwd` 目录下启动（对话模式时为当前工作目录）
4. [ ] 终端支持键盘输入和标准输出（ls, cd, pwd 等正常运行）
5. [ ] 终端窗口大小自适应（resize 时 fit）
6. [ ] 切回「对话模式」后恢复正常聊天界面，状态不丢失
7. [ ] 模式选择刷新页面后保持（localStorage 持久化）
8. [ ] 切换到新会话时终端 cwd 同步更新

## Open Questions

- 对话模式下切换 session 时，如果终端模式打开，cwd 应该跟随哪个 session？（当前方案：只在终端模式激活时取当前 active session 的 cwd，如果是 Pi session 则取 Pi session 的 cwd）
- 终端关闭后是否需要保留 PTY 进程？（当前方案：退出终端模式/重连/切换 session 时 kill PTY）
- 是否需要显示终端顶部信息栏（当前目录等）？（当前方案：xterm 本身已有 shell prompt，不再额外添加）

## Appendix: 详细实现说明

### TerminalPanel.tsx 组件设计

```tsx
interface TerminalPanelProps {
  cwd: string;          // PTY 启动的工作目录
  sessionId?: string;   // 对应 session ID（用于日志或后续功能）
}
```

**生命周期:**
1. mount → 创建 xterm.Terminal + FitAddon → 打开到 div 容器 → 建立 WebSocket
2. cwd 变化 → 关闭旧 WebSocket → kill 旧 PTY → 建立新连接
3. unmount → 关闭 WebSocket → kill PTY → 销毁 xterm 实例

### WebSocket 协议

- 客户端 → 服务端: `{ type: "input", data: string }` 或 `{ type: "resize", cols: number, rows: number }`
- 服务端 → 客户端: 纯文本（PTY stdout 输出）

### 服务端端点

Fastify 启动后，额外创建 `WebSocketServer`（绑定到同一 HTTP server）：

```
ws://127.0.0.1:8787/api/terminal?cwd=/path/to/project
```

- 查询参数 `cwd` 指定 PTY 的工作目录
- 连接建立后 spawn `node-pty.spawn(process.env.SHELL || "zsh", [], { cwd, name: "xterm-256color" })`
- 接收客户端消息 → 写入 PTY
- 监听 PTY data 事件 → 发送给客户端
- 连接关闭 → kill PTY 进程
