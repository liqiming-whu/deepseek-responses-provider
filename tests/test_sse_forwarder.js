"use strict";
// v1.0.8: SSE 流式转发器单元测试（注入 send 桩，不依赖运行时全局）
const assert = require("assert");
const m = require("../dist/main.js");

function makeHarness() {
  const sent = [];
  const fwd = m.makeSseForwarder((obj) => sent.push(obj));
  return { sent, fwd };
}

// T1: thinking delta + text delta 混合转发
{
  const { sent, fwd } = makeHarness();
  const sse = [
    "data: " + JSON.stringify({ type: "response.reasoning_text.delta", delta: "思考中。" }) + "\n\n",
    "data: " + JSON.stringify({ type: "response.output_text.delta", delta: "答案" }) + "\n\n",
    "data: [DONE]\n\n",
  ].join("");
  fwd(sse);
  assert.deepStrictEqual(sent.map((x) => x.chunk), ["<think>", "思考中。", "</think>\n", "答案"], "T1 delta 顺序转发 + think 包裹");
  console.log("[T1 SSE delta 转发] OK");
}

// T2: 跨 chunk 累积（一个 SSE 事件被拆成两段喂入）
{
  const { sent, fwd } = makeHarness();
  const payload = JSON.stringify({ type: "response.output_text.delta", delta: "跨chunk文本" }) + "\n\n";
  const half = Math.floor(payload.length / 2);
  fwd("data: " + payload.slice(0, half));
  fwd(payload.slice(half));
  assert.strictEqual(sent.length, 1, "T2 仅一个事件");
  assert.strictEqual(sent[0].chunk, "跨chunk文本", "T2 跨 chunk 完整解析");
  console.log("[T2 跨chunk累积] OK");
}

// T3: 超长 delta 切分（>512 -> 512/512/...）
{
  const { sent, fwd } = makeHarness();
  const longText = "x".repeat(1300);
  fwd("data: " + JSON.stringify({ type: "response.output_text.delta", delta: longText }) + "\n\n");
  const sizes = sent.map((x) => x.chunk.length);
  assert.deepStrictEqual(sizes, [512, 512, 276], "T3 切分为 512/512/276");
  assert.strictEqual(sent.reduce((a, x) => a + x.chunk.length, 0), 1300, "T3 内容无丢失");
  console.log("[T3 超长切分] OK");
}

// T4: 非文本事件不上报（function_call 等）
{
  const { sent, fwd } = makeHarness();
  fwd("data: " + JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", call_id: "c1" } }) + "\n\n");
  assert.strictEqual(sent.length, 0, "T4 非文本事件跳过");
  console.log("[T4 非文本过滤] OK");
}

// T5: 无 sendFn 时返回空操作（旧环境兼容）
{
  const noop = m.makeSseForwarder();
  assert.strictEqual(typeof noop, "function", "T5 返回空操作函数");
  noop("data: x\n\n"); // 不应抛错
  console.log("[T5 旧环境兼容] OK");
}

console.log("ALL SSE FORWARDER TESTS PASSED");
