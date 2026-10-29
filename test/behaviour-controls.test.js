import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const definitions=source.slice(0,source.indexOf('setLogCollapsed(localStorage'));
function dashboard(){
  const ids=['behaviour-stop','behaviour-speed','behaviour-loop','behaviour-status','behaviour-current','behaviour-progress','plank-hold-seconds','notice'];
  const nodes=new Map(ids.map(id=>['#'+id,{textContent:'',value:id==='behaviour-speed'?'1':id==='plank-hold-seconds'?'10':'',checked:true,disabled:false}]));
  const button={dataset:{animation:'Mixamo_BatterOnDeck'},disabled:false,textContent:'',setAttribute(k,v){this[k]=v;}};
  const tile={dataset:{behaviourTile:'Mixamo_BatterOnDeck'},classList:{toggle(){}}};
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
  assert.deepEqual(sent,[{type:'avatar.playAnimation',payload:{animationId:'Mixamo_BatterOnDeck',loop:false,speed:1.5}}]);
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
  d.run("connected=true;lastTelemetryAt=Date.now();state.registry={commands:['avatar.playAnimation','avatar.stopAnimation'],animations:[{id:'Mixamo_BatterOnDeck'}]};");
  d.run("updateBehaviour({placementReady:true,heightConfirmed:true,headPoseReady:true,behaviour:{active:true,animationId:'Mixamo_BatterOnDeck',label:'Batter On Deck',loop:true,speed:1,elapsed:3,duration:10}},true)");
  assert.equal(d.button.disabled,false);assert.equal(d.button['aria-pressed'],'true');assert.equal(d.nodes.get('#behaviour-progress').value,.3);
  assert.equal(d.nodes.get('#behaviour-current').textContent,'Batter On Deck');
  d.run("updateBehaviour({placementReady:false,behaviour:{active:true,animationId:'Mixamo_BatterOnDeck'}},true)");
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

test('catalog uses supplied Mixamo takes and defaults to one-shot playback',()=>{
  const d=dashboard();
  assert.equal(d.run('behaviourLoop'),false);
  assert.equal(d.run('behaviourAnimations.filter(a=>a.category==="Warmup").length'),6);
  assert.equal(d.run('behaviourAnimations.some(a=>a.id.startsWith("Warmup_"))'),false);
  assert.equal(d.run('behaviourAnimations.some(a=>a.id==="Mixamo_StartJumpingJacks")'),true);
});

test('Jumping Jacks sends continuous playback even when the global repeat box is off',async()=>{
  const d=dashboard(),sent=[];
  d.context.confirm=async(type,payload)=>sent.push(JSON.parse(JSON.stringify({type,payload})));d.run('confirmedCommand=confirm;');
  d.nodes.get('#behaviour-loop').checked=false;
  await d.run('changeAvatarAnimation("Mixamo_StartJumpingJacks")');
  assert.equal(sent[0].payload.loop,true);
  assert.equal(d.nodes.get('#behaviour-loop').checked,true);
});

test('trimmed Warming Up is available and sends its own animation id',async()=>{
  const d=dashboard(),sent=[];
  d.context.confirm=async(type,payload)=>sent.push(JSON.parse(JSON.stringify({type,payload})));d.run('confirmedCommand=confirm;');
  d.nodes.get('#behaviour-loop').checked=false;
  await d.run('changeAvatarAnimation("Mixamo_WarmingUp")');
  assert.equal(sent[0].payload.animationId,'Mixamo_WarmingUp');
  assert.equal(sent[0].payload.loop,false);
  assert.ok(d.run('behaviourAnimations.find(a=>a.id==="Mixamo_WarmingUp").duration')<2.1);
});

test('Arm Stretching and Air Squat are selectable and send distinct clip ids',async()=>{
  const d=dashboard(),sent=[];
  d.context.confirm=async(type,payload)=>sent.push(JSON.parse(JSON.stringify({type,payload})));d.run('confirmedCommand=confirm;');
  for(const id of ['Mixamo_ArmStretching','Mixamo_AirSquat']){
    assert.equal(d.run('behaviourAnimations.some(a=>a.id==='+JSON.stringify(id)+')'),true);
    await d.run('changeAvatarAnimation('+JSON.stringify(id)+')');
  }
  assert.deepEqual(sent.map(x=>x.payload.animationId),['Mixamo_ArmStretching','Mixamo_AirSquat']);
});

test('Plank sends one sequence command and respects whole-sequence repeat selection',async()=>{
  const d=dashboard(),sent=[];d.run("state.registry={animations:[{id:'Mixamo_Plank',supportsHoldDuration:true}]};");
  d.context.confirm=async(type,payload)=>sent.push(JSON.parse(JSON.stringify({type,payload})));d.run('confirmedCommand=confirm;');
  d.nodes.get('#behaviour-loop').checked=false;await d.run('changeAvatarAnimation("Mixamo_Plank")');
  d.nodes.get('#behaviour-loop').checked=true;await d.run('changeAvatarAnimation("Mixamo_Plank")');
  assert.deepEqual(sent.map(x=>x.payload),[{animationId:'Mixamo_Plank',loop:false,speed:1,holdSeconds:10},{animationId:'Mixamo_Plank',loop:true,speed:1,holdSeconds:10}]);
});

test('custom Plank duration is sent; invalid values and old apps do not send',async()=>{
 const d=dashboard(),sent=[];d.context.confirm=async(type,payload)=>sent.push(JSON.parse(JSON.stringify(payload)));d.run('confirmedCommand=confirm;state.registry={animations:[{id:"Mixamo_Plank",supportsHoldDuration:true}]};');
 d.nodes.get('#plank-hold-seconds').value='30';await d.run('changeAvatarAnimation("Mixamo_Plank")');assert.equal(sent[0].holdSeconds,30);
 for(const value of ['0','301','abc','1.5','']){d.nodes.get('#plank-hold-seconds').value=value;await d.run('changeAvatarAnimation("Mixamo_Plank")');}
 assert.equal(sent.length,1);
 d.nodes.get('#plank-hold-seconds').value='20';d.run('state.registry={animations:[{id:"Mixamo_Plank"}]};');await d.run('changeAvatarAnimation("Mixamo_Plank")');assert.equal(sent.length,1);
});
