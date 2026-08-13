"use strict";
/**
 * DeepSeek Responses API 自定义 AI Provider
 * 通过 Operit 官方 registerAiProvider 插件机制，让 DeepSeek 走 /v1/responses。
 *
 * v0.2.0 更新：
 *  - 网络层改用 Tools.Net.http（沙盒可用），修复 XMLHttpRequest is not defined
 *  - listModels 从 /v1/models 动态获取；默认模型 deepseek-v4-flash / deepseek-v4-pro
 *  - endpoint 自动补全：输入 api.deepseek.com 自动补 /v1/responses；# 结尾禁用补全
 *  - 返回实际请求 URL（实际请求 URL 字段）
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerToolPkg = registerToolPkg;

var DEFAULT_MODEL = "deepseek-v4-flash";
var FALLBACK_MODELS = [
    { id: "deepseek-v4-flash", name: "deepseek-v4-flash" },
    { id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
];

function registerToolPkg() {
    ToolPkg.registerAiProvider({
        id: "deepseek_responses",
        displayName: "DeepSeek (Responses API)",
        description: "通过官方 Responses API 接入 DeepSeek，支持思维过程回传与原生工具调用配对",
        listModels: { function: listModels },
        sendMessage: { function: sendMessage },
        testConnection: { function: testConnection },
        calculateInputTokens: { function: calculateInputTokens },
    });
    return true;
}

// ---------------------------------------------------------------------------
// endpoint 自动补全（对齐官方 EndpointCompleter.completeResponsesEndpoint）
// - https://api.deepseek.com        -> https://api.deepseek.com/v1/responses
// - https://host/custom/v1          -> https://host/custom/v1/responses
// - 以 # 结尾则禁用补全（去掉 # 原样返回）
// ---------------------------------------------------------------------------
function completeEndpoint(endpoint) {
    var trimmed = String(endpoint || "").trim();
    if (!trimmed) return trimmed;
    if (trimmed.endsWith("#")) {
        return trimmed.slice(0, -1).trim();
    }
    var noSlash = trimmed.replace(/\/+$/, "");
    // 提取路径部分（不依赖 URL 全局对象，QuickJS 兼容）
    var path = "";
    var m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/.exec(noSlash);
    if (m) {
        path = m[1] || "";
    } else {
        // 没有协议头，视为裸域名
        path = noSlash.replace(/^[^/?#]*/, "");
    }
    path = path.replace(/\/+$/, "");
    if (!path || path === "") {
        return noSlash + "/v1/responses";
    }
    if (/\/v1$/i.test(path)) {
        return noSlash + "/responses";
    }
    return trimmed;
}

// 从 endpoint 推导模型列表接口 base（取到 /v1 之前，或 /responses 之前）
function modelsListUrl(endpoint) {
    var base = completeEndpoint(endpoint);
    base = base.replace(/\/responses\/?$/i, "");
    base = base.replace(/\/chat\/completions\/?$/i, "");
    if (/\/v1$/i.test(base)) {
        return base + "/models";
    }
    return base + "/v1/models";
}
function buildHeaders(apiKey) {
    var h = { Accept: "application/json", "Content-Type": "application/json" };
    if (apiKey) h.Authorization = "Bearer " + apiKey;
    return h;
}

// 从 event 中提取 payload（兼容 {eventPayload:{...}} 与直接传 payload 两种结构）
function payloadOf(event) {
    if (event && event.eventPayload) return event.eventPayload;
    return event || {};
}


// ---------------------------------------------------------------------------
// listModels：从 /v1/models 动态获取，失败回退静态列表
// ---------------------------------------------------------------------------
async function listModels(event) {
    var p = payloadOf(event);
    var cfg = p.config || {};
    var endpoint = cfg.apiEndpoint || "https://api.deepseek.com";
    var apiKey = cfg.apiKey || "";
    try {
        var resp = await Tools.Net.http({
            url: modelsListUrl(endpoint),
            method: "GET",
            headers: buildHeaders(apiKey),
            connect_timeout: 10,
            read_timeout: 10,
            validateStatus: false,
        });
        var status = Number(resp && resp.statusCode);
        if (status >= 200 && status < 300) {
            var raw = String((resp && resp.content) || "");
            var json = JSON.parse(raw);
            var dataArr = json && json.data;
            if (Array.isArray(dataArr) && dataArr.length > 0) {
                var models = dataArr.map(function (m) {
                    return { id: String(m.id || ""), name: String(m.id || "") };
                }).filter(function (m) { return m.id; });
                if (models.length > 0) {
                    return { models: models };
                }
            }
        }
    } catch (e) { /* 动态获取失败，回退 */ }
    return { models: FALLBACK_MODELS.slice() };
}

// ---------------------------------------------------------------------------
// testConnection：请求 /v1/models 验证连通
// ---------------------------------------------------------------------------
async function testConnection(event) {
    var p = payloadOf(event);
    var cfg = p.config || {};
    var endpoint = cfg.apiEndpoint || "https://api.deepseek.com";
    var apiKey = cfg.apiKey || "";
    try {
        var resp = await Tools.Net.http({
            url: modelsListUrl(endpoint),
            method: "GET",
            headers: buildHeaders(apiKey),
            connect_timeout: 10,
            read_timeout: 10,
            validateStatus: false,
        });
        var status = Number(resp && resp.statusCode);
        if (status >= 200 && status < 300) {
            return { success: true, message: "Connected to DeepSeek Responses API" };
        }
        return { success: false, error: "HTTP " + status + ": " + String((resp && resp.content) || "") };
    } catch (e) {
        return { success: false, error: String((e && e.message) || e) };
    }
}

// ---------------------------------------------------------------------------
// calculateInputTokens（估算，仅供参考）
// ---------------------------------------------------------------------------
async function calculateInputTokens(event) {
    var p = payloadOf(event);
    var hist = p.chatHistory || [];
    var total = 0;
    hist.forEach(function (t) { total += String((t && t.content) || "").length / 3; });
    return { tokens: Math.round(total) };
}

// ---------------------------------------------------------------------------
// httpStreamRequest：流式 HTTP 通道（v1.0.5）+ 硬超时兜底（v1.0.6）
// 官方 DeepseekProvider 用 OkHttp readTimeout=1000s + charStream 逐行流式读取，
// readTimeout 语义是"行间空闲"，SSE 持续推流就不会误杀长思考。
// 插件侧等价实现：toolCall("http_request", params, {onIntermediateResult}) ->
// callToolAsyncStreaming -> http_request.invokeAndStream -> 逐 chunk 返回。
// 最终 resolve 仍是完整响应对象（{statusCode, content, ...}），超时/异常会 reject。
// v1.0.6: 流式 toolCall 在 provider 沙箱（dispatchIntermediateOnMain=false）下可能
// Promise 永不 resolve（静默挂起），Operit 前端表现为"无错误文本的中断"。
// 因此加硬超时兜底：read_timeout + 60s 内未完成则强制 reject 并带 elapsedMs 诊断，
// 确保中断时一定返回可定位的错误文本而不是静默断流。
// 若环境不支持流式 toolCall（无 onIntermediateResult 通道），回退 Tools.Net.http。
// ---------------------------------------------------------------------------
function httpStreamRequest(opts) {
    return new Promise(function (resolve, reject) {
        var done = false;
        var reqStartTs = Date.now();
        function settle(fn, val) {
            if (done) return;
            done = true;
            try { fn(val); } catch (e) { /* ignore */ }
        }
        // 硬超时兜底：超过 read_timeout + 60s 仍未完成 -> 强制 reject（防挂起）
        var hardTimeoutMs = (Number(opts.read_timeout) || 120) * 1000 + 60000;
        var hardTimer = setTimeout(function () {
            if (done) return;
            var err = new Error("httpStreamRequest timed out after " +
                ((Date.now() - reqStartTs) / 1000).toFixed(1) + "s (hard cap " +
                Math.round(hardTimeoutMs / 1000) + "s); channel=" + (opts._channel || "unknown"));
            err._elapsedMs = Date.now() - reqStartTs;
            settle(reject, err);
        }, hardTimeoutMs);
        function finalize() {
            if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
        }
        try {
            if (typeof toolCall === "function") {
                opts._channel = "stream";
                if (opts._onChannel) { try { opts._onChannel("stream"); } catch (e) { /* ignore */ } }
                var params = {
                    url: opts.url,
                    method: opts.method,
                    headers: opts.headers,
                    body: opts.body,
                    connect_timeout: opts.connect_timeout,
                    read_timeout: opts.read_timeout,
                    validateStatus: opts.validateStatus !== false,
                };
                toolCall("http_request", params, {
                    onIntermediateResult: function (evt) {
                        // 流式 chunk 到达即连接活跃，无需累积（最终结果仍完整返回）
                        void evt;
                    },
                }).then(function (finalResp) {
                    finalize();
                    settle(resolve, finalResp);
                }).catch(function (err) {
                    finalize();
                    settle(reject, err);
                });
            } else {
                opts._channel = "fallback";
                if (opts._onChannel) { try { opts._onChannel("fallback"); } catch (e) { /* ignore */ } }
                Tools.Net.http(opts).then(function (r) {
                    finalize();
                    settle(resolve, r);
                }).catch(function (e) {
                    finalize();
                    settle(reject, e);
                });
            }
        } catch (e) {
            finalize();
            settle(reject, e);
        }
    });
}

// ---------------------------------------------------------------------------
// sendMessage：核心（异步，流式 HTTP + SSE 解析）
// ---------------------------------------------------------------------------
async function sendMessage(event) {
    var p = payloadOf(event);
    var cfg = p.config || {};
    var rawEndpoint = cfg.apiEndpoint || "https://api.deepseek.com";
    var apiKey = cfg.apiKey || "";
    var model = cfg.modelName || DEFAULT_MODEL;
    var enableThinking = !!p.enableThinking;
    // 诊断：记录收到的 config 字段是否齐全（正式使用时可移除）
    var hist = p.chatHistory || [];
    var diag = {
        hasConfig: !!(p && p.config),
        hasApiKeyField: cfg.hasOwnProperty("apiKey"),
        apiKeyLen: apiKey ? apiKey.length : 0,
        apiKeyHead: apiKey ? apiKey.slice(0, 6) + "..." : "(empty)",
        endpoint: rawEndpoint,
        model: model,
        histKinds: hist.map(function (t) { return String((t && t.kind) || "").toUpperCase(); }),
        histTail: hist.slice(-4).map(function (t) {
            return {
                kind: String((t && t.kind) || ""),
                toolName: (t && t.toolName) || "",
                content: String((t && t.content) || "").slice(0, 120),
            };
        }),
    };

    var endpoint = completeEndpoint(rawEndpoint);
    var input = buildResponsesInput(p.chatHistory || []);
    diag.inputSummary = input.map(function (it) {
        if (it.type === "function_call") return "C:" + it.call_id + "(" + (it.name || "") + ")";
        if (it.type === "function_call_output") return "O:" + it.call_id;
        if (it.type === "message") return it.role + ":" + String(it.content).slice(0, 30);
        return it.type;
    });
    var body = { model: model, input: input, stream: true };
    var toolUseEnabled = cfg.enableToolCall !== false;
    var availableTools = Array.isArray(p.availableTools) ? p.availableTools : [];
    if (toolUseEnabled && availableTools.length > 0) {
        body.tools = buildResponsesTools(availableTools);
    }
    diag.enableToolCall = cfg.enableToolCall;
    diag.availableToolCount = availableTools.length;
    diag.sentToolCount = body.tools ? body.tools.length : 0;
    if (enableThinking) {
        body.reasoning = { effort: "high" };
    }

    // Tools.Net.http 的 body 虽声明可接收 object，但当前 Operit 桥接在复杂嵌套对象上
    // 可能错误展开/覆盖字段。显式序列化可确保 Responses API 收到完整 JSON 对象。
    var requestBody = JSON.stringify(body);
    diag.inputIsArray = Array.isArray(input);
    diag.bodyLength = requestBody.length;
    diag.serializedInputIsArray = requestBody.indexOf('"input":[') >= 0;

    var fullText = "";
    var reasoningText = "";
    var functionCalls = {};
    var functionCallOrder = [];
    var reqStart = Date.now();
    var reqChannel = "";

    try {
        var resp = await httpStreamRequest({
            url: endpoint,
            method: "POST",
            headers: buildHeaders(apiKey),
            body: requestBody,
            connect_timeout: 30,
            // 2026-08-13 v1.0.5: 对齐官方 AIServiceFactory readTimeout=1000s。
            // 流式通道（callToolAsyncStreaming -> http_request.invokeAndStream）下
            // readTimeout 是"chunk 间空闲"而非"整请求空闲"：DeepSeek thinking 模式
            // 持续推 reasoning delta，连接保持活跃，长会话不再被读超时误杀。
            // v1.0.6: 流式 toolCall 可能挂起（Promise 不 resolve），httpStreamRequest
            // 内部已有硬超时兜底 + channel 标记；此处通过 _onChannel 回调记录实际通道。
            read_timeout: 1000,
            validateStatus: false,
            _onChannel: function (ch) { reqChannel = ch; },
        });
        diag.elapsedMs = Date.now() - reqStart;
        diag.channel = reqChannel;
        var status = Number(resp && resp.statusCode);
        var raw = String((resp && resp.content) || "");
        if (status < 200 || status >= 300) {
            diag.elapsedMs = Date.now() - reqStart;
            return {
                text: "HTTP " + status + ": " + raw + "\n[diag] " + JSON.stringify(diag),
                usage: undefined,
                actualUrl: endpoint,
            };
        }
        // SSE 逐行解析（Tools.Net.http 可能一次返回完整流，按行拆）
        var lines = raw.split("\n");
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.indexOf("data:") !== 0) continue;
            var payload = line.substring(5).trim();
            if (payload === "[DONE]") continue;
            try {
                var evt = JSON.parse(payload);
                handleSseEvent(evt);
            } catch (e) { /* 忽略解析失败 */ }
        }
    } catch (e) {
        diag.elapsedMs = (e && e._elapsedMs) ? e._elapsedMs : (Date.now() - reqStart);
        diag.channel = reqChannel || "unknown";
        return { text: "Provider error: " + String((e && e.message) || e) + "\n[diag] " + JSON.stringify(diag), actualUrl: endpoint };
    }

    function ensureFunctionCall(evt, item) {
        var key = String(evt.output_index !== undefined ? evt.output_index : (item.call_id || item.id || functionCallOrder.length));
        if (!functionCalls[key]) {
            functionCalls[key] = { name: "", arguments: "", snapshotArguments: "" };
            functionCallOrder.push(key);
        }
        var call = functionCalls[key];
        if (item.name) call.name = String(item.name);
        if (item.arguments !== undefined && item.arguments !== null) {
            call.snapshotArguments = extractArgsText(item.arguments);
        }
        return call;
    }

    function handleSseEvent(evt) {
        var type = evt.type || "";
        var delta = evt.delta;
        if (type === "response.output_text.delta" && delta) {
            fullText += delta;
        } else if (type === "response.reasoning_text.delta" && delta) {
            reasoningText += delta;
        } else if (type === "response.reasoning_summary_text.delta" && delta) {
            reasoningText += delta;
        } else if (type === "response.output_item.added" || type === "response.output_item.done") {
            var item = evt.item || {};
            if (item.type === "function_call") ensureFunctionCall(evt, item);
        } else if (type === "response.function_call_arguments.delta") {
            ensureFunctionCall(evt, { name: evt.name || "" }).arguments += String(delta || "");
        } else if (type === "response.function_call_arguments.done") {
            var doneCall = ensureFunctionCall(evt, { name: evt.name || "" });
            if (!doneCall.arguments && evt.arguments !== undefined) {
                doneCall.snapshotArguments = extractArgsText(evt.arguments);
            }
        }
    }

    if (reasoningText) {
        fullText = "<think>" + reasoningText + "</think>\n" + fullText;
    }
    for (var f = 0; f < functionCallOrder.length; f++) {
        var fc = functionCalls[functionCallOrder[f]];
        var argsText = fc.arguments || fc.snapshotArguments || "{}";
        fullText += renderToolCall(fc.name, argsText);
    }
    diag.functionCallCount = functionCallOrder.length;
    diag.reasoningLength = reasoningText.length;

    return { text: fullText, usage: undefined, actualUrl: endpoint };
}

// ---------------------------------------------------------------------------
// 构造 Responses input（含历史 tool_call / tool_result 配对）
// ---------------------------------------------------------------------------
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
        if (pendingReasoning) {
            input.push({
                type: "reasoning",
                content: [{ type: "reasoning_text", text: pendingReasoning }],
            });
            pendingReasoning = "";
        }
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
        // 残留思考若无 function_call 消费，会在下次真实边界 push 时被丢弃。
    }

    for (var i = 0; i < chatHistory.length; i++) {
        var t = chatHistory[i];
        var kind = String((t && t.kind) || "").toUpperCase();
        var content = String((t && t.content) || "");
        if (kind === "SYSTEM") {
            flushCancelled();
            input.push({ type: "message", role: "developer", content: content });
        } else if (kind === "USER" || kind === "SUMMARY") {
            flushCancelled();
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

// 必须导出：registerAiProvider 的 handler 需要是 toolpkg 模块导出函数
exports.listModels = listModels;
exports.sendMessage = sendMessage;
exports.testConnection = testConnection;
exports.calculateInputTokens = calculateInputTokens;