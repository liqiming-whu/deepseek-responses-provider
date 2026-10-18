"use strict";
// Load current production functions in an isolated Operit sandbox.
const m = require("./load_provider")();
const L='<';
function c(t,n){return L+'tool_'+t+' name="'+n+'">'+L+'param name="x">'+t+L+'/param>'+L+'/tool_'+t+'>';}
function r(t,n,v){return L+'tool_result_'+t+' name="'+n+'" status="success">'+L+'content>'+v+L+'/content>'+L+'/tool_result_'+t+'>';}
const assistant='开始并行测试\n'+c('a','list_files')+c('b','time:get_time')+c('c','daily_life:get_current_date')+c('d','query_memory');
const hist=[{kind:'USER',content:'go'},{kind:'ASSISTANT',content:assistant},{kind:'TOOL_RESULT',content:r('a','list_files','A')+r('b','time:get_time','B')+r('c','daily_life:get_current_date','C')+r('d','query_memory','D')},{kind:'ASSISTANT',content:'done'}];
const input=m.buildResponsesInput(hist),calls=input.filter(x=>x.type==='function_call'),outs=input.filter(x=>x.type==='function_call_output'),fake=outs.filter(x=>String(x.output).includes('开始并行测试')),cancel=outs.filter(x=>x.output==='User cancelled');
console.log(JSON.stringify({calls:calls.length,outputs:outs.length,fake:fake.length,cancelled:cancel.length,values:outs.map(x=>x.output)}));
if(calls.length!==4||outs.length!==4||fake.length||cancel.length||outs.map(x=>x.output).join('')!=='ABCD')process.exit(1);