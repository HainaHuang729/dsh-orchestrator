# DSH Orchestrator

面向 Codex 的 DeepSeek Harness（DSH）直接派发技能。Codex 提供最小任务说明并调度，DSH 负责设计、实现与必要轻量自检，完成后直接交付。默认不追加独立 Codex 规划、审阅或浏览器验收。

## 安装与调用

将本仓库克隆到 Codex 的 skills 目录下，目录名为 `dsh-orchestrator`。默认目录为 `~/.codex/skills`；设置了 `CODEX_HOME` 时使用其 `skills` 子目录。已有同名技能时先备份或比较，避免覆盖本地修改。

```powershell
git clone https://github.com/HainaHuang729/dsh-orchestrator.git "$HOME/.codex/skills/dsh-orchestrator"
```

在支持技能的 Codex 会话中显式调用：

```text
使用 $dsh-orchestrator，把这个任务交给 DSH 实现，完成后直接交付。
```

自动调用保持关闭（`allow_implicit_invocation: false`），安装不会自动启用。需要本机已安装并登录的 DSH，以及已配置、可用的 DSH MCP；本仓库不安装 Harness 或 MCP 服务，也不包含认证令牌。

## 执行方式

- 每个独立 Codex 任务使用一个 DSH workspace，同一任务续办复用原组和会话。
- 优先使用已验证的 `deepseek-account/deepseek-flash`，具体以实际工具 schema、可用模型和用户选择为准。
- 长任务由程序静默等待，超时后先查原会话，不重复派发。
- DSH 自检结果属于执行者自报；默认交付未经独立验收。用户明确要求时再追加审阅。

完整规则见 [SKILL.md](SKILL.md)，等待脚本用法见 [references/low-poll.md](references/low-poll.md)，参考来源与已知能力边界见 [references/sources.md](references/sources.md)。其中本机版本与行为记录不保证适用于其他部署。

## 检查

等待脚本使用现代 Node.js 内置模块（需要全局 `fetch` 和 `AbortSignal.timeout`），不需要 npm 依赖。模拟测试不联网、不调用模型：

```text
node --test scripts/wait-dsh.test.mjs
```

默认等待客户端连接本机 `http://127.0.0.1:8790/mcp`，从 `~/.dsh/dsh-as-mcp/token` 读取认证。它仅观察现有会话，不派发、不取消任务，也不提供退出 Codex 后的自动唤醒。
