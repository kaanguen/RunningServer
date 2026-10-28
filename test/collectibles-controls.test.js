import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const definitions=source.slice(0,source.indexOf('setLogCollapsed(localStorage'));
function dashboard() {
  const nodes=new Map(['collectibles-form','collectibles-source','collectibles-count','collectibles-apply','collectibles-status','collectibles-metrics','notice'].map(id=>['#'+id,{textContent:'',innerHTML:'',value:id==='collectibles-source'?'Fixed':'10',reportValidity:()=>true}]));
  const context=vm.createContext({document:{querySelector:id=>nodes.get(id)||null,querySelectorAll:()=>[]},localStorage:{getItem:()=>null},
    setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;},clearTimeout,console});
  vm.runInContext(definitions,context);
  vm.runInContext('updateLive=()=>{}; bind();',context);
  return {context,nodes,run:code=>vm.runInContext(code,context)};
}
test('fixed count and sensor mode send independent validated settings and wait for ACK',async()=>{
  const d=dashboard();const sent=[];let finish;
  d.context.confirm=(type,payload)=>{sent.push(JSON.parse(JSON.stringify({type,payload})));return new Promise(resolve=>finish=resolve);};d.run('confirmedCommand=confirm;');
  d.nodes.get('#collectibles-count').value='17';
  const request=d.nodes.get('#collectibles-form').onsubmit({preventDefault(){}});
  assert.deepEqual(sent,[{type:'runningMate.setCollectibles',payload:{source:'Fixed',fixedCount:17}}]);
  assert.equal(d.run('collectiblesPending'),true);assert.equal(d.nodes.get('#notice').textContent,'');
  await d.nodes.get('#collectibles-form').onsubmit({preventDefault(){}});assert.equal(sent.length,1);
  finish({success:true});await request;
  assert.match(d.nodes.get('#notice').textContent,/von der Brille bestätigt/);
  d.nodes.get('#collectibles-source').value='OxygenSensor';d.nodes.get('#collectibles-source').onchange();
  assert.equal(d.nodes.get('#collectibles-count').disabled,true);
  const sensorRequest=d.nodes.get('#collectibles-form').onsubmit({preventDefault(){}});
  assert.deepEqual(sent[1],{type:'runningMate.setCollectibles',payload:{source:'OxygenSensor',fixedCount:17}});
  finish({success:true});await sensorRequest;
});
test('fractional counts are rejected and headset errors are surfaced',async()=>{
  const d=dashboard();let sent=0;d.context.reject=async()=>{sent++;throw new Error('Track collectibles are unavailable.');};d.run('confirmedCommand=reject;');
  d.nodes.get('#collectibles-count').value='1.5';await d.nodes.get('#collectibles-form').onsubmit({preventDefault(){}});assert.equal(sent,0);
  d.nodes.get('#collectibles-count').value='0';await d.nodes.get('#collectibles-form').onsubmit({preventDefault(){}});assert.equal(sent,1);
  assert.equal(d.nodes.get('#notice').textContent,'Track collectibles are unavailable.');assert.equal(d.run('collectiblesPending'),false);
});
test('sensor loss is explicit, fixed mode remains independent, stale telemetry hides values',()=>{
  const d=dashboard();d.run("connected=true;lastTelemetryAt=Date.now();state.registry={commands:['runningMate.setCollectibles']};");
  d.run("updateCollectibles({collectibles:{source:'OxygenSensor',fixedCount:10,rowCount:0,oxygenReady:false,oxygenPercent:null,collected:8}},true)");
  assert.match(d.nodes.get('#collectibles-status').textContent,/kein aktuelles gültiges Signal/);
  assert.equal(d.nodes.get('#collectibles-apply').disabled,false);
  d.run("updateCollectibles({collectibles:{source:'Fixed',fixedCount:12,rowCount:12,oxygenReady:false,collected:8}},true)");
  assert.match(d.nodes.get('#collectibles-status').textContent,/12 Kugeln.*unabhängig vom Sensor/);
  d.run("lastTelemetryAt=0;updateCollectibles({collectibles:{source:'Fixed',rowCount:12}},true)");
  assert.equal(d.nodes.get('#collectibles-apply').disabled,true);assert.doesNotMatch(d.nodes.get('#collectibles-metrics').innerHTML,/>12</);
});
