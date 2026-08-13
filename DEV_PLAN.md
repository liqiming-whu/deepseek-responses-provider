# DeepSeek Responses Provider — 开发计划

> 记录尚未形成 Bug 的观察项与规划。状态：待验证 / 待处理。版本基线：v1.0.2（打包后）。

## 2026-08-13 偶发 HTTP 400：`reasoning_text in the thinking mode must be passed back`（v1.0.2 → v1.0.3 修复）

- 状态：代码修复 + 结构测试通过 + **v1.0.3 已烧录（2026-08-13 17:17）**；**待 Operit 重启 + 真机长会话回归**（>10 轮连续工具调用）。
- 现象：DeepSeek `/v1/responses` 偶发返回 400：
  ```
  The `reasoning_text` in the thinking mode must be passed back to the API.
  ```
  触发集中在**长会话多轮连续工具调用**后（本次触发时已 100+ turn，histKinds 为大量 TOOL_CALL/TOOL_RESULT/ASSISTANT 交替），非短会话首轮。
- 证据（真机 diag，2026-08-13）：`histKinds` 末尾形状 `ASSISTANT(纯 think) → TOOL_RESULT → ASSISTANT(文字+tool) → TOOL_RESULT`；Operit 常把"模型思考"和"工具调用"拆成**相邻但独立的 turn**，顺序可能是 `TOOL_CALL → ASSISTANT(think) → TOOL_RESULT`（think 出现在调用之后、结果之前）。
- 根因：`buildResponsesInput()` 对 thinking 的"即时 push"模型。DeepSeek Responses 要求 **reasoning item 必须紧跟一个 function_call item**（thinking 模式回传约束）。当 think 与 tool call 被拆在不同 turn 时：
  - 旧代码在 ASSISTANT 纯 think 分支立即 `pushReasoning()` → 产出孤立 reasoning（后面不是 function_call，可能是 message 或 function_call_output）；
  - 或 TOOL_CALL 分支只有 tool 时没带前置 thinking → function_call 缺少应回传的 reasoning_text。
  - 两种都会触发上述 400。
- 修复（v1.0.3）：`buildResponsesInput()` 引入 `pendingReasoning` 缓冲——think 先缓存，遇到下一个 `pushCall()` 时随 function_call 一起输出；`flushCancelled()` 不清空缓冲（避免边界把尚未配对的思考丢弃），残留思考若无 function_call 消费则不输出（不产生孤立 reasoning）。
- 自动验证：复用 main.js 提取的 `buildResponsesInput` 独立跑结构测试，覆盖 A 思考+工具同 turn、B 思考/工具分 turn、C 真实尾形状、D 长链多轮、E TOOL_CALL 含 think+tool、F 并行、G 20 轮真实形状——全部 `reasoning 紧跟 function_call`，无孤立 reasoning、无 C 紧跟 O 错序；`node --check` 通过。
- 待办：打包 v1.0.3 → 烧录 → Operit 重启 → 长会话真机回归（重点：长链工具调用 10+ 轮后不再 400）。

## 2026-08-13 长会话"工具调用前中断"= HTTP 读超时（v1.0.3 → v1.0.4 修复）

- 状态：**v1.0.4 已烧录（2026-08-13 17:51）**；待真机验证。
- 现象：v1.0.3 后 400 不再出现（压力测试长会话多轮工具调用均通过），但会话仍在**工具调用发起前**偶发中断。
- 证据（extended_chat 真实消息 metadata，2026-08-13 17:20）：消息尾部为 `Provider error: Error executing HTTP request: timeout`；同一时刻 diag `bodyLength=1014183`（**超 100 万字符**）；`sendMessage()` 的 `read_timeout=120s`。
- 根因：长会话历史超 100 万字符 + thinking（effort high）模式下，DeepSeek 首 token 延迟可能超过 120s（模型仍在思考、尚未输出 function_call），`Tools.Net.http` 读超时抛异常 → Provider 返回 timeout → Operit 表现为"工具调用前中断"。与 reasoning 400 是不同错误族，v1.0.3 未覆盖。
- 修复（v1.0.4）：`read_timeout: 120 → 600`；新增 `reqStart`/`diag.elapsedMs`，三条返回路径（成功 / HTTP 错误 / 异常）都带耗时诊断，便于下次定位。
- 验证：`node --check` 通过；npm test 全通过；打包归档仅 3 文件（v1.0.4，27530B）；2026-08-13 17:51 烧录成功（`enabled=true`、`related_load_errors={}`）。Git：commit `cdd369d` + tag `v1.0.4` 已推送。
- 待办：真机长会话（>10 轮、body>100 万字符）回归；若仍中断，靠 `elapsedMs` 确认是超时还是前端中断，再决定是否继续提高 timeout 或改为流式逐行读取（Tools.Net.http 一次性返回完整流，无增量读取接口时只能靠大 timeout 兜底）。

## 2026-08-13 对照实验确认根因：官方 chat API 健壮 = 1000s 超时 + 流式读取（v1.0.4 → v1.0.5 治本）

- 状态：**v1.0.5 已烧录（2026-08-13 17:57）**；待真机验证。
- 对照实验（用户操作，2026-08-13 17:53）：同一超长会话历史下，从插件自定义 Provider 切到官方内置 DeepSeek Provider 后不再中断 → 证明官方 chat API 实现健壮，中断与模型/会话无关，是插件 HTTP 层实现差异。
- 证据（源码对照，/root/operit）：
  - 官方 `AIServiceFactory.kt:204`：`.readTimeout(1000, TimeUnit.SECONDS)` = **1000s**；`OpenAIProvider.kt:2586` 用 `responseBody.charStream().buffered()` + `readLine()` **逐行流式读取**（readTimeout 语义=行间空闲，SSE 持续推流不超时）。
  - 插件旧实现：`Tools.Net.http` → `JsTools.kt` 里 `toolCall("http_request", params)`（无 onIntermediateResult）→ `StandardHttpTools.httpRequest` → `responseBody.bytes()` **一次性读完整响应** + `read_timeout=120`（整请求空闲）→ DeepSeek 思考 100 万字符时无字节到达即超时。
- 修复（v1.0.5）：新增 `httpStreamRequest()`——走 `toolCall("http_request", params, {onIntermediateResult})` → `callToolAsyncStreaming` → `http_request.invokeAndStream`（`httpRequestStream` 逐 chunk），readTimeout 语义变为 chunk 间空闲；`read_timeout` 提到 **1000s** 对齐官方；`toolCall` 不可用时回退 `Tools.Net.http`。保留 v1.0.4 的 `elapsedMs` 诊断。
- 验证：`node --check`、npm test 全通过；归档仅 3 文件（v1.0.5，29901B）；2026-08-13 17:57 烧录成功（`enabled=true`、`related_load_errors={}`）。Git commit `7fb1518` + tag `v1.0.5` 已推送。
- 待办：重启 Operit → 启用插件 → 超长会话（>100 万字符）多轮工具调用回归；重点确认不再出现"工具调用前中断"。

## 2026-08-13 并行回归观察（v0.6.2 → v1.0.0 基线）

干净会话多轮 4 工具并行回归总体可靠：文件读写、网络、搜索、记忆类工具均可正常发起并返回，无 Provider 丢调用、无 call_id 失配。以下两个注意点单独记录。

### 注意点 1：并行调用间无严格时序保证（竞态）

- 现象：第 5 轮并行中 `delete` 与 `find` 出现竞态。Operit 对并行白名单工具用 async 并发执行、`awaitAll()` 聚合，结果按调用顺序重排，但工具**实际执行是并发的**。
- 风险：当并行批次内工具之间存在隐含依赖（如"先删后查"）时，不保证依赖顺序。
- 影响：属 Operit 执行模型语义，非 Provider 配对错误；调用方不应在单批并行中安排相互依赖的工具。
- 待办：
  - 评估是否在文档/示例中显式说明"并行批次内勿安排存在顺序依赖的工具"；
  - 观察是否需要按工具类型分组串行（仅在确实影响结果时再评估，不修改 Operit 本体）。

### 注意点 2：首个 result 被上一轮文字/XML 占位，导致真实末项结果丢失

- 状态：**v1.0.2 已修复并完成真机回归，关闭**。
- 现象：v1.0.0/v1.0.1 的四工具并行会把“说明文字 + 工具调用 XML”当成首个结果，模型只识别三个真实结果，末项缺失。
- 根因：真实回显位于 ASSISTANT turn。ASSISTANT 含 `<tool...>` 时，旧代码无条件执行 `matchResults(extractToolResultsList(plain))`；在没有结构化 `<tool_result>` 时，纯文本回退把整个 assistant 内容当首个 output，提前消费 FIFO。v1.0.1 只过滤 typed TOOL_RESULT，未覆盖该路径。
- 修复：v1.0.2 的 ASSISTANT merged-format 分支仅在确实存在结构化 `<tool_result>` 时配对结果；typed TOOL_RESULT 回显防护继续保留。
- 自动验证：原配对、typed echo、assistant echo 三组测试均为 calls=4、outputs=4、cancelled=0、fake=0，values=A/B/C/D；语法检查通过。
- 真机验证（用户截图，2026-08-13 13:55）：第一至第三轮及额外第四轮均为 4/4；关键观察明确为“无伪回显”“无 User cancelled”“没有任何工具结果缺失”。Bug 关闭。
