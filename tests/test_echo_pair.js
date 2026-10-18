"use strict";
// Load current production functions in an isolated Operit sandbox.
const m = require("./load_provider")();
const lt = '<';
function call(tag, name, path) {
  return lt + 'tool_' + tag + ' name="' + name + '">' + lt + 'param name="path">' + path + lt + '/param>' + lt + '/tool_' + tag + '>';
}
function result(tag, name, value) {
  return lt + 'tool_result_' + tag + ' name="' + name + '" status="success">' + lt + 'content>' + value + lt + '/content>' + lt + '/tool_result_' + tag + '>';
}
const hist = [
  { kind: 'USER', content: 'parallel echo test' },
  { kind: 'TOOL_CALL', content: call('a', 'list_files', '/a') },
  { kind: 'TOOL_CALL', content: call('b', 'read_file', '/b') },
  { kind: 'TOOL_CALL', content: call('c', 'find_files', '/c') },
  { kind: 'TOOL_CALL', content: call('d', 'grep_code', '/d') },
  { kind: 'TOOL_RESULT', content: '上一轮总结文字\n' + call('echo', 'list_files', '/stale') },
  { kind: 'TOOL_RESULT', content:
      result('a', 'list_files', 'A') + result('b', 'read_file', 'B') +
      result('c', 'find_files', 'C') + result('d', 'grep_code', 'D') },
  { kind: 'ASSISTANT', content: 'done' },
];
const input = m.buildResponsesInput(hist);
const calls = input.filter(x => x.type === 'function_call');
const outputs = input.filter(x => x.type === 'function_call_output');
const cancelled = outputs.filter(x => x.output === 'User cancelled');
const fake = outputs.filter(x => String(x.output).includes('/stale'));
console.log(JSON.stringify({ calls: calls.length, outputs: outputs.length, cancelled: cancelled.length, fake: fake.length, values: outputs.map(x => x.output) }));
if (calls.length !== 4 || outputs.length !== 4 || cancelled.length !== 0 || fake.length !== 0 || outputs.map(x => x.output).join('') !== 'ABCD') process.exit(1);
