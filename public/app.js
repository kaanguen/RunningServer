const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const defaults = { paceSeconds: 360, heightCm: 184, mode: 'TempoPartner', showTrack: true };
let draft = { ...defaults };
try {
  const saved = JSON.parse(localStorage.getItem('markerML2.settings'));
  if (saved && Number.isInteger(saved.paceSeconds) && saved.paceSeconds >= 180 && saved.paceSeconds <= 1200
    && Number.isInteger(saved.heightCm) && saved.heightCm >= 80 && saved.heightCm <= 230
    && ['SideBySide','TempoPartner'].includes(saved.mode) && typeof saved.showTrack === 'boolean') {
    draft = { paceSeconds:saved.paceSeconds,heightCm:saved.heightCm,mode:saved.mode,showTrack:saved.showTrack };
  }
} catch { /* Invalid saved settings fall back to project defaults. */ }
let state = { headsetConnected: false, telemetry: {}, registry: null }, connected = false, activeTab = 'treadmill', socket, reconnectDelay = 500, noticeTimer;
const tabs = [
  ['treadmill','◎','Laufband','Pace und Begleiter für deine nächste Session vorbereiten.'],
  ['sensors','♡','Sensoren & Session','Sensordaten beobachten und Sessions auf dem Server verwalten.'],
  ['markers','◇','Marker & Platzierung','Den separaten Marker-Ablauf von MarkerML2 im Blick behalten.']
];
const logs = [];
const paceText = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2,'0')}`;
function log(kind, data) {
  logs.push({time:new Date().toLocaleTimeString('de-DE'),kind,data});
  if(logs.length > 200) logs.shift();
  $('#log').innerHTML=logs.map(e=>`<div class="log-entry ${escape(e.kind)}"><time>${e.time} / ${escape(e.kind.toUpperCase())}</time>${escape(typeof e.data==='string'?e.data:JSON.stringify(e.data))}</div>`).join('');
  if($('#autoscroll').checked) $('#log').scrollTop=$('#log').scrollHeight;
}
function notice(message) { $('#notice').textContent=message;$('#notice').hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{$('#notice').hidden=true;},6500); }
async function api(path,data) {
  const response=await fetch('/api/'+path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result=await response.json(); if(!response.ok) throw new Error(result.error || `HTTP ${response.status}`); return result;
}
function card(title,content,wide=false,tag='') {return `<article class="card ${wide?'wide':''}"><div class="card-heading"><h2>${title}</h2>${tag?`<span class="pill">${tag}</span>`:''}</div>${content}</article>`;}
function metric(label,value,unit='') {return `<div class="metric"><small>${label}</small><strong>${escape(value??'—')}</strong><span>${unit}</span></div>`;}
function unavailable(text) {return `<button disabled title="Die Fernsteuerung wird erst mit der Unity-Anbindung verfügbar.">${text}</button>`;}
function modeName(mode) {return mode==='SideBySide'?'Side by Side':'Tempo-Partner';}
function treadmill() {
  return `<div class="project-note wide"><span class="project-note-icon">◈</span><div><strong>MarkerML2 · Serversteuerung</strong><p>Konfiguration an die verbundene Brille senden und den Lauf vom Server aus steuern.</p></div><span class="pill">FERNSTEUERUNG</span></div>`
  + card('Session konfigurieren',`<form id="settings-form"><div class="row"><label>Zielpace · min/km<input id="pace" value="${paceText(draft.paceSeconds)}" inputmode="text" autocomplete="off" required aria-describedby="pace-hint"><small id="pace-hint">3:00 bis 20:00 min/km</small></label><label>Körpergröße · cm<input id="height" type="number" value="${draft.heightCm}" min="80" max="230" step="1" inputmode="numeric" required></label></div><label>Laufmodus</label><div class="mode-picker" role="group" aria-label="Laufmodus"><button type="button" data-mode="SideBySide" aria-pressed="${draft.mode==='SideBySide'}"><span>↔</span><strong>Side by Side</strong><small>Begleiter neben dir</small></button><button type="button" data-mode="TempoPartner" aria-pressed="${draft.mode==='TempoPartner'}"><span>↗</span><strong>Tempo-Partner</strong><small>Gegen deine beste Runde</small></button></div><label class="track-switch"><input type="checkbox" id="show-track" ${draft.showTrack?'checked':''}><span><strong>Rennstrecke anzeigen</strong><small>Ausblenden der Strecke hält die Simulation nicht an.</small></span></label><div class="buttons"><button type="submit" class="primary">Lokal speichern</button><button type="button" id="send-settings">An Brille senden</button><button type="button" id="reset-settings">Zurücksetzen</button></div><p class="help" id="save-state">Nur auf diesem Gerät · noch nicht an die Brille gesendet</p></form>`,false,'LOKAL')
  + card('Deine Laufvorschau',`<div class="metric-grid setup-metrics" id="setup-metrics"></div><div class="treadmill-preview"><svg viewBox="0 0 400 150" role="img" aria-label="Schematische Vorschau der virtuellen 400-Meter-Bahn"><g id="preview-route"><rect x="40" y="20" width="320" height="110" rx="55" fill="#e7edda" stroke="#a8bb90"/><rect x="49" y="29" width="302" height="92" rx="46" fill="none" stroke="#fff"/><rect x="58" y="38" width="284" height="74" rx="37" fill="none" stroke="#fff"/><rect x="67" y="47" width="266" height="56" rx="28" fill="none" stroke="#fff"/></g><circle cx="200" cy="121" r="6" fill="#366c50" stroke="white" stroke-width="2"/><circle id="preview-partner" cx="230" cy="121" r="6" fill="#acc764" stroke="white" stroke-width="2"/><text x="200" y="72" text-anchor="middle" fill="#61774f" font-size="10" letter-spacing="2">400 M · VIRTUELLE RUNDE</text><text x="200" y="90" text-anchor="middle" fill="#849477" font-size="9">KONFIGURATIONSVORSCHAU</text></svg></div><p id="mode-description" class="help"></p><p class="help">Beim Laufbandtraining läuft die virtuelle Strecke an dir vorbei. Die Vorschau zeigt deine Konfiguration, keine Live-Position.</p>`,false,'VORSCHAU')
  + card('Laufsteuerung',`<div class="buttons"><button data-run="start" class="primary">Lauf starten</button><button data-run="pause">Pause</button><button data-run="resume">Weiter</button><button data-run="stop">Stoppen</button><button data-run="reset">Lauf zurücksetzen</button></div><p class="help">Die Brille bestätigt jeden Befehl. Bei Verbindungsabbruch pausiert der Lauf.</p>`,true)
  + card('Live-Status','<div class="metric-grid" id="treadmill-metrics"></div><p class="help">Live-Werte erscheinen erst, wenn MarkerML2 seine Laufband-Telemetrie liefert.</p>',true,'HEADSET');
}
function sensors() {
  return card('BLE-Sensordaten','<div class="metric-grid" id="ble-metrics"></div><p class="help">MarkerML2 verwendet ein profilbasiertes BLE-Paket, unter anderem für Herzfrequenz, Temperatur und SpO₂. Hier erscheinen ausschließlich vom Headset übertragene Werte.</p><div class="buttons">'+unavailable('Sensor suchen')+unavailable('Verbinden')+unavailable('Trennen')+'</div>',true,'HEADSET')
  + card('Server-Session',`<label>Sessionname<input id="session-name" placeholder="Laufbandtraining" maxlength="200"></label><p id="session-state" class="help"></p><div class="buttons"><button id="session-start" class="primary">Session anlegen</button><button id="session-stop">Session beenden</button></div><p class="help">Diese Session verwaltet die Aufzeichnung auf dem Server. Sie startet keinen Lauf in Unity.</p>`)
  + card('Aufzeichnung',`<p id="recording-state" class="help"></p><div class="buttons"><button id="recording-start" class="primary">● Aufnahme starten</button><button id="recording-stop">Aufnahme stoppen</button></div><p class="help">CSV und JSONL werden auf dem Server gespeichert. Ohne übertragene Sensordaten bleibt die Aufnahme leer.</p>`);
}
function markers() {
  return `<div class="project-note wide"><span class="project-note-icon">◇</span><div><strong>Separater Ablauf · AprilTags & Bodenflächen</strong><p>Die Marker-Platzierung gehört zu einem eigenen Ablauf in MarkerML2. Sie ist unabhängig vom automatischen Start der Laufbandwelt.</p></div></div>`
  + card('Automatische Laufbandplatzierung',`<ol class="placement-steps"><li><strong>Körpergröße einstellen</strong><span>Die Größe dient als Grundlage für die automatische Höhenplatzierung.</span></li><li><strong>Headtracking abwarten</strong><span>Die Welt richtet sich am getrackten Blick und der berechneten Bodenhöhe aus.</span></li><li><strong>Begleiter erscheint</strong><span>Der Avatar wird erst nach Platzierung und bestätigter Höhe erzeugt.</span></li></ol>`)
  + card('Marker- und Avatarablauf',`<ol class="placement-steps"><li><strong>AprilTags erkennen</strong><span>Marker und räumliche Anker werden auf der Magic Leap 2 ausgewertet.</span></li><li><strong>Bodenfläche bestätigen</strong><span>Der Avatar wird auf einer bestätigten Fläche platziert.</span></li><li><strong>Verankerte Route verwenden</strong><span>Die Stadionvorschau und Laufwerte gehören zum platzierten Runner.</span></li></ol>`)
  + card('Platzierungsstatus','<div class="metric-grid" id="placement-metrics"></div><p class="help">Die Seite löst aktuell weder eine Kalibrierung aus noch verschiebt sie Marker oder Anker im Unity-Projekt.</p>',true,'HEADSET');
}
const renderers={treadmill,sensors,markers};
function render() {
  const tab=tabs.find(t=>t[0]===activeTab);
  $('#page-title').textContent=tab[2];$('#page-description').textContent=tab[3];
  $('#navigation').innerHTML=tabs.map(t=>`<button data-tab="${t[0]}" class="${activeTab===t[0]?'active':''}" ${activeTab===t[0]?'aria-current="page"':''} title="${t[2]}"><span class="nav-icon">${t[1]}</span><span class="nav-text">${t[2]}</span></button>`).join('');
  $('#content').innerHTML=renderers[activeTab]();bind();updateLive();window.scrollTo({top:0,behavior:'instant'});
}
function readDraft() {
  const text=$('#pace').value.trim(), match=/^(\d{1,2}):([0-5]\d)$/.exec(text);
  const paceSeconds=match?Number(match[1])*60+Number(match[2]):NaN;
  const pace=$('#pace');pace.setCustomValidity(Number.isInteger(paceSeconds)&&paceSeconds>=180&&paceSeconds<=1200?'':'Pace zwischen 3:00 und 20:00 als mm:ss eingeben.');
  if(!pace.checkValidity()) return null;
  if(!$('#height').checkValidity()) return null;
  return {paceSeconds,heightCm:Number($('#height').value),mode:draft.mode,showTrack:$('#show-track').checked};
}
function drawPreview(settings) {
  if(!$('#setup-metrics')) return;
  $('#setup-metrics').innerHTML=metric('ZIELPACE',paceText(settings.paceSeconds),'min/km')+metric('TEMPO',(3600/settings.paceSeconds).toFixed(1),'km/h')+metric('400-M-RUNDE',paceText(Math.round(settings.paceSeconds*.4)),'min');
  $('#preview-route').setAttribute('opacity',settings.showTrack?'1':'.12');
  $('#preview-partner').setAttribute('cx',settings.mode==='SideBySide'?'200':'245');
  $('#preview-partner').setAttribute('cy',settings.mode==='SideBySide'?'108':'121');
  $('#mode-description').textContent=settings.mode==='SideBySide'?'Side by Side: Der Begleiter bleibt neben der Laufposition und übernimmt das Tempo der Laufbandwelt.':'Tempo-Partner: Der Ghost folgt der besten aufgezeichneten Runde. Ohne Aufnahme verwendet das Projekt die Zielpace.';
}
function on(id,fn) {const el=$('#'+id);if(el) el.onclick=async()=>{try{await fn();}catch(e){notice(e.message);log('error',e.message);}};}
function bind() {
  if($('#settings-form')) {
    $('#settings-form').onsubmit=e=>{
      e.preventDefault();const next=readDraft();
      if(!next) {$('#settings-form').reportValidity();return;}
      try {localStorage.setItem('markerML2.settings',JSON.stringify(next));draft=next;$('#save-state').textContent='✓ Lokal gespeichert · noch nicht an die Brille gesendet';drawPreview(draft);notice('Einstellungen lokal gespeichert. Die Unity-Anbindung folgt.');}
      catch {notice('Speichern ist in diesem Browser nicht verfügbar.');}
    };
    for(const id of ['pace','height','show-track']) $('#'+id).oninput=()=>{const next=readDraft();if(next){draft=next;drawPreview(draft);}$('#save-state').textContent='Nicht gespeicherter Entwurf · nur auf diesem Gerät';};
    document.querySelectorAll('[data-mode]').forEach(el=>el.onclick=()=>{
      draft.mode=el.dataset.mode;document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b===el)));
      drawPreview(draft);$('#save-state').textContent='Nicht gespeicherter Entwurf · nur auf diesem Gerät';
    });
    on('reset-settings',()=>{draft={...defaults};localStorage.removeItem('markerML2.settings');render();});
    drawPreview(draft);
  }
  on('send-settings',async()=>{
    const next=readDraft();if(!next){$('#settings-form').reportValidity();return;}
    await api('command',{commandType:'runningMate.configure',commandPayload:next});
    $('#save-state').textContent='An Brille gesendet · Bestätigung siehe Befehlsstatus';
  });
  document.querySelectorAll('[data-run]').forEach(button=>button.onclick=async()=>{
    try {await api('command',{commandType:'runningMate.command',commandPayload:{action:button.dataset.run}});}
    catch(e){notice(e.message);}
  });
  for(const [id,path,getData] of [['session-start','session/start',()=>({name:$('#session-name').value})],['session-stop','session/stop',()=>({})],['recording-start','recording/start',()=>({})],['recording-stop','recording/stop',()=>({})]]) on(id,async()=>{await api(path,getData());});
}
function liveBool(value) {return typeof value==='boolean'?(value?'Bestätigt':'Offen'):'—';}
function updateLive() {
  const t=state.telemetry||{}, run=t.treadmill||{}, isML2=state.headsetConnected&&state.registry?.project==='MarkerML2';
  document.querySelectorAll('[data-run],#send-settings').forEach(button=>button.disabled=!isML2);
  const indicators=[['Server',connected],['Headset',state.headsetConnected],['MarkerML2',isML2],['BLE',state.headsetConnected&&t.ble?.connected],['REC',state.recording]];
  $('#indicators').innerHTML=indicators.map(([name,on])=>`<span class="indicator"><i class="dot ${on?'on':''}"></i>${name}</span>`).join('');
  $('#device-state').textContent=state.headsetConnected?(state.device?.simulated?'● Simulator · Testdaten':'● Verbunden'):'○ Nicht verbunden';
  $('.live-tag').innerHTML=`<span></span> ${state.device?.simulated?'SIMULATOR · TESTDATEN':'MAGIC LEAP 2'}`;
  $('#ack').textContent=state.lastAck?`${state.lastAck.success?'✓':'✕'} ${state.lastAck.commandType||'Befehl'}${state.lastAck.error?' · '+state.lastAck.error:''}`:'Headset-Steuerung noch nicht angebunden';
  if($('#treadmill-metrics')) $('#treadmill-metrics').innerHTML=metric('LAUFSTATUS',isML2?run.state:null)+metric('DISTANZ',isML2?run.distance:null,'m')+metric('ZEIT',isML2?run.elapsed:null,'s')+metric('RUNDEN',isML2?run.laps:null)+metric('MODUS',isML2&&run.mode?modeName(run.mode):null)+metric('TEMPO',isML2?run.speedKmh:null,'km/h');
  if($('#placement-metrics')) $('#placement-metrics').innerHTML=metric('HEADTRACKING',isML2?liveBool(run.headPoseReady):null)+metric('HÖHE',isML2?liveBool(run.heightConfirmed):null)+metric('PLATZIERUNG',isML2?liveBool(run.placementReady):null);
  if($('#ble-metrics')) {const b=t.ble||{};$('#ble-metrics').innerHTML=metric('HERZFREQUENZ',state.headsetConnected?b.hr:null,'BPM')+metric('TEMPERATUR',state.headsetConnected?b.temperature:null,'°C')+metric('SpO₂',state.headsetConnected?b.spo2:null,'%')+metric('PULS',state.headsetConnected?b.pr:null,'BPM')+metric('PERFUSION INDEX',state.headsetConnected?b.pi:null,'%')+metric('SENSOR',state.headsetConnected&&b.connected?'Verbunden':'Offline');}
  if($('#session-state')) {
    $('#session-state').textContent=state.session?`Aktiv: ${state.session.name}`:'Keine Server-Session aktiv';
    $('#session-start').disabled=!connected||!!state.session;$('#session-stop').disabled=!connected||!state.session||!!state.recording;
    $('#recording-state').textContent=state.recording?`Aufnahme läuft · ${state.recording.id}`:'Keine Aufnahme aktiv';
    $('#recording-start').disabled=!connected||!!state.recording;$('#recording-stop').disabled=!connected||!state.recording;
  }
}
function connect() {
  socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws`);
  socket.onopen=()=>{connected=true;reconnectDelay=500;socket.send(JSON.stringify({type:'hello',role:'dashboard'}));log('connection','Dashboard verbunden');updateLive();};
  socket.onmessage=event=>{
    try {
      const m=JSON.parse(event.data);
      if(m.type==='status') {state=m;updateLive();}
      else if(m.type==='registry') {state.registry=m.data;updateLive();log('registry','Headset-Katalog aktualisiert');}
      else if(m.type==='telemetry') {state.telemetry=m.data;updateLive();}
      else if(m.type==='ack') {state.lastAck=m;updateLive();log(m.success?'ack':'error',m);}
      else if(m.type==='command') log('command',m.command);
      else if(m.type==='error') {notice(m.message);log('error',m.message);}
    } catch {log('error','Ungültige Servernachricht');}
  };
  socket.onclose=()=>{connected=false;state.headsetConnected=false;updateLive();log('connection','Verbindung unterbrochen · erneuter Versuch');setTimeout(connect,reconnectDelay);reconnectDelay=Math.min(reconnectDelay*2,10000);};
  socket.onerror=()=>socket.close();
}
function setLogCollapsed(collapsed) {$('.workspace').classList.toggle('log-collapsed',collapsed);$('#toggle-log').textContent=collapsed?'Log anzeigen':'Log ausblenden';$('#toggle-log').setAttribute('aria-expanded',String(!collapsed));}
setLogCollapsed(localStorage.getItem('logExpanded')!=='true');
$('#toggle-log').onclick=()=>{const collapsed=!$('.workspace').classList.contains('log-collapsed');setLogCollapsed(collapsed);localStorage.setItem('logExpanded',String(!collapsed));};
$('#navigation').onclick=e=>{const b=e.target.closest('[data-tab]');if(b){activeTab=b.dataset.tab;render();}};
$('#clear-log').onclick=()=>{logs.length=0;$('#log').innerHTML='';};
$('#copy-log').onclick=async()=>{try{await navigator.clipboard.writeText(logs.map(l=>`${l.time} ${l.kind} ${typeof l.data==='string'?l.data:JSON.stringify(l.data)}`).join('\n'));notice('Log kopiert.');}catch{notice('Zwischenablage im Browser nicht verfügbar.');}};
$('#server-address').textContent=location.host;
render();connect();
