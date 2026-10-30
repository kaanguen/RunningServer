import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function dashboard() {
  const nodes=new Map(['ble-device','ble-scan','ble-stop-scan','ble-connect','ble-disconnect','ble-status','ble-feedback','ble-connected-devices','ble-metrics','ble-values-status'].map(id=>['#'+id,{textContent:'',innerHTML:'',value:'',disabled:false}]));
  const context=vm.createContext({document:{querySelector:id=>nodes.get(id)||null},localStorage:{getItem:()=>null},Date,console});
  vm.runInContext(source.slice(0,source.indexOf('setLogCollapsed(localStorage')),context);
  const run=code=>vm.runInContext(code,context);
  run('updateLive=updateBleControls;');
  run(`connected=true;lastTelemetryAt=Date.now();state={headsetConnected:true,registry:{commands:['sensor.startScan','sensor.stopScan','sensor.connect','sensor.disconnect']},telemetry:{ble:{available:true,devices:[],status:'Bereit'}}};`);
  return {context,nodes,run};
}
test('all named and unnamed devices are listed, escaped, and selected by stable ID',()=>{
  const d=dashboard();
  d.run(`state.telemetry.ble.devices=[{id:'one',name:'Unrelated brand'},{id:'two',name:''},{id:'three',name:'<img src=x onerror=alert(1)>'}];bleSelectedDeviceId='two';updateBleControls();`);
  assert.match(d.nodes.get('#ble-device').innerHTML,/Unrelated brand/);
  assert.match(d.nodes.get('#ble-device').innerHTML,/Ohne Namen/);
  assert.match(d.nodes.get('#ble-device').innerHTML,/&lt;img/);
  assert.doesNotMatch(d.nodes.get('#ble-device').innerHTML,/<img/);
  assert.equal(d.nodes.get('#ble-device').value,'two');
  assert.equal(d.nodes.get('#ble-connect').disabled,false);
  d.run('state.telemetry.ble.devices.reverse();updateBleControls();');
  assert.equal(d.nodes.get('#ble-device').value,'two');
  d.run('state.telemetry.ble.devices=[];updateBleControls();');
  assert.equal(d.nodes.get('#ble-connect').disabled,true);
});
test('scan, connection, old app and stale headset states gate actions',()=>{
  const d=dashboard();
  d.run('state.telemetry.ble.scanning=true;updateBleControls();');
  assert.equal(d.nodes.get('#ble-scan').disabled,true);
  assert.equal(d.nodes.get('#ble-stop-scan').disabled,false);
  d.run('state.telemetry.ble.scanning=false;state.telemetry.ble.connecting=true;updateBleControls();');
  assert.equal(d.nodes.get('#ble-disconnect').disabled,false);
  assert.equal(d.nodes.get('#ble-device').disabled,true);
  d.run('lastTelemetryAt=0;updateBleControls();');
  assert.equal(d.nodes.get('#ble-disconnect').disabled,true);
  d.run('lastTelemetryAt=Date.now();state.registry.commands=[];updateBleControls();');
  assert.equal(d.nodes.get('#ble-scan').disabled,true);
  assert.match(d.nodes.get('#ble-status').textContent,/aktualisierte App/);
});
test('connect sends device identity, waits for ACK and reports rejection without claiming connection',async()=>{
  const d=dashboard();let finish;const sent=[];
  d.context.send=(type,payload)=>{sent.push(JSON.parse(JSON.stringify({type,payload})));return new Promise(resolve=>finish=resolve);};
  d.run('confirmedCommand=send;');
  const request=d.run(`sendBleCommand('sensor.connect',{deviceId:'AA:BB'})`);
  assert.equal(d.run('blePending'),true);
  assert.deepEqual(sent,[{type:'sensor.connect',payload:{deviceId:'AA:BB'}}]);
  await d.run(`sendBleCommand('sensor.startScan')`);
  assert.equal(sent.length,1);
  finish({success:true});await request;
  assert.equal(d.run('blePending'),false);
  assert.match(d.nodes.get('#ble-feedback').textContent,/Auftrag|auftrag/);
  assert.equal(d.run('state.telemetry.ble.connected'),undefined);
  d.run(`confirmedCommand=async()=>{throw new Error('Permission denied');};`);
  await d.run(`sendBleCommand('sensor.startScan')`);
  assert.equal(d.nodes.get('#ble-feedback').textContent,'Permission denied');
  assert.equal(d.run('blePending'),false);
});

test('currently connected device stays visible independently of discovery and disappears on disconnect or stale data',()=>{
  const d=dashboard();
  d.run(`state.telemetry.ble={available:true,connected:true,devices:[],deviceId:'AA:02',deviceName:'Sensor <one>',connectedDevices:[{id:'AA:02',name:'Sensor <one>'}]};updateBleControls();`);
  const node=d.nodes.get('#ble-connected-devices');
  assert.match(node.innerHTML,/VERBUNDENES GERÄT/);assert.match(node.innerHTML,/Sensor &lt;one&gt;/);assert.match(node.innerHTML,/AA:02/);
  d.run('lastTelemetryAt=0;updateBleControls();');
  assert.doesNotMatch(node.innerHTML,/AA:02/);assert.match(node.innerHTML,/Keine aktuellen/);
  d.run('lastTelemetryAt=Date.now();state.telemetry.ble.connected=false;updateBleControls();');
  assert.match(node.innerHTML,/Kein BLE-Gerät verbunden/);assert.doesNotMatch(node.innerHTML,/AA:02/);
});
test('heart rate, Celsius, pulse and perfusion render only as fresh numeric measurements',()=>{
  const d=dashboard();
  d.run(`state.telemetry.ble={connected:true,hr:72,temperature:36.5,spo2:98,pr:74,pi:2.5};updateBleMetrics();`);
  const node=d.nodes.get('#ble-metrics');
  assert.match(node.innerHTML,/>72</);assert.match(node.innerHTML,/>36,5</);assert.match(node.innerHTML,/>98</);assert.match(node.innerHTML,/>74</);assert.match(node.innerHTML,/>2,5</);
  d.run(`state.telemetry.ble.hr=null;state.telemetry.ble.temperature='36.5';state.telemetry.ble.pi=NaN;updateBleMetrics();`);
  assert.doesNotMatch(node.innerHTML,/>72</);assert.doesNotMatch(node.innerHTML,/>36,5</);assert.doesNotMatch(node.innerHTML,/NaN/);
  d.run('lastTelemetryAt=0;updateBleMetrics();');
  assert.doesNotMatch(node.innerHTML,/>98</);assert.match(d.nodes.get('#ble-values-status').textContent,/ausgeblendet/);
  d.run('lastTelemetryAt=Date.now();state.telemetry.ble.connected=false;updateBleMetrics();');
  assert.doesNotMatch(node.innerHTML,/>74</);
});
