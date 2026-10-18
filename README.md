# DeepSeek Responses Provider for Operit

> **重要说明**：DeepSeek Responses API 主要是为了兼容 Codex/Responses 生态而增加的协议入口；它没有提供一套比原生 Chat API 更强的底层推理模型。对于已经正确支持 DeepSeek reasoning_content、流式输出和 tool calls 的客户端，用原生 Chat Completions 就足够。
> 感谢 <https://github.com/luojiaping> 指出。项目现已恢复维护，继续改进 Operit 自定义 Responses Provider 的协议兼容与回归测试。

通过 Operit 官方 `registerAiProvider` 机制，将 DeepSeek 接入 `/v1/responses` 的自定义 AI Provider。

## 功能

- 使用 DeepSeek Responses API，而非 Chat Completions 兼容层。
- 流式返回正文与 reasoning，并在后续轮次正确回传 reasoning。
- 将 DeepSeek 原生 `function_call` 转换为 Operit 可识别的工具调用 XML。
- 按 FIFO 正确配对并行 `function_call` / `function_call_output`。
- 处理 Operit 历史中的连续 `TOOL_CALL`、聚合 `TOOL_RESULT` 和 assistant 工具 XML，避免 `call_id` 错配、伪结果回显与末项结果丢失。

## 版本

当前维护版本：`v1.0.13`（模拟回归通过，Android 真机复测待完成）。

此前的 `v1.0.12` 修复了 thinking 模式下 reasoning 回传的两类 HTTP 400（`reasoning_text must be passed back` 与并行 `function_call` 之间插入 reasoning 导致的 `No tool output found`）。已在 Operit Android 真机验证：普通对话、reasoning、多轮串行工具调用，以及并行工具调用。

`v1.0.13` 统一实时转发与最终响应的事件累积，接收 delta、text.done、完整 output item 和 completed/incomplete 快照，兼容 `reasoning_text` / `reasoning_content`。最终 HTTP 响应重复已有 SSE 时不再重复累计；CRLF 和无空行结尾也能解析。思考继续通过 `<think>` 保存，续写时沿用插件既有的明文 `reasoning_text` 重建方式，不依赖服务端 item ID。

本版验证使用本地模拟 HTTP/SSE，没有调用付费 DeepSeek API；不代表已完成内置 Provider 或本插件新版的 Android 真机验证。

## 安装

1. 从 [Releases](../../releases) 下载 `deepseek_responses_provider-vX.Y.Z.toolpkg`。
2. 在 Operit 中导入 ToolPkg，并确认 `deepseek_responses_provider` 已启用。
3. 完全退出并重启 Operit，使 Provider 重新注册。
4. 新建模型配置，Provider 选择 `DeepSeek (Responses API)`：
   - Endpoint：`https://api.deepseek.com`
   - Model：填写 DeepSeek Responses API 支持的模型名
   - 启用 Tool Call（如需工具调用）
5. 将对话或角色卡绑定到该配置。

注意：Operit 内置 `DEEPSEEK` 与本插件的 `deepseek_responses` 是不同 Provider。测试插件时请确认使用的是 `DeepSeek (Responses API)`。

## 开发与验证

要求：Node.js、Bash、zip/unzip。

```bash
npm test
npm run build
```

测试覆盖：

- 单调用和孤立调用取消兜底；
- 连续 4 个 typed `TOOL_CALL` + 聚合 4 结果；
- typed `TOOL_RESULT` 伪回显；
- ASSISTANT 同 turn 的说明文字 + 工具 XML 回显；
- 直接加载生产代码的流式推理、完成快照、跨块/CRLF、去重和工具续写回归（含模拟实时与缓冲 HTTP 通道）。

构建产物只包含运行所需文件：

```text
dist/main.js
manifest.json
package.json
```

README、开发计划和测试不会进入 ToolPkg。

## 并行调用注意事项

Operit 可并发执行白名单工具，但并行工具之间没有严格时序保证。存在先后依赖的操作（例如先删除再查找）必须拆成多个串行轮次。

## 项目结构

```text
dist/main.js          Provider 运行入口
manifest.json         ToolPkg 元数据
package.json          版本与开发命令
scripts/build.sh      可移植构建脚本
tests/                生产代码的历史转换、流式生命周期与配对回归
DEV_PLAN.md           维护记录与已知注意点
```
