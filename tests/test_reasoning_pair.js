"use strict";
const { buildResponsesInput } = require("./load_provider")();

// ---------- 测试 ----------
function summarize(input) {
  return input.map(function (it) {
    if (it.type === "function_call") return "C:" + it.call_id;
    if (it.type === "function_call_output") return "O:" + it.call_id;
    if (it.type === "reasoning") return "R";
    return it.type + ":" + it.role;
  });
}
function check(input, name) {
  var violations = [];
  for (var i = 0; i < input.length; i++) {
    var it = input[i];
    if (it.type === "reasoning") {
      // v1.0.7: reasoning 既可紧跟 function_call（配对场景），也可随后续真实边界
      // （USER/message/EOF，纯 think 无 function_call 回传场景）。两种都合法。
      // 仅拒绝错配：reasoning 后面跟 function_call_output 或另一个 reasoning。
      var nxt = input[i + 1];
      if (nxt && (nxt.type === "function_call_output" || nxt.type === "reasoning")) {
        violations.push("R@" + i + " followed by " + nxt.type + " (misorder)");
      }
    }
    if (it.type === "function_call") {
      // 前一个不应是孤立的 reasoning 缺失：function_call 前应紧邻 reasoning（若有思考）
      // 这里只检查结构：function_call 前不允许是 function_call_output（错配）
      var prev = input[i - 1];
      if (prev && prev.type === "function_call_output") violations.push("C@" + i + " after O (misorder)");
    }
  }
  console.log("[" + name + "] " + summarize(input).join(" "));
  if (violations.length) console.log("  VIOLATIONS: " + violations.join("; "));
  else console.log("  OK");
}

var A = [
  { kind: "SYSTEM", content: "sys" },
  { kind: "USER", content: "hi" },
  { kind: "ASSISTANT", content: "<think>我要查文件</think>\n<tool name=\"find_files\"><param name=\"path\">/tmp</param></tool>" },
  { kind: "TOOL_RESULT", content: "<tool_result name=\"find_files\" status=\"success\"><content>[a,b]</content></tool_result>" },
  { kind: "USER", content: "继续" },
];
check(buildResponsesInput(A), "A 思考+工具同turn");

var B = [
  { kind: "SYSTEM", content: "sys" },
  { kind: "USER", content: "hi" },
  { kind: "ASSISTANT", content: "<think>我要查文件</think>" },
  { kind: "TOOL_CALL", content: "<tool name=\"find_files\"><param name=\"path\">/tmp</param></tool>" },
  { kind: "TOOL_RESULT", content: "<tool_result name=\"find_files\" status=\"success\"><content>[a,b]</content></tool_result>" },
  { kind: "USER", content: "继续" },
];
check(buildResponsesInput(B), "B 思考turn+工具turn");

var C = [
  { kind: "SYSTEM", content: "sys" },
  { kind: "USER", content: "打开面板" },
  { kind: "TOOL_CALL", content: "<tool name=\"super_admin:shell\"><param name=\"command\">cd x && ls</param></tool>" },
  { kind: "ASSISTANT", content: "<think>我先检查一下目录</think>" },
  { kind: "TOOL_RESULT", content: "<tool_result name=\"super_admin:shell\" status=\"success\"><content>{ok:true}</content></tool_result>" },
  { kind: "ASSISTANT", content: "继续执行\n<tool name=\"package_proxy\"><param name=\"tool_name\">super_admin:shell</param></tool>" },
  { kind: "TOOL_RESULT", content: "<tool_result name=\"package_proxy\" status=\"success\"><content>{ok:true}</content></tool_result>" },
];
check(buildResponsesInput(C), "C 真实尾形状");

var D = [{ kind: "SYSTEM", content: "sys" }];
for (var n = 0; n < 5; n++) {
  D.push({ kind: "USER", content: "round " + n });
  D.push({ kind: "TOOL_CALL", content: "<tool name=\"t" + n + "\"><param name=\"x\">" + n + "</param></tool>" });
  D.push({ kind: "ASSISTANT", content: "<think>思考 " + n + "</think>" });
  D.push({ kind: "TOOL_RESULT", content: "<tool_result name=\"t" + n + "\" status=\"success\"><content>r" + n + "</content></tool_result>" });
}
D.push({ kind: "USER", content: "done" });
check(buildResponsesInput(D), "D 长链");

var E = [
  { kind: "SYSTEM", content: "sys" },
  { kind: "USER", content: "hi" },
  { kind: "TOOL_CALL", content: "<think>我要查文件</think>\n<tool name=\"find_files\"><param name=\"path\">/tmp</param></tool>" },
  { kind: "TOOL_RESULT", content: "<tool_result name=\"find_files\" status=\"success\"><content>[a]</content></tool_result>" },
  { kind: "USER", content: "继续" },
];
check(buildResponsesInput(E), "E TOOL_CALL含think+tool");

// 场景 F：多轮混合 + 思考与工具分离 + 并行
var F = [
  { kind: "SYSTEM", content: "sys" },
  { kind: "USER", content: "搜索并读取" },
  { kind: "TOOL_CALL", content: "<tool name=\"t1\"><param name=\"a\">1</param></tool>" },
  { kind: "TOOL_CALL", content: "<tool name=\"t2\"><param name=\"a\">2</param></tool>" },
  { kind: "ASSISTANT", content: "<think>先搜索再读取</think>" },
  { kind: "TOOL_RESULT", content: "<tool_result name=\"t1\" status=\"success\"><content>r1</content></tool_result><tool_result name=\"t2\" status=\"success\"><content>r2</content></tool_result>" },
  { kind: "USER", content: "继续" },
];
check(buildResponsesInput(F), "F 并行+思考");

// 场景 G：纯 think 无 function_call —— reasoning 随后续真实边界回传（v1.0.7）
var G = [
  { kind: "SYSTEM", content: "sys" },
  { kind: "USER", content: "hi" },
  { kind: "ASSISTANT", content: "<think>纯思考无工具调用</think>" },
  { kind: "USER", content: "继续" },
];
check(buildResponsesInput(G), "G 纯think无function_call");

// 场景 H：纯 think 在历史末尾（无后续 USER）—— 残留 reasoning 兜底回传（v1.0.7）
var H = [
  { kind: "SYSTEM", content: "sys" },
  { kind: "USER", content: "hi" },
  { kind: "ASSISTANT", content: "<think>末尾纯思考</think>" },
];
check(buildResponsesInput(H), "H 末尾纯think");// 场景 I：连续纯 tool turn（无 think）—— 每个 function_call 前都必须有 reasoning 兜底（v1.0.11）
// 本次 400 的真机形状：ASSISTANT 纯 tool → TOOL_RESULT → ASSISTANT 纯 tool → TOOL_RESULT，
// 第二个 function_call 前无 think，旧代码会产出无前置 reasoning 的 function_call。
var I = [
  { kind: "SYSTEM", content: "sys" },
  { kind: "USER", content: "测5轮" },
  { kind: "ASSISTANT", content: "第 3 轮：\n<tool name=\"time:get_time\"><param name=\"params\">{}</param></tool>" },
  { kind: "TOOL_RESULT", content: "<tool_result name=\"time:get_time\" status=\"success\"><content>{ok:true}</tool_result>" },
  { kind: "ASSISTANT", content: "\n<tool name=\"time:get_time\"><param name=\"params\">{}</param></tool>\n" },
  { kind: "TOOL_RESULT", content: "<tool_result name=\"time:get_time\" status=\"success\"><content>{ok:true}</tool_result>" },
];
check(buildResponsesInput(I), "I 连续纯tool无think兜底");
// 场景 J：同一 ASSISTANT 并行两 tool（无 think）—— 只输出一个前置 reasoning，中间不插（v1.0.12）
var J = [
  { kind: "SYSTEM", content: "sys" },
  { kind: "USER", content: "并行" },
  { kind: "ASSISTANT", content: "\n<tool name=\"a\"><param name=\"x\">1</param></tool>\n<tool name=\"b\"><param name=\"x\">2</param></tool>" },
  { kind: "TOOL_RESULT", content: "<tool_result name=\"a\"><content>A</content></tool_result><tool_result name=\"b\"><content>B</content></tool_result>" },
];
check(buildResponsesInput(J), "J 并行tool无think不插reasoning");

