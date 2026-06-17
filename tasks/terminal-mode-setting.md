# Tasks: 界面模式选择设置

基于 spec [`terminal-mode-setting-spec.md`](./terminal-mode-setting-spec.md) 拆解的任务项。按依赖顺序排列。

---

## Task 1: 服务端 WebSocket 终端端点

**描述:** 在 Fastify HTTP server 上附加 `ws` WebSocket 服务，监听 `/api/terminal?cwd=...`，每个连接 spawn 一个 `node-pty` 进程，双向管道数据。

**Acceptance:**
- 访问 `ws://127.0.0.1:PORT/api/terminal?cwd=/tmp` 可以建立 WebSocket 连接
- 连接建立后 spawn shell 进程（`$SHELL` 或 `zsh`），工作目录为 `cwd`
- 服务端收到文本消息 → 写入 PTY stdin
- PTY stdout 输出 → 发送给客户端
- 客户端发送 `{ type: "resize", cols: number, rows: number }` → PTY resize
- 连接关闭 → kill PTY 进程

**Verify:**
```bash
pnpm run build  # 确保编译通过
# 手动验证可用 node -e 启动一个简单 ws 客户端测试
```

**Files:**
- `server/index.ts` — 在 Fastify 的 HTTP server 上附加 `WebSocketServer`
- `package.json` — 确认依赖已安装（`ws`, `node-pty`, `@types/ws`）

---

## Task 2: TerminalPanel React 组件

**描述:** 创建 `client/TerminalPanel.tsx`，封装 xterm.js 终端。接收 `cwd` prop，建立 WebSocket 连接，处理 resize 和键盘输入。

**Acceptance:**
- 组件挂载时创建 xterm.Terminal + FitAddon，渲染到 `<div ref={terminalRef}>`
- 自动载入 xterm.css 样式
- 建立 WebSocket 连接到 `/api/terminal?cwd=${encodeURIComponent(cwd)}`
- xterm onData → 发送 `data` 文本到 WebSocket
- WebSocket onmessage → xterm write
- xterm onResize (FitAddon) → 发送 `{ type: "resize", cols, rows }` 到 WebSocket
- 组件卸载时关闭 WebSocket、销毁 xterm
- cwd 变化时重建 WebSocket 连接

**Verify:**
```bash
pnpm run build  # 确保类型和编译通过
```

**Files:**
- `ADD client/TerminalPanel.tsx`
- `EDIT client/styles.css` — 终端面板样式（暗色背景、全高）

---

## Task 3: 面板模式状态 + Settings 下拉框

**描述:** 在 App.tsx 中添加 `panelMode` 状态（`"chat"` | `"terminal"`），持久化到 localStorage。Settings 弹窗中添加下拉选择器。根据模式条件渲染对话面板或 TerminalPanel。

**Acceptance:**
- `panelMode` 初始值从 localStorage `my-pi-panel-mode` 读取，默认 `"chat"`
- Settings 弹窗中出现「模式」<select>，选项：对话模式、终端模式
- `panelMode` 切换时持久化到 localStorage
- 选择「终端模式」时右侧主面板渲染 `<TerminalPanel>`，传入正确的 `cwd`
  - 对话模式下：取 `process.cwd()` 或当前 active session 所在目录
  - Pi session 下：取 Pi session 的 `cwd`
- 选择「对话模式」时恢复正常聊天 UI，所有聊天状态保留
- 切换 session 时，如果当前为终端模式，cwd 自动更新

**Verify:**
```bash
pnpm run build  # 确保编译通过
# 启动 pnpm run dev 后手动验证：
# 1. 打开 Settings → 看到「模式」下拉框
# 2. 切换到终端模式 → 右侧出现 xterm 终端
# 3. 可在终端中输入命令
# 4. 切换回对话模式 → 恢复正常聊天
# 5. 刷新页面 → 保持之前的模式选择
```

**Files:**
- `EDIT client/App.tsx` — panelMode 状态、条件渲染、Settings 下拉框

---

## Verification Checklist (All Tasks Done)

- [ ] `pnpm run build` 通过（client + server 无类型/编译错误）
- [ ] `pnpm run dev` 启动成功
- [ ] Settings → 模式下拉框可见
- [ ] 切换到终端模式 → 右侧显示暗色终端
- [ ] 终端可输入 `ls`, `pwd`, `cd` 等命令
- [ ] 窗口 resize 后终端自适应
- [ ] 切回对话模式 → 聊天界面正常
- [ ] Pi session 视图下切换到终端模式 → 终端 cwd 为 Pi session 的项目路径
- [ ] 刷新页面 → 保持之前的模式选择
