import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const definitions=source.slice(0,source.indexOf('setLogCollapsed(localStorage'));
function dashboard(saved=null){
 const ids=['warmup-current','warmup-countdown','warmup-step-status','warmup-progress','warmup-start','warmup-next','warmup-stop','warmup-feedback','warmup-add','warmup-save','warmup-plan-feedback','warmup-total','notice'];
 const nodes=new Map(ids.map(id=>['#'+id,{textContent:'',innerHTML:'',disabled:false,hidden:false}]));
 const storage=new Map(saved?[['markerML2.warmup',JSON.stringify(saved)]]:[]);
 const context=vm.createContext({document:{querySelector:id=>nodes.get(id)||null,querySelectorAll:()=>[]},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},setTimeout:fn=>{const t=setTimeout(fn,10);t.unref();return t;},clearTimeout,console});
 vm.runInContext(definitions,context);
 const run=code=>vm.runInContext(code,context);
 run("updateLive=()=>{};render=()=>{};connected=true;lastTelemetryAt=Date.now();state={headsetConnected:true,registry:{project:'MarkerML2',commands:['exercise.startWarmup','exercise.stopWarmup','exercise.nextWarmup'],animations:warmupExercises},telemetry:{treadmill:{state:'Ready',elapsed:0,distance:0,placementReady:true,headPoseReady:true,heightConfirmed:true,warmup:{active:false,status:'Idle'}}}};bindWarmup();");
 return{run,context,nodes,storage};
}
test('Warm-up planner includes five original exercises and never Plank; saved plan validates on reload',()=>{
 const d=dashboard();assert.equal(d.run('warmupExercises.length'),5);assert.equal(d.run('warmupExercises.some(e=>e.id==="Mixamo_Plank")'),false);
 assert.equal(d.run('validateWarmupPlan([{animationId:"Mixamo_Plank",seconds:30}])'),false);
 assert.equal(dashboard([{animationId:'Mixamo_AirSquat',seconds:45}]).run('warmupDraft[0].seconds'),45);
 assert.equal(dashboard([{animationId:'Mixamo_Plank',seconds:45}]).run('warmupDraft.length'),5);
});
test('start transmits chosen sequence and real seconds, waits for ACK, deduplicates pending clicks',async()=>{
 const d=dashboard(),sent=[];let finish;
 d.context.send=(type,payload)=>{sent.push(JSON.parse(JSON.stringify({type,payload})));return new Promise(resolve=>finish=resolve);};
 d.run('confirmedCommand=send;warmupDraft=[{animationId:"Mixamo_ArmStretching",seconds:45},{animationId:"Mixamo_AirSquat",seconds:20}];');
 const pending=d.run('warmupCommand("start")');await d.run('warmupCommand("start")');
 assert.deepEqual(sent,[{type:'exercise.startWarmup',payload:{steps:[{animationId:'Mixamo_ArmStretching',seconds:45},{animationId:'Mixamo_AirSquat',seconds:20}]}}]);
 assert.equal(d.run('warmupPending'),true);assert.doesNotMatch(d.run('warmupFeedback'),/gestartet/);
 finish({success:true});await pending;assert.match(d.run('warmupFeedback'),/von der Brille bestätigt/);
});
test('invalid durations, stale connection, missing clips and a running session block start',async()=>{
 const d=dashboard(),sent=[];d.context.send=async(...args)=>sent.push(args);d.run('confirmedCommand=send;');
 for(const seconds of [0,4,301,5.5,NaN]){d.context.seconds=seconds;d.run('warmupDraft=[{animationId:"Mixamo_AirSquat",seconds}];');await d.run('warmupCommand("start")');}
 d.run('warmupDraft=[{animationId:"Mixamo_AirSquat",seconds:30}];lastTelemetryAt=0;');await d.run('warmupCommand("start")');
 d.run('lastTelemetryAt=Date.now();state.registry.animations=[];');await d.run('warmupCommand("start")');
 d.run('state.registry.animations=warmupExercises;state.telemetry.treadmill.state="Running";');await d.run('warmupCommand("start")');
 assert.equal(sent.length,0);
});
test('live progress follows headset state; exit and skip send distinct confirmed commands',async()=>{
 const d=dashboard(),sent=[];d.context.send=async(type,payload)=>sent.push({type,payload});d.run('confirmedCommand=send;state.telemetry.treadmill.warmup={active:true,status:"Running",stepIndex:1,stepCount:3,label:"Arme dehnen",stepElapsed:10,stepDuration:30,elapsed:40,duration:90};updateWarmup(state.telemetry.treadmill,true);');
 assert.equal(d.nodes.get('#warmup-current').textContent,'Arme dehnen');assert.match(d.nodes.get('#warmup-countdown').innerHTML,/20/);assert.equal(d.nodes.get('#warmup-progress').value,40/90);
 assert.equal(d.nodes.get('#warmup-save').disabled,true);assert.equal(d.nodes.get('#warmup-start').hidden,true);
 await d.run('warmupCommand("next")');await d.run('warmupCommand("stop")');assert.deepEqual(sent.map(s=>s.type),['exercise.nextWarmup','exercise.stopWarmup']);
 d.run('lastTelemetryAt=0;updateWarmup(state.telemetry.treadmill,true);');assert.equal(d.nodes.get('#warmup-current').textContent,'Warte auf die Brille');assert.equal(d.nodes.get('#warmup-stop').disabled,true);
});
test('save and add edit only the next plan; failed ACK is reported without success',async()=>{
 const d=dashboard();await d.nodes.get('#warmup-add').onclick();assert.equal(d.run('warmupDraft.length'),6);
 d.run('warmupDraft=[{animationId:"Mixamo_AirSquat",seconds:60}];');await d.nodes.get('#warmup-save').onclick();assert.deepEqual(JSON.parse(d.storage.get('markerML2.warmup')),[{animationId:'Mixamo_AirSquat',seconds:60}]);
 d.context.reject=async()=>{throw new Error('Platzierung fehlt');};d.run('confirmedCommand=reject;');await d.run('warmupCommand("start")');assert.match(d.run('warmupFeedback'),/Nicht ausgeführt: Platzierung fehlt/);assert.equal(d.run('warmupPending'),false);
});
