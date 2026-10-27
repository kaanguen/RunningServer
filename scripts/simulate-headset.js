import WebSocket from 'ws';
const url = process.env.SERVER_URL || 'ws://localhost:8080/ws';
const ws = new WebSocket(url);
const avatar = { id: 'coach_default_01', spawned: false, behaviorState: 'Reaction', locomotionMode: 'LockedInPlace' };
const runningMate = { state: 'Idle', anchor: 'MarkerA', lane: 1, startSlot: 0, lapLength: 400, speed: 5, elapsed: 0, distance: 0, laps: 0 };
const huds = { stadium: true, debug: false };
let timer, lastTick = Date.now(), bleConnected = true;
const send = value => { if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(value)); };
function telemetry() {
  const now = Date.now(), dt = (now-lastTick)/1000; lastTick = now;
  if(runningMate.state==='Running') {
    runningMate.elapsed = +(runningMate.elapsed+dt).toFixed(2);
    runningMate.distance = +(runningMate.elapsed*runningMate.speed).toFixed(2);
    runningMate.laps = Math.floor(runningMate.distance/runningMate.lapLength);
  }
  send({type:'telemetry',data:{avatar,calibration:{markerA:true,markerB:true,baseline:20,runYaw:0},
    ble:{connected:bleConnected,hr:bleConnected?Math.round(78+5*Math.sin(now/5000)):null,temperature:bleConnected?36.7:null,spo2:bleConnected?98:null,pr:bleConnected?78:null,pi:bleConnected?3.1:null},
    exercises:[{profile:'Walking',confidence:.86,intensity:.45,frequency:1.3,amplitude:.2,active:true}],runningMate,huds}});
}
ws.on('open',()=>{
  console.log(`SIMULATOR connected to ${url} — synthetic data, no physical headset`);
  send({type:'hello',role:'headset',deviceId:'simulator',platform:'simulator'});
  send({type:'registry',data:{avatars:['coach_default_01','alex_v1'],shaders:['Standard','Thermal','TVStatic'],animations:['Idle','Run','Wave'],exerciseProfiles:['Walking','Squat'],huds:['stadium','debug'],capabilities:{ambientLightCalibration:false}}});
  telemetry(); timer=setInterval(telemetry,500);
});
ws.on('message',raw=>{
  const m=JSON.parse(raw);
  if(m.type==='error') console.error(m.message);
  if(m.type!=='command') return;
  const p=m.commandPayload;
  let success=true, error;
  if(m.commandType==='avatar.spawn' || m.commandType==='avatar.spawnOnObject') Object.assign(avatar,{id:m.targetId,spawned:true,...p});
  else if(m.commandType==='avatar.despawn') avatar.spawned=false;
  else if(m.commandType==='avatar.setBehaviorState') avatar.behaviorState=p.behaviorState;
  else if(m.commandType==='avatar.setMode') avatar.locomotionMode=p.mode;
  else if(m.commandType==='runningMate.configure') {
    runningMate.lane=p.lane; runningMate.startSlot=p.startSlot;
    runningMate.lapLength=+(400+2*Math.PI*1.22*(p.lane-1)).toFixed(2);
    runningMate.speed=+(runningMate.lapLength/(p.mode==='PreviousTimePacer'?p.previousTime:p.targetTime)).toFixed(3);
    runningMate.state='Configured';
  } else if(m.commandType==='runningMate.command') {
    const actions={spawn:'Ready',start:'Running',pause:'Paused',resume:'Running',stop:'Stopped',reset:'Ready',despawn:'Idle'};
    runningMate.state=actions[p.action]||'Idle';
    if(['spawn','reset','despawn'].includes(p.action)) Object.assign(runningMate,{elapsed:0,distance:0,laps:0});
    if(p.action==='spawn') avatar.spawned=true;
    if(p.action==='despawn') avatar.spawned=false;
  } else if(m.commandType==='scene.setHudVisible') huds[p.id]=p.visible;
  else if(m.commandType==='scene.setRunningMateHudVisible') huds.stadium=p.visible;
  else if(m.commandType==='sensor.connect') bleConnected=true;
  else if(m.commandType==='sensor.disconnect') bleConnected=false;
  else {success=false;error='Simulator does not implement this command; a Unity client must handle it';}
  send({type:'ack',commandId:m.commandId,success,data:success?{simulated:true}:undefined,error});
  telemetry();
});
ws.on('close',(code,reason)=>{clearInterval(timer);console.log(`Disconnected (${code}) ${reason}`);});
ws.on('error',error=>{console.error(error.message);process.exitCode=1;});
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{clearInterval(timer);ws.close();});
