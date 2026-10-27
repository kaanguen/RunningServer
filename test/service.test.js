import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createService } from '../server.js';

async function fixture(t, options={}) {
  const directory=await mkdtemp(join(tmpdir(),'avatar-vos-'));
  const service=createService({recordingsDir:directory,...options});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${service.server.address().port}`;
  t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true});});
  const request=(path,data)=>fetch(url+'/api/'+path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  async function connect(role) {
    const ws=new WebSocket(url.replace('http:','ws:')+'/ws');
    const messages=[], waiters=[];
    ws.on('message',raw=>{const data=JSON.parse(raw);messages.push(data);for(const wake of waiters.splice(0)) wake();});
    function next(predicate) {
      return new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error('Timed out waiting for message')),2000);
        function check(){const i=messages.findIndex(predicate);if(i>=0){clearTimeout(timeout);resolve(messages.splice(i,1)[0]);}else waiters.push(check);}
        check();
      });
    }
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
    ws.send(JSON.stringify({type:'hello',role}));
    await next(m=>m.type==='welcome');
    return {ws,next,send:m=>ws.send(JSON.stringify(m))};
  }
  return {service,directory,url,request,connect};
}
test('serves dashboard; validates commands and reports offline headset',async t=>{
  const f=await fixture(t);
  assert.equal((await fetch(f.url)).status,200);
  assert.match(await (await fetch(f.url)).text(),/Magic Leap 2/);
  assert.equal((await f.request('command',{commandType:'avatar.spawn'})).status,503);
  assert.equal((await f.request('command',{commandType:'invalid'})).status,400);
  assert.equal((await f.request('command',{commandType:'avatar.spawn',commandPayload:[]})).status,400);
  assert.equal((await fetch(f.url+'/api/command',{method:'POST',body:'{bad'})).status,400);
  assert.equal((await fetch(f.url+'/api/command',{method:'POST',body:'x'.repeat(70000)})).status,413);
  assert.equal((await fetch(f.url+'/api/session/start',{method:'POST',headers:{Origin:'http://evil.invalid'},body:'{}'})).status,403);
  assert.equal((await fetch(f.url+'/server.js')).status,404);
});
test('relays commands only to headset; broadcasts registry, telemetry and ack to all dashboards',async t=>{
  const f=await fixture(t), a=await f.connect('dashboard'), b=await f.connect('dashboard'), headset=await f.connect('headset');
  headset.send({type:'registry',data:{avatars:['coach']}});
  assert.deepEqual((await a.next(m=>m.type==='registry')).data.avatars,['coach']);
  assert.deepEqual((await b.next(m=>m.type==='registry')).data.avatars,['coach']);
  const response=await f.request('command',{commandType:'avatar.spawn',targetId:'coach',commandPayload:{behaviorState:'Reaction'}});
  assert.equal(response.status,202);
  const accepted=await response.json(), command=await headset.next(m=>m.type==='command');
  assert.equal(command.commandId,accepted.commandId);assert.equal(command.targetId,'coach');
  headset.send({type:'ack',commandId:command.commandId,success:true});
  assert.equal((await a.next(m=>m.type==='ack')).success,true);
  assert.equal((await b.next(m=>m.type==='ack')).success,true);
  headset.send({type:'telemetry',data:{avatar:{spawned:true}}});
  assert.equal((await a.next(m=>m.type==='telemetry')).data.avatar.spawned,true);
  assert.equal((await (await f.request('status')).json()).headsetConnected,true);
  a.send({type:'telemetry',data:{avatar:{spawned:false}}});
  assert.match((await a.next(m=>m.type==='error')).message,/POST/);
  headset.ws.close();
  await a.next(m=>m.type==='status'&&!m.headsetConnected);
});
test('records sensor CSV and command JSONL and finalizes session metadata',async t=>{
  const f=await fixture(t), headset=await f.connect('headset');
  assert.equal((await f.request('session/start',{name:'Training'})).status,201);
  assert.equal((await f.request('session/start',{})).status,409);
  const started=await f.request('recording/start',{});assert.equal(started.status,201);
  const {id}=await started.json();
  assert.equal((await f.request('recording/start',{})).status,409);
  assert.equal((await f.request('session/stop',{})).status,409);
  headset.send({type:'telemetry',data:{ble:{hr:80,temperature:36.8,spo2:99},exercises:[{profile:'Walk,"test"',confidence:.8,intensity:.4,active:true}]}});
  await f.request('command',{commandType:'avatar.spawn'});
  const command=await headset.next(m=>m.type==='command');
  headset.send({type:'ack',commandId:command.commandId,success:true});
  // Reading HTTP status after the WebSocket message confirms telemetry has been handled.
  await f.request('status');
  assert.equal((await f.request('recording/stop',{})).status,200);
  assert.match(await readFile(join(f.directory,id,'ble_data.csv'),'utf8'),/"80","36.8","99"/);
  assert.match(await readFile(join(f.directory,id,'exercise_detections.csv'),'utf8'),/Walk,""test""/);
  assert.equal(JSON.parse((await readFile(join(f.directory,id,'commands.jsonl'),'utf8')).trim()).commandId,command.commandId);
  const meta=JSON.parse(await readFile(join(f.directory,id,'session_meta.json'),'utf8'));
  assert.equal(meta.session.name,'Training');assert.ok(meta.stoppedAt);
  assert.equal((await readdir(f.directory)).length,1);
  assert.equal((await f.request('session/stop',{})).status,200);
});
test('times out missing acknowledgements and rejects a second headset',async t=>{
  const f=await fixture(t,{commandTimeout:40}), dashboard=await f.connect('dashboard');await f.connect('headset');
  const other=new WebSocket(f.url.replace('http:','ws:')+'/ws');
  other.on('open',()=>other.send(JSON.stringify({type:'hello',role:'headset'})));
  const code=await new Promise(resolve=>other.on('close',resolve));assert.equal(code,1008);
  await f.request('command',{commandType:'avatar.spawn'});
  const ack=await dashboard.next(m=>m.type==='ack');assert.equal(ack.success,false);assert.match(ack.error,/timed out/);
});
test('rejects malformed registry and telemetry without corrupting the snapshot',async t=>{
  const f=await fixture(t), headset=await f.connect('headset');
  headset.send({type:'registry',data:{avatars:'invalid'}});
  assert.match((await headset.next(m=>m.type==='error')).message,/registry.avatars/);
  headset.send({type:'telemetry',data:{exercises:'invalid'}});
  assert.match((await headset.next(m=>m.type==='error')).message,/telemetry.exercises/);
  assert.deepEqual((await (await f.request('status')).json()).telemetry,{});
});
test('graceful shutdown finalizes an active recording',async t=>{
  const f=await fixture(t);
  const {id}=await (await f.request('recording/start',{})).json();
  await f.service.close();
  const meta=JSON.parse(await readFile(join(f.directory,id,'session_meta.json'),'utf8'));
  assert.ok(meta.stoppedAt);assert.equal(meta.reason,'server_shutdown');
});
