import { Codex } from "@openai/codex-sdk";

async function main() {
  const apiKey = process.env.MODEL_API_KEY;
  const baseUrl = process.env.MODEL_BASE_URL;
  const model = process.env.MODEL_NAME;

  if (!apiKey || !baseUrl || !model) {
    throw new Error("请配置模型 Key、URL 和名称");
  }

  // 只覆盖这一次运行的提供方，不改 ~/.codex/config.toml。
  // 本机默认提供方要求 ChatGPT 登录，不接受 API Key。
  const codex = new Codex({
    apiKey,
    baseUrl,
    config: {
      model_provider: "demo_gateway",
      model_providers: {
        demo_gateway: {
          name: "Token Gateway",
          base_url: baseUrl,
          env_key: "CODEX_API_KEY",
          wire_api: "responses",
          requires_openai_auth: false,
        },
        
      },
    },
  });

  // 创建一个对话，由 harness 管理上下文和执行过程。
  const thread = codex.startThread({
    model,
    workingDirectory: process.cwd(),
    skipGitRepoCheck: true,
    sandboxMode: "read-only",
    approvalPolicy: "never",
  });

  const first = await thread.run(
    "请用中文给我一个15秒咖啡广告创意，简短回答。"
  );
  console.log("第一轮：", first.finalResponse);

  // 继续使用同一个 thread，无需自己拼接上一轮聊天记录。
  const second = await thread.run(
    "把刚才的创意改成三个镜头的分镜。"
  );
  console.log("第二轮：", second.finalResponse);

  console.log("会话 ID：", thread.id);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});