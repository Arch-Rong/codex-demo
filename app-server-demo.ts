/**
 * 先看整体：这个文件是一个“控制 Codex 的 Node.js 小程序”。
 *
 * 你输入问题 → 本文件发送消息 → Codex app-server → 配置的远程模型服务
 * 终端显示回答 ← 本文件接收消息 ← Codex app-server ← 模型返回内容
 *
 * app-server 是独立运行的程序，负责管理会话、调用模型和执行 Agent 流程。
 * 本文件负责启动它、按协议发消息、把返回的文字显示出来。
 * 模型并没有安装在这个文件或浏览器里，仍然通过 MODEL_BASE_URL 访问。
 *
 * 建议先读最下面的 try 主流程，再回头看 request、runTurn 和消息接收器。
 * 这些函数看起来比较多，是因为我们直接处理进程通信；SDK 会封装其中不少细节。
 */

// spawn：启动另一个程序；readline：把程序输出按行读取。
// fileURLToPath：把 ESM 解析出的 file:// 地址转换为普通文件路径。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// 第 1 步：读取 npm 启动命令通过 --env-file=.env 加载的配置。
// Key 用于身份验证，URL 指向模型服务，NAME 决定使用哪个模型。
const { MODEL_API_KEY, MODEL_BASE_URL, MODEL_NAME } = process.env;
if (!MODEL_API_KEY || !MODEL_BASE_URL || !MODEL_NAME) {
  throw new Error('请在 .env 配置 MODEL_API_KEY、MODEL_BASE_URL、MODEL_NAME');
}

// 第 2 步：找到 npm 安装的 Codex CLI，避免依赖电脑上全局安装的版本。
// import.meta.resolve 根据当前模块的位置查找依赖，返回 package.json 的 file:// 地址。
const packageUrl = import.meta.resolve('@openai/codex/package.json');
// 以 package.json 为起点找到 bin/codex.js，再转成 spawn 使用的普通文件路径。
const cli = fileURLToPath(new URL('./bin/codex.js', packageUrl));

// 第 3 步：告诉 Codex 如何连接你自己的模型服务。
// demo_gateway 是我们给这份连接配置起的名字，后面通过它选中这个提供方。
const provider = {
  name: 'Demo Gateway',
  base_url: MODEL_BASE_URL,
  // 这里填的是“环境变量名称”，实际 Key 在启动子进程时注入。
  env_key: 'CODEX_API_KEY',
  // 对方必须兼容 Responses 协议，只有普通 Chat Completions 接口还不够。
  wire_api: 'responses',
  // 使用上面的 Key 验证，而不是要求通过 ChatGPT 账号登录。
  requires_openai_auth: false,
};
// stdio:// 表示双方通过进程的输入/输出通信，本例不用开启 HTTP 端口。
// -c 传递本次启动的配置；字符串需要带引号，所以使用 JSON.stringify 编码值。
const args = [cli, 'app-server', '--listen', 'stdio://', '-c', 'model_provider="demo_gateway"'];
for (const [key, value] of Object.entries(provider)) {
  args.push('-c', `model_providers.demo_gateway.${key}=${JSON.stringify(value)}`);
}
// Key 通过环境变量传递，不放进命令行；这些配置不会改写 ~/.codex/config.toml。
// 第 4 步：真正启动 app-server。process.execPath 是当前 Node.js 的路径。
// 相当于运行 node <CLI入口> app-server ...，server 是控制这个子进程的对象。
const server = spawn(process.execPath, args, {
  env: { ...process.env, CODEX_API_KEY: MODEL_API_KEY },
  // 依次是：输入、正常输出、错误输出。
  // pipe 让本程序能写入问题、读取回答；inherit 让诊断日志直接显示在终端。
  stdio: ['pipe', 'pipe', 'inherit'],
});
// 一行就是一条完整的协议消息；不会把一次底层数据传输误当成一条消息。
const lines = createInterface({ input: server.stdout });


// 用户按 Ctrl+C 时也结束子进程，避免关闭示例后 Codex 还继续运行。
const onInterrupt = () => { server.kill('SIGKILL'); process.exitCode = 130; };
process.once('SIGINT', onInterrupt);
// 第 5 步：声明本例用到的数据形状。TypeScript 类型只帮助开发检查，
// 不会在运行时验证 JSON 内容；下面解析消息时的 as 也是类型声明。
// resolve 表示“等待成功结束”，reject 表示“等待以失败结束”。
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};
// 一轮对话从用户发出问题开始，到回答结束为止。
// 本例一次只进行一轮，因此只保留一个 activeTurn。
type ActiveTurn = {
  threadId: string;
  resolve: () => void;
  reject: (error: unknown) => void;
};
// 这里只声明本示例会读取的协议字段。
type RpcMessage = {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { message: string };
  params?: {
    threadId?: string;
    delta?: string;
    turn?: { status: string; error?: { message: string } | null };
  };
};
// pending 像一个“等待回执的登记表”：请求编号 → 收到回执后该通知谁。
// 它等待的是协议回执；activeTurn 等待的是模型整轮回答结束，两者不一样。
const pending = new Map<number | string, PendingRequest>();
let nextId = 1;
let activeTurn: ActiveTurn | undefined;
let closed = false;

// 进程退出、通信出错时，让所有等待都失败，避免 await 一直等下去。
function fail(error: unknown) {
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
  activeTurn?.reject(error);
}
// 第 6 步：发送消息。协议规定每条 JSON 后面加换行，接收方才能分清边界。
// 这个函数只管发送，不等回执，用于 initialized 这类通知。
function send(message: object) {
  server.stdin.write(`${JSON.stringify(message)}\n`);
}
// 第 7 步：发送需要回执的请求，并返回一个可以 await 的 Promise。
// method 是要做的事（如 thread/start），params 是参数，id 是本次请求编号。
// <T> 描述预期返回值的类型，让调用处可以安全地访问 thread.id 等字段。
function request<T = unknown>(method: string, params: object): Promise<T> {
  if (closed) return Promise.reject(new Error('app-server 已退出'));
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    // 30 秒限制的是协议回执，不是整轮模型回答的时长。
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 请求超时`));
    }, 30_000);
    // 先登记再发送，避免回执很快到达时找不到对应的等待者。
    // 成功或失败都要清除计时器，否则已经成功的请求还会留下超时任务。
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value as T); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    send({ id, method, params });
  });
}
// 第 8 步：监听进程和通信异常。启动失败与运行中退出都会结束等待。
server.on('error', error => { closed = true; fail(error); });
server.stdin.on('error', fail);
server.on('exit', (code, signal) => {
  closed = true;
  fail(new Error(`app-server 退出：${signal ?? code}`));
});
// 第 9 步：接收 app-server 发来的消息。主要分为三种：
// ① 它向我们提出的请求；② 对我们请求的回执；③ 主动推送的进度通知。
lines.on('line', line => {
  try {
    const message = JSON.parse(line) as RpcMessage;
    // 这个示例不处理工具审批等交互，明确返回错误，避免服务端一直等待。
    if (message.method && message.id !== undefined) {
      send({ id: message.id, error: { code: -32601, message: 'Demo does not support client requests' } });
      return;
    }
    // 有 id、没有 method 的是回执：用 id 找到第 7 步登记的 Promise。
    // 这里不用 if (message.id)，因为编号 0 也可能是合法编号。
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry?.reject(new Error(message.error.message));
      else entry?.resolve(message.result);
      return;
    }
    // 没有 id 的是通知：不用回复，只处理当前会话的事件。
    const params = message.params;
    if (!activeTurn || params?.threadId !== activeTurn.threadId) return;
    // delta 是新增加的一小段文字，像聊天界面一样边生成边显示。
    // 用 stdout.write 而不是 console.log，避免每一小段文字都另起一行。
    if (message.method === 'item/agentMessage/delta') {
      if (typeof params.delta === 'string') process.stdout.write(params.delta);
    }
    // 收到这条通知才说明一轮结束；结束也可能是失败或中断，需要检查状态。
    if (message.method === 'turn/completed' && params.turn) {
      if (params.turn.status === 'completed') activeTurn.resolve();
      else activeTurn.reject(new Error(params.turn.error?.message ?? `对话状态：${params.turn.status}`));
    }
  } catch (error) {
    fail(error);
  }
});

// 第 10 步：把“提问并等到回答结束”包装成一个函数。
// threadId 是会话编号，text 是本轮问题。相同 threadId 表示继续同一段聊天。
async function runTurn(threadId: string, text: string): Promise<void> {
  console.log(`\n你：${text}\nCodex：`);
  // 先监听完成事件，再发送请求，避免非常快的回答发生在请求返回之前。
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<void>((resolve, reject) => {
    activeTurn = { threadId, resolve, reject };
    timer = setTimeout(() => reject(new Error('本轮回答超过 120 秒')), 120_000);
  });
  try {
    // 两件事都成功才算本轮成功：
    // 1. turn/start 回执：服务端接受了启动请求；
    // 2. done：消息接收器收到 turn/completed，整轮回答成功结束。
    // 所以只 await request('turn/start') 并不能等到完整回答。
    await Promise.all([
      request('turn/start', { threadId, input: [{ type: 'text', text }] }),
      done,
    ]);
    console.log();
  } finally {
    // 不管成功还是失败，都清理本轮状态，下一轮才不会沿用旧的等待者。
    clearTimeout(timer);
    activeTurn = undefined;
  }
}

// 第 11 步：主流程从这里开始。上面的函数和监听器已经准备好了。
try {
  // 先“握手”：介绍我们的应用身份，等服务端确认协议连接可用。
  await request('initialize', {
    clientInfo: { name: 'codex_demo', title: 'Codex App Server Demo', version: '1.1.1' },
  });
  // 告诉服务端：客户端也准备好了。这是通知，没有 id，也不需要等回执。
  send({ method: 'initialized' });
  // 创建聊天会话，拿到 thread.id，后面的每轮问题都带上这个编号。
  // thread 是整段聊天，turn 是聊天中的一次问答。
  const { thread } = await request<{ thread: { id: string } }>('thread/start', {
    model: MODEL_NAME,
    // 设置 Agent 的工作目录；只读沙箱限制写文件，never 表示不申请审批。
    // 这些是执行权限配置，不代表在本机离线运行模型。
    cwd: process.cwd(),
    sandbox: 'read-only',
    approvalPolicy: 'never',
  });
  console.log(`app-server 已连接，会话 ID：${thread.id}`);
  // 命令行带了问题就使用它；没带就演示默认的两轮对话。
  // slice(2) 跳过 Node.js 路径和脚本路径，只取用户输入的参数。
  const prompt = process.argv.slice(2).join(' ');
  await runTurn(thread.id, prompt || '请用中文给我一个15秒咖啡广告创意，简短回答。');
  // 复用同一个 thread.id，Codex 负责衔接上下文，无需我们手动拼上一轮内容。
  if (!prompt) await runTurn(thread.id, '把刚才的创意改成三个镜头的分镜，简短回答。');
} catch (error) {
  // 统一显示主流程的失败原因，退出码 1 让终端知道本次运行失败了。
  console.error(`\n运行失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  // 第 12 步：无论成功还是失败都收尾：停止读消息、关闭输入、结束子进程。
  // 这个 demo 结束后进程就关闭；真实聊天产品通常让进程持续运行以接收新消息。
  lines.close();
  server.stdin.end();
  server.kill();
  // 如果子进程未响应退出信号，避免示例一直挂起。
  const timer = setTimeout(() => server.kill('SIGKILL'), 3000);
  // unref 表示：如果其他工作都结束了，不必只为这个计时器让 Node.js 继续活着。
  timer.unref();
  process.removeListener('SIGINT', onInterrupt);
}
