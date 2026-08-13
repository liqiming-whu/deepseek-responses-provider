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

## 2026-08-13 v1.0.5 流式通道实测仍中断 → 修正根因为"流式 toolCall 挂起"（v1.0.5 → v1.0.6）

- 状态：**v1.0.6 已烧录（2026-08-13 18:12）**；待真机验证。
- 现象：v1.0.5（流式 toolCall + read_timeout=1000s）烧录后，超长会话压力测试第 1 轮成功，第 2 轮仍中断；**且中断无错误文本**（对比 v1.0.4 及以前中断带 `Provider error: timeout` 文本）。
- 证据（源码排查）：
  - Operit JS 引擎超时 `JsTimeoutConfig.MAIN_TIMEOUT_SECONDS=1800`（30 分钟）——插件侧无整体超时瓶颈；
  - `ToolPkgJsAiProviderService.sendMessage` 用 `stream{}` 包装，`invokeProviderFunction` 传 `runtimeKind="provider"` + `dispatchIntermediateOnMain=false`；
  - v1.0.5 的 `toolCall("http_request", params, {onIntermediateResult})` 走 `callToolAsyncStreaming` → `invokeAndStream`，在 provider 沙箱（dispatchIntermediateOnMain=false）下 **Promise 可能永不 resolve（静默挂起）**；Operit 前端等待后静默中断，无错误文本返回。
- 修复（v1.0.6）：`httpStreamRequest()` 增加**硬超时兜底**——超过 `read_timeout + 60s` 未完成则强制 reject，错误文本带 `elapsedMs` 与 `channel`（stream/fallback）诊断；`diag.channel` 记录实际走的通道，`diag.elapsedMs` 在成功/HTTP 错误/异常/硬超时四条路径均记录。中断时必然返回可定位文本，不再静默断流。
- 验证：`node --check`、npm test 全通过；归档仅 3 文件（v1.0.6，28689B）；2026-08-13 18:12 烧录成功。Git commit `60b8066` + tag `v1.0.6` 已推送。
- 待办：重启 Operit → 启用插件 → 超长会话压力测试；若再中断，靠 `diag.channel` + `diag.elapsedMs` 判断是 stream 挂起（→ 改回一次性 Tools.Net.http + 大 timeout）还是 fallback 超时（→ 继续加大 timeout）还是前端问题。

## 2026-08-13 v1.0.6 压力测试实测：仅第 1→2 轮之间中断一次，后续 60 轮无中断

- 状态：**已记录（2026-08-13 19:25）**；对照复测已执行（19:36，见下）。
- 实测（超长会话 + 多轮工具调用，v1.0.6）：
  - 第 1 轮成功 → 第 2 轮发起时中断 1 次（无错误文本）；
  - **此后连续 ~60 轮工具调用（terminal/read/grep/query_memory/package 校验等）全部成功，无中断**；
  - 中断仅出现在起始的第 2 轮一次，非持续复发。
- 初步判断：v1.0.6 的硬超时兜底 + 流式通道在长会话下稳定；初始第 1→2 轮中断疑似**冷启动/首请求竞态**（插件实例刚加载、沙箱预热），而非 HTTP 超时或持续挂起。
- 对照设计（用户计划）：关掉插件 → 退出 app → 重新进入 app → 启用插件 → 再测，看第 1→2 轮之间中断是否复现（验证是否为冷启动偶发）。
- **对照结果（2026-08-13 19:36 退出重进后）**：第 1→30 轮工具调用**全部成功，无中断**，包括重启前易中断的第 2 轮也顺利通过 → **冷启动/首请求竞态假设得到支持，本次重启未复现初始中断**（样本 1 次重启，仍有偶发空间，如需更高置信可再重启复测）。期间亦无 HTTP 400。
- 若对照测试第 1→2 轮不再中断 → 判定为冷启动偶发，v1.0.6 可进入长会话回归收尾；若仍复现 → 结合 `diag.channel`+`elapsedMs` 定位首请求竞态。

## 2026-08-13 v1.0.6 长输出触发中断复现（修正冷启动假设，待验证根因）

- 状态：**已记录（2026-08-13 19:40）**；v1.0.6 已烧录、已推送；中断链根因需进一步验证。
- 现象（同一次退出重进后的会话内）：
  - 第一次压测（19:36）：**短输出模式** 第 1→30 轮全部成功无中断（含重启前易中断的第 2 轮）；
  - 第二次测试（19:38）：改为**每轮输出长段文本 + 工具调用交替**，第 1 轮长输出+工具调用成功，第 2 轮在"长文本输出后、下一次工具调用前"**静默中断**；随后用户报告"中断再次发生"，连续两次中断。
- 证据：真实消息 metadata 确认中断消息**无 Provider error 文本、无 diag.channel/elapsedMs**（非插件 HTTP 层超时/400）；中断前消息含**超长 `<think>` 块 + 文字**。对照：短输出 30 轮无中断 vs 长输出第 2 轮中断，变量是**输出/思考长度**。
- 结论修正：**"冷启动/首请求竞态"假设不成立**（若成立，首次 30 轮短输出就该在第 2 轮中断）。中断与**长输出/长 thinking 强相关**。
- 初步根因假设（待验证）：长 thinking + 长输出时，流式 `toolCall(..., {onIntermediateResult})` 在 provider 沙箱（`runtimeKind="provider"`、`dispatchIntermediateOnMain=false`）下转发中间结果占用的桥接调用链更易出现 **Promise 静默挂起**（与 v1.0.6 之前定位的"流式 toolCall 挂起"同源）；插件侧不报错（未到 1060s 硬超时），Operit 前端静默中断。或 Operit 前端对"长 thinking/长输出块"的桥接有隐式大小/时长限制。
- 待办（v1.0.7）：①在 provider 沙箱下对长输出+工具调用交替做最小复现；②检查 Operit `ToolPkgJsAiProviderService.sendMessage` 的 `onIntermediateResult` 转发链在长块下的行为；③若确认为流式 toolCall 挂起，需在沙箱内改用非流式（一次性 `Tools.Net.http` + 大 read_timeout）或分批转发中间结果；④修复 400 链（pendingReasoning 丢弃纯 think）一并评估。
- 证据路径：真机消息 metadata（provider=DeepSeek (Responses API)/deepseek，中断消息无 error/diag）；源码 `/sdcard/Download/Operit/dev_package/deepseek_responses_provider/dist/main.js`；Operit `ToolPkgJsAiProviderService.kt`。

- 状态：**已记录（2026-08-13 19:29）**；用户尚未退出重测；v1.0.3 声称修复后首次明确复现。
- 现象：60 轮无中断压力测试之后，一次工具操作（edit_file old 块不匹配失败）后的一轮请求返回 HTTP 400 `The reasoning_text in the thinking mode must be passed back to the API.`。
- 证据（真机 diag）：`bodyLength=1351580`（135 万字符）、`elapsedMs:4100`（4.1s，非超时，DeepSeek 快速拒绝）、`channel:stream`（流式通道正常建立并返回）；`histKinds` 尾部 ASSISTANT/TOOL_RESULT 交替、无 USER 收尾。
- 初步假设：v1.0.3 的 `pendingReasoning` 对"纯 think、后续无 function_call"的 turn 采用**丢弃**策略，违反 DeepSeek"所有 reasoning_text 必须回传"约束 → `must be passed back` 400。60 轮未触发说明该形状偶发，与具体历史尾部结构相关。
- 待办（v1.0.7）：对照官方 `DeepseekProvider.kt` 的 `queuedAssistantReasoning`+`queuedToolCalls` 缓冲语义，确认纯 think turn 正确处理（保留为 reasoning item 而非丢弃），并在长会话尾部形状下回归。
- 注意：400 与"工具调用前中断"（超时/挂起）是两条独立问题链；本次 400 与 v1.0.6 的流式/超时修复无关。

|- 待办（长期验证）：**用户判定偶发 400 + 中断是否真正修复不能下定论，需长时间使用测试**（60 轮级长会话 + 日常使用）。首轮 5 轮短测试（20:56）：R1/R2/R3/R5 工具调用全部成功、无插件中断、无 400；R4 正文过长触发模型输出预算截断（非插件缺陷）。v1.0.10 为最新已烧录版，修复机制在短测试内未复现问题，长期稳定性待验证。后续长时间使用若复现 400/中断，记录 diag（bodyLength/elapsedMs/channel/histTail/inputSummary）到本文件并继续迭代。

## 2026-08-13 v1.0.9 下 400 复现（channel=stream, bodyLength=466305）——工具调用已执行，400 链重新触发

- 状态：**已记录（2026-08-13 20:44）**；v1.0.9 工具调用回归修复生效（terminal 执行成功），但下一轮请求 400。
- 现象：用户重启后测"5 轮思考+工具调用交替"第 1 轮：插件确认版本（VERSION 1.0.9、toolXml=True）+ terminal 工具**成功执行**；随后插件生成下一条回复时 HTTP 400 `reasoning_text must be passed back`。
- 证据（真机 diag）：`bodyLength=466305`（46.6 万字符）、`elapsedMs=1891`（快速拒绝）、`channel=stream`。histKinds 尾部 `ASSISTANT, USER, ASSISTANT, TOOL_RESULT`；**inputSummary 尾部为 `user(重启消息), C:call_80(package_proxy), O:call_80`——C:call_80 前无 reasoning 项**。
- 初步判断：那条含 package_proxy 工具调用的 ASSISTANT 的 thinking 在 buildResponsesInput 中未作为 reasoning 回传（input 里缺对应 reasoning），违反"所有 reasoning_text 必须回传"→ 400。v1.0.7 flushPendingReasoning 未兜住该形态。
- 待办：读真实历史确认该 ASSISTANT 的实际内容形态（think 与 `<tool>` 的排列）；对照 buildResponsesInput 对该形态的处理；可能是"纯 think ASSISTANT + 后续 TOOL_CALL ASSISTANT"拆分形状在 v1.0.9 工具调用 XML 上报后的新变体。
- 证据路径：用户贴真机 diag；`buildResponsesInput` 源码；真实消息 metadata。

## 2026-08-13 v1.0.9 修复工具调用回归：<tool> XML 流式上报（中断链第二层根因）

- 状态：**已修复并烧录（2026-08-13 20:41 v1.0.9）**；待用户切回插件 provider 重启回归（思考+工具交替）。
- 现象：v1.0.8 下纯 think 5 轮自然结束（流式转发生效），但"思考 + 工具调用交替"第 1 轮工具调用发起时仍静默中断。
- 根因（源码级验证）：
  1. Operit 从 Provider 文本流中解析 `<tool>` 标记识别工具调用（`EnhancedAIService.kt` L1422/1456 `ChatMarkupRegex.toolCallPattern.findAll`，并有 `detectAndRepairTruncatedToolRound` 截断容错）。
  2. v1.0.8 流式转发文本后 Kotlin `hasIntermediateTextChunk=true` → 最终 `return {text}` 被忽略（`ToolPkgJsAiProviderService.kt` L168-172）。
  3. 插件把 SSE 结构化 function_call 渲染成 `<tool>` XML 只在最终 return 的 fullText 里（`renderToolCall`，L459）→ 被忽略后工具指令从 Provider 流消失 → Operit 解析不到 → 工具不执行 → 静默中断。
- 修复（方案 B，最小改动）：`sendMessage` return 前，若存在 function_call 且 `sendIntermediateResult` 可用，把每个 `renderToolCall(name, args)` 渲染的 `<tool>` XML 经 `sendIntermediateResult({chunk})` 上报 → `<tool>` 进入 Provider 文本流 → Operit 可解析执行。
- 验证：`node --check`、npm test A-H、test_sse_forwarder T1-T5 全绿；安装包 VERSION 1.0.9 + 工具 XML 上报×1 + 保留 v1.0.6/1.0.7/1.0.8 全部特征；烧录成功（enabled/imported=true、load_errors={}）。
- 注：官方 provider 下多次"User cancelled/输出截断"为 deepseek-v4-flash 思考型模型输出预算问题（思考+输出共享上限），非插件缺陷；回归测试时注意控制单轮输出长度。
- 待办：切回插件重启 → 5 轮思考+工具交替 → 无中断则中断链关闭 → 400 链 60 轮长会话积累。

## 2026-08-13 v1.0.8 修复中断链：SSE 流式转发对齐官方（根因：一次性 return 单块过大）

- 状态：**已修复并烧录（2026-08-13 20:30 v1.0.8）**；待用户切回插件 provider 重启回归。
- 根因（源码级收敛）：
  1. 官方 `custom_ai_provider` 示例每个 SSE delta 到达即 `sendIntermediateResult({chunk})`；Kotlin 侧 `ToolPkgJsAiProviderService.sendMessage` 收到中间结果后 `hasIntermediateTextChunk=true`，逐块 `emit` 到前端流式渲染，**最终 return 的完整 text 被忽略**。
  2. 本插件 v1.0.7 及之前：`httpStreamRequest` 的 `onIntermediateResult` 仅 `void evt`（丢弃 chunk），SSE 内容在 resolve 后由 `handleSseEvent` 累积，最后 `return { text: fullText }` **一次性**交给 Kotlin。长 thinking 时 fullText（`<think>` + 正文）数万字符作为**单个 chunk** emit → 前端渲染/传输管道静默中断（无 error、无 diag）。
  3. 对照证据：官方 provider 5 轮纯长思考零中断（逐 delta 小块上报）；插件纯 think 第 1 轮后即中断（单块过大）。
- 修复：新增 `makeSseForwarder()`（对齐官方）——`httpStreamRequest.onIntermediateResult` 收到原始 chunk 后实时解析 SSE（buffer 按 `\n\n` 切块），把 `response.output_text.delta` / `response.reasoning_text.delta` / `response.reasoning_summary_text.delta` 经 `sendIntermediateResult({chunk})` 流式转发；单块 >512 字符切分保护；无全局 `sendIntermediateResult`（旧版 Operit）时返回空操作，维持 v1.0.7 一次性 return 行为。
- 保留：最终 `return { text: fullText }` 兜底（Kotlin 忽略但兼容旧版本）；v1.0.6 硬超时 + channel 诊断、v1.0.7 flushPendingReasoning 全部保留。
- 测试：`tests/test_sse_forwarder.js` 新增 T1-T5（delta 顺序转发 / 跨 chunk 累积 / 超长切分 512+512+276 / 非文本过滤 / 旧环境兼容），全部通过；`npm test` A-H 全绿；`node --check` 通过。
- 产物：`deepseek_responses_provider-v1.0.8.toolpkg`（36815B，3 文件，manifest 根目录）；安装包已验证 VERSION 1.0.8 + makeSseForwarder×5 + 保留全部诊断特征。
- 待办：切回插件 provider 重启 → 5 轮纯 think 无调用 → 5 轮长输出+工具调用回归；无中断则关闭中断链，进入 400 链长会话（60 轮级）积累。
- 证据路径：`/root/operit/examples/custom_ai_provider/dist/main.js`（emitChunks/processSsePayload）、`ToolPkgJsAiProviderService.kt`（L137-172 onIntermediateResult→emit、L526 extractMessageChunks）、`StandardHttpTools.kt`（L381-405 chunk 事件结构）、`JsExecutionScriptBuilder.kt`（L38/L559-614 sendIntermediateResult 绑定）。

## 2026-08-13 v1.0.7 官方 provider 对照：5 轮纯长思考无中断 → 中断差异锁定在插件侧（v1.0.8 根因收敛）
|
|- 状态：**已记录（2026-08-13 20:24）**；决定性对照实验完成。
|- 对照结果：**官方 provider 5 轮纯长思考、零工具调用，全程无中断**；同期插件 v1.0.7 纯 think 无调用连续两次中断（第 1 轮后即断）。
|- 结论：**中断不是 Operit 宿主对长输出的普遍限制**（官方 provider 同样场景完全正常），而是**插件 Provider 特有的问题**——差异点锁定在插件侧实现。
|- 修正假设：桥接层普遍限制（排除，官方无中断）→ 插件侧特有转发行为（确认）。
|- v1.0.8 主攻方向（按优先级）：
|  ① 核对 `httpStreamRequest()` 的增量上报粒度：thinking 是否整段单块经 `onIntermediateResult` 上报（官方 Kotlin Provider 中间结果是类型化小粒度块）；
|  ② 检查 JS 侧 `onIntermediateResult` 调用是否在 QuickJS 主循环同步执行重量级操作（大字符串拼接/JSON.stringify）导致事件循环阻塞；
|  ③ thinking 文本字符形态差异（超长无空格 token 串、转义、Unicode）在 JSON 序列化/UI 渲染路径的放大开销；
|  ④ 每个实验独立版本、独立烧录、独立回归，避免多变量叠加；同步补 diag 诊断字段（thinking 累计长度、最后上报块大小、时间戳间隔）。
|- 证据路径：官方 provider 本轮 5 轮无中断（20:24）；插件 v1.0.7 纯 think 连续中断（20:19-20:20，DEV_PLAN 上一条）。
|
## 2026-08-13 v1.0.7 纯 think 无调用连续中断：中断与工具调用、HTTP 层均无关，指向 Operit 前端/桥接层对长输出的静默限制

- 状态：**已记录（2026-08-13 20:20）**；v1.0.7 已烧录、已推送；中断链为独立待办（v1.0.8）。
- 实测（用户要求"测 5 轮只 think 无调用"）：第 1 轮纯思考输出后即中断，用户"继续"后第 2 轮纯思考又中断，连续两次。
- 关键意义：**隔离变量后确认中断与工具调用无关**——此前中断多表现为"长输出 + 工具调用交替"（19:38 v1.0.6、20:16 v1.0.7），但本次纯 think 无任何工具调用也连续中断 → 中断由**纯长输出/长 thinking**触发。
- 结合此前证据（中断均无 error 文本、无 diag.channel/elapsedMs；未到 1060s 硬超时）：**中断不在插件 HTTP 层**（httpStreamRequest 正常），而发生在 **Operit 前端/桥接层对 Provider 长输出（尤其长 thinking）的静默限制**。
- 修正假设链：冷启动竞态（排除）→ 长输出+工具交替（部分排除）→ **纯长输出/长 thinking 即触发，指向桥接层对长中间结果转发的隐性限制**。
- 待办（v1.0.8）：①查 Operit `ToolPkgJsAiProviderService.sendMessage` 的 `onIntermediateResult` 转发链在长块/长 thinking 下的行为；②查前端对 Provider 单条消息长度或 thinking 长度的限制；③若桥接层对长 thinking 有长度/时长限制，考虑插件侧在 thinking 过长时截断/分批转发。
- 证据路径：真机消息 metadata（中断无 error/diag）；源码 `/sdcard/Download/Operit/dev_package/deepseek_responses_provider/dist/main.js`；Operit `ToolPkgJsAiProviderService.kt`。

## 2026-08-13 v1.0.7 下重启后长输出测试：400 链修复生效，中断链仍复现（静默中断）

- 状态：**已记录（2026-08-13 20:16）**；v1.0.7 已烧录、已推送；中断链为独立待办。
- 实测（v1.0.7 重启后，"每轮工具调用 + 长对话"测试）：
  - 第 1→3 轮工具调用全部成功，**无 HTTP 400**（400 链修复生效：`flushPendingReasoning` 在真实边界回传纯 think reasoning）；
  - 第 3 轮后、第 4 轮前（长对话输出时）**静默中断**，用户随即报告"中断再次发生"，连续两次。
- 证据：真实消息 metadata 确认中断消息**无 Provider error 文本、无 diag.channel/elapsedMs**；中断前消息含超长 `<think>` 块 + 文字。
- 结论：**400 链（v1.0.7）与中断链（长输出/长 thinking 静默挂起）是两条独立问题链**。v1.0.7 修复 400 后无 400，但中断链仍复现，与 v1.0.6 的"流式 toolCall 在 provider 沙箱下 Promise 静默挂起"假设一致。
- 待办（v1.0.8）：在 provider 沙箱下对"长输出 + 工具调用交替"做最小复现；检查 `ToolPkgJsAiProviderService.sendMessage` 的 `onIntermediateResult` 转发链在长块下的行为；若确认为流式 toolCall 挂起，改非流式一次性读取 + 大 timeout，或分批转发中间结果。
- 证据路径：真机消息 metadata；源码 `/sdcard/Download/Operit/dev_package/deepseek_responses_provider/dist/main.js`。

## 2026-08-13 v1.0.7 修复 400 链：纯 think 无 function_call 的 reasoning 也回传（对齐官方 queuedAssistantReasoning）

- 状态：**v1.0.7 已烧录（2026-08-13 20:11）**；待重启 Operit + 长会话回归验证 400 是否不再复现。
- 背景：v1.0.3 的 `pendingReasoning` 缓冲只解决"reasoning 与 function_call 配对错位"；对"纯 think、后续无 function_call"的 turn 采用**丢弃**策略（第 457-461 行注释：残留思考若无 function_call 消费则被丢弃），违反 DeepSeek"所有 reasoning_text 必须回传"约束 → v1.0.6 下 400 复现（`bodyLength=1351580, elapsedMs=4100, channel=stream`）。
- 修复（v1.0.7，对齐官方 `DeepseekProvider.kt` 的 `queuedAssistantReasoning` + `queuedToolCalls` 缓冲语义）：
  - 官方语义权威：ASSISTANT turn 有 tool_calls → `queueToolCalls` 缓冲 reasoning+tool_calls，TOOL_RESULT 时 `emitQueuedToolCallsIfNeeded` 合并输出（reasoning 随 function_call 回传）；ASSISTANT 无 tool_calls → **立即**输出 assistant(reasoning_content + content)，reasoning 随后续真实边界输出，**从不丢弃**。
  - 插件新增 `flushPendingReasoning()`：在 SYSTEM/USER/SUMMARY 真实边界与历史末尾，把残留 `pendingReasoning` 输出为 reasoning item（随后续真实边界，绝不丢弃）。
  - 保留 v1.0.3 的 `pushReasoning` + `pushCall` 配对逻辑（有 function_call 时 reasoning 仍紧跟 function_call）。
- 验证：`node --check` 通过；npm test 全通过；`test_reasoning_pair.js` 新增场景 G（纯 think 无 function_call，reasoning 在 USER 边界回传）、H（历史末尾纯 think，兜底回传）均 OK；归档仅 3 文件（v1.0.7，33040B）；2026-08-13 20:11 烧录成功（`enabled=true`、`imported=true`、`related_load_errors={}`）。
- 待办：重启 Operit → 启用插件 → 长会话回归，确认 `reasoning_text must be passed back` 400 不再复现（重点覆盖"纯 think + 工具调用交替"的尾部形状）。
- 注意：中断链（长输出/长 thinking 静默挂起）仍为独立待办，本次未处理；400 链与中断链需分开验证。

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
