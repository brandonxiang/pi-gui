# pi-workspace

`pi-workspace` 是一个基于浏览器的 agent 工作台，构建在
`@earendil-works/pi-coding-agent` SDK 之上。它将 Pi 对话、历史 session 浏览
和实时终端整合到同一个页面中，提供类桌面的工作体验。

## 工作模式

### 对话模式

默认视图。右侧面板显示对话聊天界面，支持流式输出、多轮对话、图片附件
和模型选择。侧边栏列出了本地的 Pi session 历史
（`~/.pi/agent/sessions/`）—— 点击任一 session 即可浏览完整消息历史，
并可在面板中继续对话。

- 基于 Server-Sent Events 的流式响应
- 支持 OpenAI、Anthropic、Google、Mistral、Command Code 等模型的切换
- 可编辑系统提示词
- 图片附件（需视觉模型支持）
- 对话记录自动保存到浏览器本地存储
- Pi session 浏览、创建、续聊

### 终端模式

切换后右侧面板变为一个完整的 Web 终端（xterm.js）。shell 自动在所选
Pi session 的项目目录中启动，`pi` CLI 命令会自动执行——直接定位到该
session。

- xterm.js，使用 VS Code 暗色主题
- 自适应面板尺寸
- 服务端 PTY 基于 `node-pty`，通过 WebSocket 传输
- 选择 Pi session 后自动运行 `pi --session <id>` 进入该 session

在 **Settings → 模式** 中切换「对话模式」和「终端模式」。

## 快速开始

```bash
npm install
npm exec -- pi-workspace
```

如果你已经在本地使用 Pi，服务端会自动读取
`~/.pi/agent/auth.json` 中的认证信息和 `~/.pi/agent/models.json` 中的自定义模型。
同时也会检测 `~/.commandcode/auth.json` 中的 Command Code CLI 登录凭证。

如果存在 Command Code 认证，服务端会从
`https://api.commandcode.ai/provider/v1/models` 拉取可用模型，
注册到 `commandcode` provider 下。

自定义服务端口：

```bash
# 创建 .env 文件（参考 .env.example）并设置 PORT
```

```bash
npm exec -- pi-workspace        # 启动服务
npm exec -- pi-workspace build  # 构建 client + server
npm exec -- pi-workspace --help # 查看所有选项
```

打开 <http://127.0.0.1:8787> 即可使用。

## 开发

```bash
pnpm run dev     # 启动开发服务器（支持热重载）
pnpm run build   # 类型检查 + 构建 client + server
pnpm start       # 构建后启动生产模式
```

## 架构

- `client/` — React (Vite) 前端，使用 Ant Design X 组件
- `server/index.ts` — Fastify 服务端，集成 Pi Coding Agent SDK
- 前端只发送最新的用户输入和 session 元信息
- 后端为每个浏览器 session 维护一个 `AgentSession` 实例，通过 SSE 推送
  `message_update` 增量回浏览器
- `AuthStorage.create()` 和 `ModelRegistry.create()` 使用与 Pi CLI
  相同的本地认证和模型注册机制

默认情况下服务端以 `noTools: "all"` 启动 Pi session，因此在线聊天无法
执行 shell 或文件修改工具。需要在添加认证和权限控制后，再放开工具白名单。

## npm 包

CLI 包同时包含了 API 服务端和前端静态资源：

- `npm publish` 会先运行 `prepack`，构建 `dist/client` 和 `dist-server`
- 发布包只包含 CLI 入口和构建产物
- `pi-workspace` 直接从 `dist-server/index.mjs` 启动生产服务

## 致谢

本项目基于 Earendil Works 的 Pi 生态系统定制：
<https://github.com/earendil-works/pi>。
