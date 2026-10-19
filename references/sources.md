# 来源映射与能力边界

本文件记录 `SKILL.md` 的规则来源，只说明设计借鉴，不证明 DSH 具备相同能力；实际行为以本机工具 schema 和实测为准。

当前默认已按用户要求改为直接派发、轻量自检、原样交付。下列来源中的规划/审阅/最终验收属于历史设计借鉴或用户另行请求时的可选工作，不构成默认阶段；具体执行以 `SKILL.md` 为准，自动启用仍关闭。

## 逐项映射

1. **xeno-skills / clink-subagents、clink-masteragent**
   借鉴：主代理保留拆分、整合、最终验证与信任边界；工作块自包含、可验收；传路径而非整段聊天；结果精简；会话连续；超时不等于子进程已死。
   不宣称：DSH 具备其运行时隔离、消息机制或原项目配置。
   https://github.com/xenodeve/xeno-skills/blob/main/skills/multi-agent/clink-subagents/SKILL.md
   https://github.com/xenodeve/xeno-skills/blob/main/skills/multi-agent/clink-masteragent/SKILL.md

2. **Superpowers / subagent-driven-development**
   借鉴：按计划分块；每块同时检查需求符合与质量；复杂任务结束做跨块整合审阅；持久化进度并支持压缩后恢复；按能力/风险分配角色；按失败原因修正。
   不宣称：本 skill 强制 TDD、固定角色层级或重复审阅。
   https://github.com/obra/superpowers/tree/main/skills/subagent-driven-development

3. **Heretyc / subagent-mcp**
   借鉴：主代理管理启动、轮询、消息、取消、状态与模型路由；复用已有登录。
   不宣称：DSH 采用其强制管理模式或原生 agent 抑制等侵入式配置；这些配置也不被当作 DSH 能力。
   https://github.com/Heretyc/subagent-mcp

4. **PAL MCP / clink**
   借鉴：跨 CLI 调用的角色划分（默认/规划/审阅）、continuation 交接、文件路径交接；区分带工具执行与纯模型对话。
   不宣称：DSH 等于 PAL，或具备其预置宽松权限参数与工具命名。
   https://github.com/BeehiveInnovations/pal-mcp-server/blob/main/docs/tools/clink.md

5. **agent-rack**
   借鉴：同步短任务与后台长任务区分；状态、日志、跟进输入、取消；续聊与运行中注入是不同能力；结构化审阅报告；后台不阻塞负责人。
   不宣称：其 CLI adapter 自动兼容 DSH。
   https://github.com/lakpriya1s/agent-rack

## DSH 实测边界

任务组使用本机 DSH 原生 workspace。`dsh-as-mcp` 的 `createWorkspace` 先调用 `workspaceRegistry.resolveByPath`，同一真实目录返回已有组且不据新标题另建；`createSession` 使用 `workspaceId` 时由组目录决定 `cwd`，两者不能并传。因此每个独立 Codex 任务分组必须有对应的独立实际目录或 worktree，不能用同目录不同标题或额外 JSON 字段假装独立原生组。组本身不提供进程或权限隔离。

`workspace_create` / `session_create` 用于建立组和会话；当前 MCP `workspace_list` 只回 `sessionCount`，`session_list` 只回 `cwd`，两者不能代替精确成员清单。原生 `workspaceController.follow` 的 baseline / update 记录含 `sessionIds`；workspace domain v2 的持久化工作区记录也含此字段，可在明确本任务 ID 的范围内只读核对。不要为核对改写 DSH 存储或读取无关私人消息。恢复用原 ID；删除后重建同目录是新组，不会自动认领旧会话。原生 session 创建后的挂组若报错，应先保存已产生的 `sessionId`、检查成员关系再处理，不据报错重复创建会话。

本机已实测只读 `~/.dsh/storages/workspace.json`：先确认 `unit.name == "workspace"`、`unit.version == 2`，再按已知组 ID 取 `tables.workspaces[workspaceId].sessionIds`，并检查 `global.workspaceIds` 包含该 ID。此路径和版本属于本机实现，其他部署先核对实际 schema，不把缺文件当作组不存在。

`dsh-as-mcp` 0.1.5 的已知工具包括 `dsh_info`、`session_create`、`session_prompt`、`session_list`、`session_messages`、`session_cancel` 等；`session_prompt` 支持 `wait: false`、`mode: queue`（默认新一轮）和 `mode: steer`（注入运行中 turn）。`session_messages` 仅保证用户/助手文本，不保证完整工具日志。不依赖未核验的原生幂等键、持久队列与 worktree/进程隔离；台账不能替代这些保证，会话取消也不证明子进程或外部请求停止。模型路由 `deepseek-account/deepseek-flash` 已经过真实文件写读验证；本机显式选模型曾改写全局默认和 `reasoningEffort`，当前默认匹配时应省略模型参数。

本地桥接源码 `src/dsh/driver.ts` 的 `promptSession` 在 `wait: false` 时返回 `accepted`；等待期限到时返回 `timedOut: true`，该分支不调用 `cancelSession`。所以等待返回不等于执行取消。历史带审阅的 2026-10-18 配对实测混合组运行 659.815 秒，DSH 完成后才进入 Codex 验收，没有提前停止；该流程不再是当前默认。基准 runner 的 900 秒是实验总时限，不是产品固有限制。主会话中断后自动回收 DSH 结果的机制尚未验证，skill 本身不提供可靠队列或自动唤醒。
