function buildResponsesInput(chatHistory) {
    var input = [];
    var openCallIds = []; // FIFO queue: pending function_call call_ids (align DeepseekProvider.openToolCallIds)
    // reasoning 缓冲：DeepSeek Responses 要求 reasoning item 必须紧跟 function_call
    // （"thinking mode 的 reasoning_text 必须回传"，孤立 reasoning 或无 reasoning 的
    // function_call 都会触发 400）。Operit 常把 think 与 tool call 拆在不同 turn，
    // 因此 thinking 先缓存，遇到下一个 function_call 时随其一起输出；
    // 无后续调用则随真实边界丢弃，避免产生孤立 reasoning item。
    var pendingReasoning = "";
    var seq = 0;

    function pushReasoning(text) {
        if (!text) return;
        pendingReasoning += (pendingReasoning ? "\n" : "") + String(text);
    }
    function pushCall(name, args) {
        // v1.0.12: reasoning 只在"有 think 或新一批调用"时输出一次，之后同一批
        // 并行 function_call 不再重复插入 reasoning（对齐官方 Responses 并行格式
        // reasoning -> call_1 -> call_2 -> output_1 -> output_2）。
        // v1.0.11 无条件每个 call 前都插 reasoning，导致并行时
        // reasoning 打断 call/output 配对 -> DeepSeek 400 "No tool output found"。
        // 无 think 且非并行继续时输出空 reasoning 兜底（避免 reasoning_text 400）。
        var last = input[input.length - 1];
        var prevWasCall = !!(last && last.type === "function_call");
        if (pendingReasoning || !prevWasCall) {
            input.push({
                type: "reasoning",
                content: [{ type: "reasoning_text", text: pendingReasoning || "" }],
            });
        }
        pendingReasoning = "";
        var cid = "call_" + (seq++);
        openCallIds.push(cid);
        input.push({
            type: "function_call",
            name: name,
            arguments: args,
            call_id: cid,
        });
        return cid;
    }
    function matchResults(results) {
        if (!results || results.length === 0 || openCallIds.length === 0) return;
        var validCount = Math.min(results.length, openCallIds.length);
        for (var r = 0; r < validCount; r++) {
            input.push({
                type: "function_call_output",
                call_id: openCallIds[r],
                output: results[r],
            });
        }
        openCallIds.splice(0, validCount);
    }
    function flushCancelled() {
        while (openCallIds.length > 0) {
            input.push({
                type: "function_call_output",
                call_id: openCallIds.shift(),
                output: "User cancelled",
            });
        }
        // 注意：不在此清空 pendingReasoning。Operit 常把"think"与"tool call"拆成
        // 相邻但独立的 turn，且顺序可能是 TOOL_CALL 先于 ASSISTANT(think)；
        // 若边界 flush 清空思考，后续 function_call 将缺少前置 reasoning，
        // 反而触发 DeepSeek "reasoning_text must be passed back" 400。
    }
    // v1.0.7: 真实边界输出残留 reasoning（随后续真实边界，绝不丢弃）。
    // 对齐官方 DeepseekProvider queuedAssistantReasoning 缓冲语义：无 function_call
    // 消费的纯 think 也要回传，否则触发 "reasoning_text must be passed back" 400。
    function flushPendingReasoning() {
        if (pendingReasoning) {
            input.push({
                type: "reasoning",
                content: [{ type: "reasoning_text", text: pendingReasoning }],
            });
            pendingReasoning = "";
        }
    }

    for (var i = 0; i < chatHistory.length; i++) {
        var t = chatHistory[i];
        var kind = String((t && t.kind) || "").toUpperCase();
        var content = String((t && t.content) || "");
        if (kind === "SYSTEM") {
            flushCancelled();
            flushPendingReasoning();
            input.push({ type: "message", role: "developer", content: content });
        } else if (kind === "USER" || kind === "SUMMARY") {
            flushCancelled();
            flushPendingReasoning();
            input.push({ type: "message", role: "user", content: content });
        } else if (kind === "ASSISTANT") {
            var sp = splitThinking(content);
            var plain = sp.plain;
            var toolMarks = extractToolCalls(plain);
            if (toolMarks.length > 0) {
                // align official assistant_tool_call_before_result: flush leftovers before new tool calls
                flushCancelled();
                if (sp.thinking) {
                    pushReasoning(sp.thinking);
                }
                for (var k = 0; k < toolMarks.length; k++) {
                    pushCall(toolMarks[k].name, toolMarks[k].arguments);
                }
                // merged format: same turn may carry structured <tool_result> too.
                // 不能对只有“说明文字 + <tool...> 调用 XML”的 assistant turn 使用
                // extractToolResultsList() 的纯文本回退，否则整段 assistant 内容会被
                // 错当成第一个 output，提前消费 FIFO 并挤掉真正聚合结果的末项。
                if (/<tool_result(?:_[A-Za-z0-9_]+)?\b/i.test(plain)) {
                    matchResults(extractToolResultsList(plain));
                }
            } else {
                flushCancelled();
                if (sp.thinking) {
                    pushReasoning(sp.thinking);
                }
                if (plain.trim()) {
                    input.push({ type: "message", role: "assistant", content: plain });
                }
            }
        } else if (kind === "TOOL_CALL") {
            var tcsp = splitThinking(content);
            var m = extractToolCalls(tcsp.plain);
            if (m.length > 0) {
                // Operit 会把同一批并行调用拆成连续多个 TOOL_CALL turn，随后用一个
                // TOOL_RESULT turn 聚合全部结果。这里必须保留已有 pending calls，
                // 不能在每个 TOOL_CALL 前 flush，否则最终只剩最后一个调用可配对。
                if (tcsp.thinking) {
                    pushReasoning(tcsp.thinking);
                }
                for (var k2 = 0; k2 < m.length; k2++) {
                    pushCall(m[k2].name, m[k2].arguments);
                }
            } else {
                // align official typed_tool_call_without_payload
                flushCancelled();
                var tsp = splitThinking(content);
                if (tsp.thinking) {
                    pushReasoning(tsp.thinking);
                }
                if (tsp.plain.trim()) {
                    input.push({ type: "message", role: "assistant", content: tsp.plain });
                }
            }
        } else if (kind === "TOOL_RESULT") {
            // v1.0.11: Operit 偶尔把"纯 think"或"think+结果"误标成 TOOL_RESULT turn。
            // 先提取 think 缓冲，避免 reasoning 被 extractToolResultsList 的纯文本
            // 回退吞掉，导致后续 function_call 缺少前置 reasoning 触发 400。
            var trsp = splitThinking(content);
            if (trsp.thinking) {
                pushReasoning(trsp.thinking);
            }
            content = trsp.plain;
            var hasStructuredResults = /<tool_result(?:_[A-Za-z0-9_]+)?\b/i.test(content);
            // Operit 偶尔会插入一个 typed TOOL_RESULT turn，但内容实际是上一轮
            // assistant 文本 + <tool...> 调用 XML。它不是执行结果，不能消费 FIFO；
            // 否则真正的聚合结果到来时只剩 N-1 个 call_id，末项会丢失。
            var isAssistantToolEcho = !hasStructuredResults && extractToolCalls(content).length > 0;
            if (isAssistantToolEcho) {
                continue;
            }
            var results = extractToolResultsList(content);
            if (results.length > 0 && openCallIds.length > 0) {
                matchResults(results);
            } else if (results.length > 0) {
                // align official tool_result_without_structured_match: fallback as user message
                flushCancelled();
                input.push({ type: "message", role: "user", content: results.join("\n") });
            } else {
                flushCancelled();
            }

        } else {
            flushCancelled();
            input.push({ type: "message", role: "user", content: content });
        }
    }

    // end of history: leftover orphan function_calls -> User cancelled (align flushOpenToolCallsAsCancelled)
    flushCancelled();
    // v1.0.7: 兜底 —— 残留 pendingReasoning（若有）随后续真实边界输出为 reasoning item，绝不丢弃。
    // 覆盖"TOOL_CALL 先于 ASSISTANT(think)"等跨 turn 顺序导致 think 未被同批 function_call 消费的场景。
    if (pendingReasoning) {
        input.push({
            type: "reasoning",
            content: [{ type: "reasoning_text", text: pendingReasoning }],
        });
        pendingReasoning = "";
    }
    return input;
}

function buildResponsesTools(tools) {
    return tools.map(function (t) {
        var params = null;
        // 1) 优先结构化参数（ToolPrompt.parametersStructured：name/type/description/required/default）
        if (t.parametersStructured && t.parametersStructured.length > 0) {
            var props = {};
            var required = [];
            for (var i = 0; i < t.parametersStructured.length; i++) {
                var s = t.parametersStructured[i];
                var p = { type: s.type || "string" };
                if (s.description) p.description = s.description;
                if (s.default !== undefined && s.default !== null) p["default"] = s.default;
                props[s.name] = p;
                if (s.required) required.push(s.name);
            }
            params = { type: "object", properties: props };
            if (required.length > 0) params.required = required;
        }
        // 2) 其次尝试解析 parameters JSON 字符串（ToolPrompt.parameters 是 String）
        if (!params && typeof t.parameters === "string" && t.parameters.trim()) {
            try {
                params = JSON.parse(t.parameters);
            } catch (e) {
                params = null;
            }
        }
        // 3) fallback
        if (!params) params = { type: "object", properties: {} };
        return {
            type: "function",
            name: t.name,
            description: t.description || "",
            parameters: params,
        };
    });
}

function xmlUnescape(s) {
    var amp = String.fromCharCode(38);
    return String(s)
        .replace(new RegExp(amp + "quot;", "g"), '"')
        .replace(new RegExp(amp + "apos;", "g"), "'")
        .replace(new RegExp(amp + "lt;", "g"), "<")
        .replace(new RegExp(amp + "gt;", "g"), ">")
        .replace(new RegExp(amp + "amp;", "g"), "&");
}

function splitThinking(content) {
    var thinking = "";
    var thinkRe = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/g;
    var tm;
    while ((tm = thinkRe.exec(content)) !== null) {
        var t = (tm[1] || "").trim();
        if (t) thinking += (thinking ? "\n" : "") + t;
    }
    var plain = content.replace(thinkRe, "").trim();
    return { plain: plain, thinking: thinking };
}
function extractArgsText(args) {
    if (typeof args === "string") return args;
    try { return JSON.stringify(args); } catch (e) { return "{}"; }
}
function renderToolCall(name, argsText) {
    var args;
    try { args = JSON.parse(String(argsText || "{}")); } catch (e) { args = {}; }
    var xml = "\n<tool name=\"" + escAttr(name) + "\">";
    var keys = Object.keys(args);
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var value = args[key];
        if (typeof value === "object" && value !== null) {
            try { value = JSON.stringify(value); } catch (e2) { value = String(value); }
        }
        xml += "<param name=\"" + escAttr(key) + "\">" + escText(value === undefined || value === null ? "" : value) + "</param>";
    }
    return xml + "</tool>\n";
}
function extractToolCalls(content) {
    var out = [];
    // align official ChatMarkupRegex.toolCallPattern: <tool> or <tool_随机后缀>, closing tag same name
    var re = /<tool(?:_(?!result(?:_|\b))[A-Za-z0-9_]+)?\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/tool(?:_(?!result(?:_|\b))[A-Za-z0-9_]+)?>/g;
    var mm;
    while ((mm = re.exec(content)) !== null) {
        var body = mm[2] || "";
        // align official parseXmlToolCalls: <param name="x">value</param> -> JSON object (value stays string)
        var args = {};
        var pm = /<param\s+name="([^"]+)">([\s\S]*?)<\/param>/g;
        var p;
        while ((p = pm.exec(body)) !== null) {
            args[p[1]] = xmlUnescape(p[2].trim());
        }
        var argsJson = "{}";
        try { argsJson = JSON.stringify(args); } catch (e) {}
        out.push({ name: mm[1], arguments: argsJson });
    }
    return out;
}
function normalizeToolResultText(text) {
    var value = String(text || "").trim();
    var androidPrefix = "android";
    if (value.indexOf(androidPrefix) === 0) {
        value = value.substring(androidPrefix.length).replace(/^\s*/, "");
    }
    return value;
}
function extractToolResults(content) {
    var m = /<tool_result(?:_[A-Za-z0-9_]+)?\b[^>]*>([\s\S]*?)<\/tool_result(?:_[A-Za-z0-9_]+)?>/.exec(content);
    var full = m ? m[1].trim() : String(content || "").trim();
    var cm = /<content>([\s\S]*?)<\/content>/.exec(full);
    return normalizeToolResultText(cm ? cm[1] : full);
}
function extractToolResultsList(content) {
    var out = [];
    var re = /<tool_result(?:_[A-Za-z0-9_]+)?\b[^>]*>([\s\S]*?)<\/tool_result(?:_[A-Za-z0-9_]+)?>/g;
    var mm;
    while ((mm = re.exec(content)) !== null) {
        var full = mm[1].trim();
        var cm = /<content>([\s\S]*?)<\/content>/.exec(full);
        out.push(normalizeToolResultText(cm ? cm[1] : full));
    }
    if (out.length === 0 && String(content || "").trim()) {
        out.push(String(content).trim());
    }
    return out;
}

function escText(s) {
    var amp = String.fromCharCode(38) + "amp;";
    var lt = String.fromCharCode(38) + "lt;";
    var gt = String.fromCharCode(38) + "gt;";
    return String(s).replace(/&/g, amp).replace(/</g, lt).replace(/>/g, gt);
}
function escAttr(s) {
    var amp = String.fromCharCode(38) + "amp;";
    var quot = String.fromCharCode(38) + "quot;";
    return String(s).replace(/&/g, amp).replace(/"/g, quot);
}


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

