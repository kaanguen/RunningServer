import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const definitions=source.slice(0,source.indexOf('setLogCollapsed(localStorage'));
function dashboard(){
  const ids=['behaviour-stop','behaviour-speed','behaviour-loop','behaviour-status','behaviour-current','behaviour-progress','notice'];
  const nodes=new Map(ids.map(id=>['#'+id,{textContent:'',value:id==='behaviour-speed'?'1':'',checked:true,disabled:false}]));
  const button={dataset:{animation:'Warmup_Legs'},disabled:false,textContent:'',setAttribute(k,v){this[k]=v;}};
  const tile={dataset:{behaviourTile:'Warmup_Legs'},classList:{toggle(){}}};
  const context=vm.createContext({document:{querySelector:id=>nodes.get(id)||null,querySelectorAll:q=>q==='[data-animation]'?[button]:q==='[data-behaviour-tile]'?[tile]:[]},localStorage:{getItem:()=>null},
    setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;},clearTimeout,console});
  vm.runInContext(definitions,context);vm.runInContext('updateLive=()=>{};bind();',context);
  return{context,nodes,button,run:code=>vm.runInContext(code,context)};
}
test('play sends selected clip, repeat and speed; waits for actual headset ACK and prevents duplicate sends',async()=>{
  const d=dashboard(),sent=[];let finish;
  d.context.confirm=(type,payload)=>{sent.push(JSON.parse(JSON.stringify({type,payload})));return new Promise(resolve=>finish=resolve);};d.run('confirmedCommand=confirm;');
  d.nodes.get('#behaviour-speed').value='1.5';d.nodes.get('#behaviour-loop').checked=false;
  const request=d.button.onclick();
  assert.deepEqual(sent,[{type:'avatar.playAnimation',payload:{animationId:'Warmup_Legs',loop:false,speed:1.5}}]);
  assert.equal(d.run('behaviourPending'),true);assert.equal(d.nodes.get('#notice').textContent,'');
  await d.button.onclick();assert.equal(sent.length,1);
  finish({success:true});await request;
  assert.match(d.nodes.get('#notice').textContent,/von der Brille bestätigt/);assert.equal(d.run('behaviourPending'),false);
});
test('return command and rejection are displayed without claiming success',async()=>{
  const d=dashboard(),sent=[];
  d.context.confirm=async(type,payload)=>sent.push(JSON.parse(JSON.stringify({type,payload})));d.run('confirmedCommand=confirm;');
  await d.nodes.get('#behaviour-stop').onclick();assert.deepEqual(sent,[{type:'avatar.stopAnimation',payload:{}}]);
  d.context.reject=async()=>{throw new Error('Zuerst Platzierung einrichten.');};d.run('confirmedCommand=reject;');
  await d.button.onclick();assert.equal(d.nodes.get('#notice').textContent,'Zuerst Platzierung einrichten.');assert.equal(d.run('behaviourPending'),false);
});
test('fresh telemetry and installed clip catalog gate playback; stop stays possible after placement loss',()=>{
  const d=dashboard();
  d.run("connected=true;lastTelemetryAt=Date.now();state.registry={commands:['avatar.playAnimation','avatar.stopAnimation'],animations:[{id:'Warmup_Legs'}]};");
  d.run("updateBehaviour({placementReady:true,heightConfirmed:true,headPoseReady:true,behaviour:{active:true,animationId:'Warmup_Legs',label:'Beine aufwärmen',loop:true,speed:1,elapsed:3,duration:10}},true)");
  assert.equal(d.button.disabled,false);assert.equal(d.button['aria-pressed'],'true');assert.equal(d.nodes.get('#behaviour-progress').value,.3);
  assert.equal(d.nodes.get('#behaviour-current').textContent,'Beine aufwärmen');
  d.run("updateBehaviour({placementReady:false,behaviour:{active:true,animationId:'Warmup_Legs'}},true)");
  assert.equal(d.button.disabled,true);assert.equal(d.nodes.get('#behaviour-stop').disabled,false);
  d.run("lastTelemetryAt=0;updateBehaviour({behaviour:{active:true,label:'OLD'}},true)");
  assert.equal(d.button.disabled,true);assert.equal(d.nodes.get('#behaviour-stop').disabled,true);assert.doesNotMatch(d.nodes.get('#behaviour-current').textContent,/OLD/);
});
test('old apps and clips absent from registry remain disabled; invalid speed is not sent',async()=>{
  const d=dashboard();d.run("connected=true;lastTelemetryAt=Date.now();state.registry={commands:[]};updateBehaviour({placementReady:true,heightConfirmed:true,headPoseReady:true},true)");
  assert.equal(d.button.disabled,true);assert.match(d.nodes.get('#behaviour-status').textContent,/aktualisierte MarkerML2/);
  d.button.disabled=false;let sent=0;d.context.confirm=async()=>{sent++;};d.run('confirmedCommand=confirm;');
  d.nodes.get('#behaviour-speed').value='9';await d.button.onclick();assert.equal(sent,0);
});
