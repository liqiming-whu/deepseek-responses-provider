// 逻辑验证：从 main.js 提取函数并模拟真实历史配对
const fs = require('fs');
const src = fs.readFileSync('/root/deepseek-responses-provider/dist/main.js', 'utf8');

function extractFn(name) {
  const start = src.indexOf('function ' + name);
  const end = src.indexOf('\nfunction ', start + 10);
  return src.slice(start, end > 0 ? end : src.length);
}

const parts = [
  extractFn('splitThinking'),
  extractFn('xmlUnescape'),
  extractFn('extractToolCalls'),
  extractFn('normalizeToolResultText'),
  extractFn('extractToolResults'),
  extractFn('extractToolResultsList'),
  extractFn('buildResponsesInput'),
  'module.exports = { buildResponsesInput };'
];
fs.writeFileSync('/tmp/pair_test.js', parts.join('\n'));
const m = require('/tmp/pair_test.js');

// 模拟真实历史（随机后缀标签，对齐 histTail）
const hist = [
  { kind: 'SYSTEM', content: 'system prompt' },
  { kind: 'USER', content: 'hello' },
  { kind: 'ASSISTANT', content: 'i will call a tool' },
  { kind: 'TOOL_CALL', content: '<tool_eyxj name="package_proxy">\n<param name="params">{"source_path":"/x"}</param>\n</tool_eyxj>' },
  { kind: 'TOOL_RESULT', content: '<tool_result_lCpC name="package_proxy" status="success"><content>{"ok":true}</content></tool_result_lCpC>' },
  { kind: 'ASSISTANT', content: 'done' },
  { kind: 'USER', content: 'list download dir' },
];

const input = m.buildResponsesInput(hist);
console.log('=== input ===');
input.forEach(it => {
  if (it.type === 'function_call') console.log('CALL', it.call_id, it.name, it.arguments);
  else if (it.type === 'function_call_output') console.log('OUTPUT', it.call_id, '=>', String(it.output).slice(0, 60));
  else console.log('MSG', it.role, String(it.content).slice(0, 40));
});

const calls = input.filter(x => x.type === 'function_call').map(x => x.call_id);
const outs = input.filter(x => x.type === 'function_call_output').map(x => x.call_id);
const orphanCalls = calls.filter(c => !outs.includes(c));
const orphanOuts = outs.filter(o => !calls.includes(o));
console.log('=== CHECK ===');
console.log('calls:', calls.length, 'outs:', outs.length);
console.log('orphan calls:', orphanCalls.length ? orphanCalls : 'NONE');
console.log('orphan outs:', orphanOuts.length ? orphanOuts : 'NONE');

// 再测：孤立 TOOL_CALL（无 TOOL_RESULT）+ 边界 flush
const hist2 = [
  { kind: 'TOOL_CALL', content: '<tool_eyxj name="a">\n<param name="x">1</param>\n</tool_eyxj>' },
  { kind: 'ASSISTANT', content: 'cancelled' },
  { kind: 'USER', content: 'next' },
];
const input2 = m.buildResponsesInput(hist2);
console.log('=== input2 (orphan call) ===');
input2.forEach(it => {
  if (it.type === 'function_call') console.log('CALL', it.call_id, it.name);
  else if (it.type === 'function_call_output') console.log('OUTPUT', it.call_id, '=>', it.output);
  else console.log('MSG', it.role, String(it.content).slice(0, 40));
});
const calls2 = input2.filter(x => x.type === 'function_call').map(x => x.call_id);
const outs2 = input2.filter(x => x.type === 'function_call_output').map(x => x.call_id);
console.log('orphan2 calls:', calls2.filter(c => !outs2.includes(c)).length ? 'HAS_ORPHAN' : 'NONE');

// 并行批次：连续 TOOL_CALL + 单个聚合 TOOL_RESULT。
const parallelHist = [
  { kind: 'USER', content: 'parallel test' },
  { kind: 'TOOL_CALL', content: '<tool_a name="list_files"><param name="path">/a</param></tool_a>' },
  { kind: 'TOOL_CALL', content: '<tool_b name="read_file"><param name="path">/b</param></tool_b>' },
  { kind: 'TOOL_CALL', content: '<tool_c name="find_files"><param name="path">/c</param></tool_c>' },
  { kind: 'TOOL_CALL', content: '<tool_d name="grep_code"><param name="path">/d</param></tool_d>' },
  { kind: 'TOOL_RESULT', content:
      '<tool_result_a name="list_files" status="success"><content>A</content></tool_result_a>' +
      '<tool_result_b name="read_file" status="success"><content>B</content></tool_result_b>' +
      '<tool_result_c name="find_files" status="success"><content>C</content></tool_result_c>' +
      '<tool_result_d name="grep_code" status="success"><content>D</content></tool_result_d>' },
];
const parallelInput = m.buildResponsesInput(parallelHist);
const parallelCalls = parallelInput.filter(x => x.type === 'function_call');
const parallelOutputs = parallelInput.filter(x => x.type === 'function_call_output');
const cancelled = parallelOutputs.filter(x => x.output === 'User cancelled');
console.log('parallel calls/outputs/cancelled:', parallelCalls.length, parallelOutputs.length, cancelled.length);
if (parallelCalls.length !== 4 || parallelOutputs.length !== 4 || cancelled.length !== 0) {
  throw new Error('parallel pairing regression');
}
