import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const definitions=source.slice(0,source.indexOf('setLogCollapsed(localStorage'));
function ui(){
 const nodes=new Map([['#run-feedback',{textContent:''}]]);
 const buttons=['stop','reset'].map(action=>({dataset:{run:action},disabled:false}));
 const sent=[],prompts=[];
 const context=vm.createContext({document:{querySelector:id=>nodes.get(id)||null,querySelectorAll:q=>q==='[data-run]'?buttons:[]},localStorage:{getItem:()=>null},window:{confirm:text=>{prompts.push(text);return true;}},setTimeout,clearTimeout,console});
 vm.runInContext(definitions,context);context.send=async(type,payload)=>sent.push(JSON.parse(JSON.stringify({type,payload})));vm.runInContext('updateLive=()=>{};confirmedCommand=send;bind();',context);
 return{context,buttons,sent,prompts,nodes,run:code=>vm.runInContext(code,context)};
}
test('ending run sends stop without resetting or a reset confirmation',async()=>{
 const d=ui();await d.buttons[0].onclick();assert.deepEqual(d.sent,[{type:'runningMate.command',payload:{action:'stop'}}]);assert.equal(d.prompts.length,0);assert.match(d.nodes.get('#run-feedback').textContent,/Laufende.*bestätigt/);
});
test('reset remains separate, explains returning both to zero and retaining bests',async()=>{
 const d=ui();await d.buttons[1].onclick();assert.deepEqual(d.sent,[{type:'runningMate.command',payload:{action:'reset'}}]);assert.match(d.prompts[0],/beide.*Anfang/);assert.match(d.prompts[0],/Bestzeiten bleiben erhalten/);
 d.context.window.confirm=()=>false;await d.buttons[1].onclick();assert.equal(d.sent.length,1);
});
