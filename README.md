# DeepSeek Responses Provider for Operit

通过 Operit 官方 `registerAiProvider` 机制，将 DeepSeek 接入 `/v1/responses` 的自定义 AI Provider。

## 功能

- 使用 DeepSeek Responses API，而非 Chat Completions 兼容层。
- 流式返回正文与 reasoning，并在后续轮次正确回传 reasoning。
- 将 DeepSeek 原生 `function_call` 转换为 Operit 可识别的工具调用 XML。
- 按 FIFO 正确配对并行 `function_call` / `function_call_output`。
- 处理 Operit 历史中的连续 `TOOL_CALL`、聚合 `TOOL_RESULT` 和 assistant 工具 XML，避免 `call_id` 错配、伪结果回显与末项结果丢失。

## 版本

当前稳定版：`v1.0.2`。

已在 Operit Android 真机验证：普通对话、reasoning、多轮串行工具调用，以及连续四轮 4 工具并行调用（每轮 4/4、无伪回显、无 `User cancelled`、无结果缺失）。

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
- ASSISTANT 同 turn 的说明文字 + 工具 XML 回显。

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
tests/                历史转换与配对回归
DEV_PLAN.md           维护记录与已知注意点
```
