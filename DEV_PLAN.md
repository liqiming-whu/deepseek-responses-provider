# DeepSeek Responses Provider — 开发计划

> 记录尚未形成 Bug 的观察项与规划。状态：待验证 / 待处理。版本基线：v1.0.0（打包后）。

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
