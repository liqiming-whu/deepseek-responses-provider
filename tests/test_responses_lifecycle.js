"use strict";
const assert = require("assert");
const loadProvider = require("./load_provider");
const line = event => "data: " + JSON.stringify(event) + "\r\n\r\n";
const item = (text, type = "reasoning_text", id = "rs_1") => ({type: "reasoning", ...(id ? {id} : {}), content: text === null ? [] : [{type, text}]});
const indexed = (type, rest = {}) => ({type, output_index: 0, content_index: 0, item_id: "rs_1", ...rest});
const toolEvents = [
    {type: "response.output_item.added", output_index: 1, item: {type: "function_call", id: "fc_1", call_id: "c1", name: "inspect"}},
    {type: "response.function_call_arguments.delta", output_index: 1, delta: '{"path":"/workspace"}'},
    {type: "response.function_call_arguments.done", output_index: 1, arguments: '{"path":"/workspace"}'},
];
async function invoke(events, {live = true, rawEvents = events, chunkSize = 17, noTerminator = false, unterminated = false, intermediate = true, rawBody} = {}) {
    const sent = [], requests = [];
    let raw = rawBody === undefined ? rawEvents.map(line).join("") + (noTerminator ? "" : "data: [DONE]\r\n\r\n") : rawBody;
    if (unterminated) raw = raw.replace(/\r\n\r\n$/, "");
    const m = loadProvider({
        ...(intermediate ? {sendIntermediateResult: obj => sent.push(obj.chunk)} : {}),
        toolCall: async (name, request, options) => {
            assert.strictEqual(name, "http_request"); requests.push(JSON.parse(request.body));
            if (live) {
                const streamed = events.map(line).join("");
                for (let i = 0; i < streamed.length; i += chunkSize) options.onIntermediateResult({chunk: streamed.slice(i, i + chunkSize)});
            }
            return {statusCode: 200, content: raw};
        },
    });
    const result = await m.sendMessage({config: {apiEndpoint: "https://example.invalid", modelName: "test", enableToolCall: true}, enableThinking: true, availableTools: [], chatHistory: []});
    return {m, result, sent: sent.join(""), requests};
}
async function main() {
    const cases = [
        ["delta only and empty final", [indexed("response.reasoning_text.delta", {delta: "inspect workspace"}), indexed("response.output_item.done", {item: item(null)})]],
        ["done only and empty final", [indexed("response.reasoning_text.done", {text: "inspect workspace"}), indexed("response.output_item.done", {item: item(null)})]],
        ["complete reasoning_text item", [indexed("response.output_item.done", {item: item("inspect workspace")})]],
        ["complete reasoning_content item without ID", [indexed("response.output_item.done", {item: item("inspect workspace", "reasoning_content", "")})]],
        ["completed response only", [{type: "response.completed", response: {output: [item("inspect workspace")]}}]],
        ["delta plus done and complete snapshots", [indexed("response.reasoning_text.delta", {delta: "inspect "}), indexed("response.reasoning_text.done", {text: "inspect workspace"}), indexed("response.output_item.done", {item: item("inspect workspace")})]],
    ];
    for (const [name, reasoning] of cases) {
        const events = [indexed("response.output_item.added", {item: item(null)}), ...reasoning, ...toolEvents, {type: "response.completed", response: {}}];
        for (const live of [false, true]) {
            const {m, result, sent} = await invoke(events, {live});
            assert.ok(result.text.includes("<think>inspect workspace</think>"), name + ": returned reasoning lost: " + result.text);
            assert.strictEqual((sent.match(/inspect workspace/g) || []).length, 1, name + ": live saved reasoning must be present once");
            assert.strictEqual((sent.match(/<think>/g) || []).length, (sent.match(/<\/think>/g) || []).length, name + ": thinking must close");
            assert.ok(sent.includes('<tool name="inspect">'), name + ": tool XML must follow thinking");
            const history = [{kind: "ASSISTANT", content: sent}, {kind: "TOOL_RESULT", content: '<tool_result name="inspect" status="success"><content>ok</content></tool_result>'}];
            const input = m.buildResponsesInput(history);
            assert.strictEqual(input.filter(x => x.type === "reasoning")[0].content[0].text, "inspect workspace", name + ": continuation lost reasoning");
            assert.strictEqual(input.filter(x => x.type === "function_call").length, 1);
            assert.strictEqual(input.filter(x => x.type === "function_call_output")[0].output, "ok");
        }
        console.log("PASS", name, "(live + buffered)");
    }
    // Event identities remain stable when the stream starts with item_id only,
    // then the completed response introduces output_index.
    {
        const events = [{type: "response.reasoning_text.delta", item_id: "rs_1", content_index: 0, delta: "inspect workspace"},
            {type: "response.completed", response: {output: [item("inspect workspace")]}}];
        const {result, sent} = await invoke(events, {chunkSize: 1});
        assert.strictEqual(result.text, "<think>inspect workspace</think>\n");
        assert.strictEqual((sent.match(/inspect workspace/g) || []).length, 1);
        console.log("PASS item_id to output_index identity and one-character CRLF chunks");
    }
    {
        const events = [indexed("response.reasoning_text.delta", {delta: "first"}),
            indexed("response.reasoning_text.done", {text: "first"}),
            indexed("response.reasoning_text.done", {content_index: 1, text: "second"}),
            indexed("response.output_item.done", {item: {type: "reasoning", id: "rs_1", content: [{type: "reasoning_text", text: "first"}, {type: "reasoning_content", text: "second"}]}})];
        const {result} = await invoke(events, {noTerminator: true, unterminated: true});
        assert.strictEqual(result.text, "<think>firstsecond</think>\n");
        console.log("PASS multiple content parts and EOF without final blank line or DONE");
    }
    {
        const events = [indexed("response.reasoning_text.delta", {delta: "inspect "})];
        const rawEvents = [{type: "response.completed", response: {output: [item("inspect workspace")]}}];
        const {result, sent} = await invoke(events, {rawEvents});
        assert.strictEqual(result.text, "<think>inspect workspace</think>\n");
        assert.strictEqual(sent, "<think>inspect workspace</think>\n");
        console.log("PASS final body reconciles partial live stream exactly once");
    }
    {
        const {result, sent} = await invoke([indexed("response.reasoning_text.delta", {delta: "inspect workspace"})], {rawBody: ""});
        assert.strictEqual(result.text, "<think>inspect workspace</think>\n");
        assert.ok(sent.endsWith("</think>\n"));
        console.log("PASS live-only body is retained and thinking closes at HTTP EOF");
    }
    {
        const {result, sent} = await invoke([indexed("response.reasoning_text.done", {text: "inspect workspace"}), ...toolEvents], {intermediate: false});
        assert.ok(result.text.includes("<think>inspect workspace</think>")); assert.strictEqual(sent, "");
        console.log("PASS runtime without intermediate callback returns complete thinking and tools");
    }
    {
        const events = [indexed("response.reasoning_text.delta", {delta: "wrong"}), indexed("response.reasoning_text.done", {text: "different"}), ...toolEvents];
        const {result, sent} = await invoke(events);
        assert.ok(result.text.startsWith("Provider error: Conflicting Responses text snapshot"));
        assert.ok(!sent.includes("<tool"));
        const failed = await invoke([indexed("response.reasoning_text.delta", {delta: "started"}), {type: "response.failed", response: {error: {message: "simulated failure"}}}, ...toolEvents]);
        assert.ok(failed.result.text.startsWith("Provider error: simulated failure")); assert.ok(!failed.sent.includes("<tool"));
        assert.ok(failed.sent.includes("</think>\n")); assert.ok(failed.sent.includes("Provider error: simulated failure"));
        console.log("PASS conflicting snapshots and response.failed are not treated as successful tool replies");
    }
    {
        const events = [indexed("response.output_text.delta", {delta: "answer"}), indexed("response.output_text.done", {text: "answer completed"}),
            {type: "response.completed", response: {output: [{type: "message", id: "msg_1", content: [{type: "output_text", text: "answer completed"}]}]}}];
        const {result, sent} = await invoke(events);
        assert.strictEqual(result.text, "answer completed"); assert.strictEqual(sent, "answer completed");
        console.log("PASS ordinary output text snapshots deduplicate alongside reasoning");
    }
    {
        const h = [];
        for (let round = 0; round < 2; round++) {
            const thought = "round " + round;
            const events = [indexed("response.reasoning_text.done", {text: thought}), ...toolEvents,
                {type: "response.output_item.added", output_index: 2, item: {type: "function_call", id: "fc_2", name: "second", arguments: "{}"}}];
            const {m, result, sent} = await invoke(events);
            assert.ok(result.text.includes('<tool name="second">'));
            h.push({kind: "ASSISTANT", content: sent}, {kind: "TOOL_RESULT", content: '<tool_result name="inspect" status="success"><content>A</content></tool_result><tool_result name="second" status="success"><content>B</content></tool_result>'});
            const input = m.buildResponsesInput(h);
            assert.strictEqual(input.filter(x => x.type === "reasoning").length, round + 1);
            assert.strictEqual(input.filter(x => x.type === "reasoning")[round].content[0].text, thought);
            assert.strictEqual(JSON.stringify(input.map(x => x.type)), JSON.stringify(Array(round + 1).fill(["reasoning", "function_call", "function_call", "function_call_output", "function_call_output"]).flat()));
            assert.strictEqual(input.filter(x => x.type === "function_call")[round * 2].arguments, '{"path":"/workspace"}');
        }
        console.log("PASS two consecutive tool rounds with parallel calls retain R C C O O batches");
    }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
