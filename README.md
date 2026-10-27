# Codex Demo

两个入口使用同一份 `.env` 模型配置：

```dotenv
MODEL_API_KEY=你的Key
MODEL_BASE_URL=兼容Responses协议的接口地址
MODEL_NAME=你的模型名称
```

需要 Node.js 22+。首次使用先执行 `npm install`。

## SDK 示例

```sh
npm run demo:sdk
```

入口是 `demo.ts`，通过 `new Codex()`、`startThread()`、`thread.run()` 调用。

## App Server 示例

```sh
npm run demo:app-server
```

入口是 `app-server-demo.ts`。它直接启动项目安装的 `codex app-server`，通过标准输入/输出交换逐行 JSON 消息：

```text
本例 Node.js 脚本 ↔ Codex app-server ↔ 你的模型服务
```

依次执行 `initialize` → `initialized` → `thread/start` → `turn/start`。
回答通过 `item/agentMessage/delta` 流式显示，收到 `turn/completed` 并确认成功后再继续第二轮。
默认演示咖啡广告创意和后续分镜，两个问题共用一个会话，app-server 管理聊天上下文。

也可以只发一个自定义问题：

```sh
npm run demo:app-server -- "用一句话解释什么是 Codex harness"
```

不需要安装 Codex 桌面应用，CLI 已作为项目依赖安装。Key 保留在 Node.js 进程中；不会修改全局 Codex 配置。示例使用只读沙箱和禁止审批策略，未实现工具审批交互。

这仍是运行在本机的 Node.js 示例。网页接入时，需要由本机桥接进程或服务端运行它，浏览器不能直接使用 Node.js 的子进程接口。

官方协议文档：https://developers.openai.com/codex/app-server

## 变更记录

- CLI 路径查找改用原生 ESM 的 `import.meta.resolve()`，移除 `createRequire`。

- 为 `app-server-demo.ts` 补充逐步中文注释，解释进程、请求回执、流式通知和会话复用；运行逻辑不变。

- 1.1.1：App Server 示例改用 TypeScript，通过 tsx 运行。
- 1.1.0：新增 app-server 双轮流式对话示例，保留原 SDK 示例。

类型检查：`npm run typecheck`。
