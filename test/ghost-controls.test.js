import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const definitions=source.slice(0,source.indexOf("setLogCollapsed(localStorage"));
function dashboard() {
  const nodes=new Map(['ghost-speed-form','ghost-speed','ghost-speed-apply','ghost-speed-auto','ghost-mode-status','notice'].map(id=>['#'+id,{textContent:'',value:'10',reportValidity:()=>true}]));
  const context=vm.createContext({document:{querySelector:id=>nodes.get(id)||null,querySelectorAll:()=>[]},localStorage:{getItem:()=>null},
    setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;},clearTimeout,console});
  vm.runInContext(definitions,context);
  vm.runInContext('updateLive=()=>{}; bind();',context);
  return {context,nodes,run:code=>vm.runInContext(code,context)};
}
test('ghost feedback distinguishes recorded best, target fallback and pause',()=>{
  const d=dashboard();
  assert.match(d.run("ghostPlaybackStatus({state:'Ready',paceSeconds:300,ghost:{testMode:false}})"),/Zielpacemodus.*5:00.*keine vollständige Runde.*pausiert/);
  assert.match(d.run("ghostPlaybackStatus({state:'Running',records:{bestLapSeconds:160},ghost:{testMode:false,active:true}})"),/Bestzeitmodus.*aufgezeichnete beste Runde/);
  assert.equal(d.run("hasGhostRecording({records:{bestLapSeconds:160},ghost:{testMode:true,recordedLap:false}})"),true);
  assert.equal(d.run("hasGhostRecording({records:{bestLapSeconds:null},ghost:{recordedLap:false}})"),false);
});
test('return button sends null, waits for headset and prevents duplicate mode edits',async()=>{
  const d=dashboard(); let finish; const sent=[];
  d.context.confirm=(type,payload)=>{sent.push(JSON.parse(JSON.stringify({type,payload})));return new Promise(resolve=>{finish=resolve;});};
  d.run('confirmedCommand=confirm;');
  const request=d.nodes.get('#ghost-speed-auto').onclick();
  assert.deepEqual(sent,[{type:'runningMate.setGhostSpeed',payload:{speedKmh:null}}]);
  assert.equal(d.run('ghostSpeedPending'),true);
  assert.equal(d.nodes.get('#notice').textContent,'');
  await d.nodes.get('#ghost-speed-form').onsubmit({preventDefault(){}});
  assert.equal(sent.length,1);
  finish({success:true}); await request;
  assert.equal(d.run('ghostSpeedPending'),false);
  assert.match(d.nodes.get('#notice').textContent,/von der Brille bestätigt/);
});
test('headset rejection is shown instead of reporting a successful return',async()=>{
  const d=dashboard();
  d.context.reject=async()=>{throw new Error('Ghost playback is unavailable.');};
  d.run('confirmedCommand=reject;');
  await d.nodes.get('#ghost-speed-auto').onclick();
  assert.equal(d.nodes.get('#notice').textContent,'Ghost playback is unavailable.');
  assert.equal(d.run('ghostSpeedPending'),false);
});
