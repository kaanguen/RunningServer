const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let userSpeedDraft={source:'FixedTest',speedKmh:10},userSpeedPending=false,ghostSpeedPending=false;
const defaults = { paceSeconds: 360, mode: 'TempoPartner', showTrack: true };
let draft = { ...defaults };
try {
  const saved = JSON.parse(localStorage.getItem('markerML2.settings'));
  if (saved && Number.isInteger(saved.paceSeconds) && saved.paceSeconds >= 180 && saved.paceSeconds <= 1200
    && ['SideBySide','TempoPartner'].includes(saved.mode) && typeof saved.showTrack === 'boolean') {
    draft = { paceSeconds:saved.paceSeconds,mode:saved.mode,showTrack:saved.showTrack };
  }
} catch { /* Invalid saved settings fall back to project defaults. */ }
let lastTelemetryAt = 0;
let state = { headsetConnected: false, telemetry: {}, registry: null }, connected = false, activeTab = 'treadmill', socket, reconnectDelay = 500, noticeTimer;
const tabs = [
  ['treadmill','◎','Laufband','Pace und Begleiter für deine nächste Session vorbereiten.'],
  ['sensors','♡','Sensoren & Session','Sensordaten beobachten und Sessions auf dem Server verwalten.'],
  ['markers','◇','Kalibrierung','Avatar platzieren und die Laufwelt ausrichten.']
];
const logs = [];
let calibrationPending = false, runPending = false, settingsPending = false;
let settingsFeedback = 'Änderungen erst auf die Brille anwenden. Speichern behält sie nur auf diesem Gerät.';
const commandAcks = new Map(), commandWaiters = new Map();
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
async function confirmedCommand(commandType,commandPayload) {
  const result=await api('command',{commandType,commandPayload});
  const ack=commandAcks.get(result.commandId)||await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{commandWaiters.delete(result.commandId);reject(new Error('Keine Bestätigung der Brille.'));},12000);
    commandWaiters.set(result.commandId,m=>{clearTimeout(timer);resolve(m);});
  });
  if(!ack.success) throw new Error(ack.error||'Befehl abgelehnt.');
  return ack;
}
async function calibrate(command,payload) {
  if(calibrationPending)return;
  calibrationPending=true;updateLive();
  try {if(command!=='runningMate.command'&&state.telemetry?.treadmill?.state==='Running')await confirmedCommand('runningMate.command',{action:'pause'});await confirmedCommand(command,payload);notice('Änderung von der Brille bestätigt · Lauf bleibt pausiert.');}
  catch(e){notice(e.message);}
  finally {calibrationPending=false;updateLive();}
}
const cardStyles = {'Session konfigurieren':'config','Deine Laufvorschau':'preview','Nutzertempo · Test oder Laufband':'user','Laufsteuerung':'run','Live auf der 400-m-Bahn':'track','Ghost-Geschwindigkeit testen':'ghost','Deine Rekordzeiten':'records','Live-Status':'status','Laufumgebung':'environment','Avatar-Bahn · beide Modi':'lane','Neu ausrichten':'realign','Bodenhöhe aus erkannter Plane':'floor'};
function card(title,content,wide=false,tag='') {return `<article class="card ${wide?'wide':''} ${cardStyles[title]?'card-'+cardStyles[title]:''}"><div class="card-heading"><h2>${title}</h2>${tag?`<span class="pill">${tag}</span>`:''}</div>${content}</article>`;}
function metric(label,value,unit='') {return `<div class="metric"><small>${label}</small><strong>${escape(value??'—')}</strong><span>${unit}</span></div>`;}
async function changeEnvironment(environment) {
  if(state.telemetry?.treadmill?.environment===environment)return;
  if(!window.confirm('Laufumgebung wechseln? Eine neue Session beginnt; Laufstatistik und Rekorde werden zurückgesetzt. Der Lauf bleibt pausiert.'))return;
  await calibrate('scene.setTrackEnvironment',{environment});
}
function modeName(mode) {return mode==='SideBySide'?'Side by Side':'Tempo-Partner';}
function treadmill() {
  return `<div class="project-note wide"><span class="project-note-icon">◈</span><div><strong>MarkerML2 · Serversteuerung</strong><p>Konfiguration an die verbundene Brille senden und den Lauf vom Server aus steuern.</p></div><span class="pill">FERNSTEUERUNG</span></div>`
  + card('Session konfigurieren',`<form id="settings-form"><div class="row"><label>Zieltempo des Begleiters · min/km<input id="pace" value="${paceText(draft.paceSeconds)}" inputmode="text" autocomplete="off" required aria-describedby="pace-hint"><small id="pace-hint">3:00 bis 20:00 min/km</small></label></div><label>Gewählter Laufmodus</label><div class="mode-picker" role="group" aria-label="Laufmodus"><button type="button" data-mode="SideBySide" aria-pressed="${draft.mode==='SideBySide'}"><span>↔</span><strong>Side by Side</strong><small>Läuft neben dir</small></button><button type="button" data-mode="TempoPartner" aria-pressed="${draft.mode==='TempoPartner'}"><span>↗</span><strong>Tempo-Partner</strong><small>Folgt deiner besten Runde</small></button></div><label class="track-switch"><input type="checkbox" id="show-track" ${draft.showTrack?'checked':''}><span><strong>Rennstrecke anzeigen</strong><small>Wird mit „Auf Brille anwenden“ übernommen.</small></span></label><div class="buttons"><button type="submit" class="primary">Auf diesem Gerät speichern</button><button type="button" id="send-settings">Auf Brille anwenden</button><button type="button" id="reset-settings">Einstellungen zurücksetzen</button></div><p class="help" id="save-state">${escape(settingsFeedback)}</p></form>`,false,'LOKAL')
  + card('Deine Laufvorschau',`<div class="metric-grid setup-metrics" id="setup-metrics"></div><div class="treadmill-preview"><svg viewBox="0 0 400 150" role="img" aria-label="Schematische Vorschau der virtuellen 400-Meter-Bahn"><g id="preview-route"><rect x="40" y="20" width="320" height="110" rx="55" fill="#202b3b" stroke="#536b8d"/><rect x="49" y="29" width="302" height="92" rx="46" fill="none" stroke="#899bb5"/><rect x="58" y="38" width="284" height="74" rx="37" fill="none" stroke="#899bb5"/><rect x="67" y="47" width="266" height="56" rx="28" fill="none" stroke="#899bb5"/></g><circle cx="200" cy="121" r="6" fill="#409cff" stroke="white" stroke-width="2"/><circle id="preview-partner" cx="230" cy="121" r="6" fill="#f09665" stroke="white" stroke-width="2"/><text x="200" y="72" text-anchor="middle" fill="#b1bfd2" font-size="10" letter-spacing="2">400 M · VIRTUELLE RUNDE</text><text x="200" y="90" text-anchor="middle" fill="#9baac1" font-size="9">KONFIGURATIONSVORSCHAU</text></svg></div><p id="mode-description" class="help"></p><p class="help">Beim Laufbandtraining läuft die virtuelle Strecke an dir vorbei. Die Vorschau zeigt deine Konfiguration, keine Live-Position.</p>`,false,'VORSCHAU')
  + card('Nutzertempo · Test oder Laufband',`<form id="user-speed-form"><div class="row"><label>Geschwindigkeitsquelle<select id="user-speed-source"><option value="FixedTest" ${userSpeedDraft.source==='FixedTest'?'selected':''}>Test · feste km/h</option><option value="Treadmill" ${userSpeedDraft.source==='Treadmill'?'selected':''}>Laufband · Sensordaten</option></select></label><label>Deine simulierte Geschwindigkeit · km/h<input id="user-speed-value" type="number" min="0" max="100" step="any" value="${userSpeedDraft.speedKmh}" inputmode="decimal" required ${userSpeedDraft.source==='Treadmill'?'disabled':''}></label></div><button id="user-speed-apply" class="primary" type="submit">Dein Tempo anwenden</button></form><div id="user-speed-metrics" class="metric-grid"></div><p id="user-speed-status" class="help" role="status"></p><p class="help">Testtempo simuliert deine Geschwindigkeit unabhängig vom Ghost. Im Laufbandmodus bleibst du körperlich stehen; die virtuelle Welt folgt später den gemessenen Laufband-km/h. Ohne aktuelle Laufbanddaten bleibt das Tempo bei 0. Die Hardware-Anbindung ist noch nicht implementiert. Quelle und feste Test-km/h lassen sich während des Laufs ändern, ohne den Avatar anzuhalten. Für eine echte Stadionbahn bleibt Headtracking maßgeblich.</p>`,true,'NUTZER')
  + card('Laufsteuerung',`<div class="buttons"><button data-run="start" class="primary">Lauf starten</button><button data-run="pause">Pause</button><button data-run="resume">Fortsetzen</button><button data-run="stop">Stoppen</button><button data-run="reset">Laufdaten zurücksetzen</button></div><p id="run-feedback" class="help" role="status"></p><p class="help">Die Brille bestätigt jeden Befehl. Bei Verbindungsabbruch pausiert der Lauf.</p>`,true)
  + card('Live auf der 400-m-Bahn',`<div class="live-track-wrap"><svg id="live-track" viewBox="0 0 400 210" role="img" aria-label="Live-Positionen auf der virtuellen Laufbahn"><path id="live-route" d="M275 45 A60 60 0 0 1 275 165 L125 165 A60 60 0 0 1 125 45 Z" fill="#202b3b" stroke="#536b8d" stroke-width="22"/><path d="M275 45 A60 60 0 0 1 275 165 L125 165 A60 60 0 0 1 125 45 Z" fill="none" stroke="#899bb5" stroke-width="1.5"/><line x1="275" y1="31" x2="275" y2="59" stroke="#b1bfd2" stroke-width="2"/><text x="200" y="99" text-anchor="middle" fill="#b1bfd2" font-size="13">400 m</text><text id="live-track-state" x="200" y="119" text-anchor="middle" fill="#b1bfd2" font-size="10">Warte auf Live-Daten</text><circle id="live-ghost" r="10" fill="#f09665" stroke="#899bb5" stroke-width="2" hidden/><circle id="live-user" r="5" fill="#409cff" stroke="#899bb5" stroke-width="2" hidden/></svg></div><div class="track-legend"><span><i class="user-dot"></i>Du</span><span><i class="ghost-dot"></i>Ghost</span><span id="live-freshness">Keine Positionsdaten</span></div><div class="metric-grid" id="ghost-metrics"></div><p class="help">Virtuelle Positionen entlang der Bahn, keine GPS-Ortung. Aktualisierung durch die Brille.</p>`,true,'LIVE')
  + card('Ghost-Geschwindigkeit testen',`<form id="ghost-speed-form"><label for="ghost-speed">Testgeschwindigkeit · km/h</label><div class="ghost-speed-controls"><input id="ghost-speed" type="number" min="0" step="any" value="10" inputmode="decimal" required><button id="ghost-speed-apply" type="submit" class="primary">Testtempo übernehmen</button><button id="ghost-speed-auto" type="button">Zurück zur Bestzeit</button></div></form><p id="ghost-mode-status" class="help" role="status">Warte auf Ghost-Telemetrie.</p><p class="help">Im Testmodus bewegt sich der Ghost mit deinem Testtempo unabhängig von der Bestzeit. 0 km/h hält ihn an. Pause und Stoppen pausieren auch den Ghost. Aufgezeichnete Bestzeiten bleiben erhalten.</p>`,true,'TESTMODUS')
  + card('Deine Rekordzeiten',`<div class="metric-grid" id="record-metrics"></div><p id="record-status" class="help" role="status"></p><p class="help">Gemessene Bestzeiten dieser App-Session. Zielpace und Beispielzeiten zählen nicht als Rekord. Nur „Laufdaten zurücksetzen“, ein Umgebungswechsel oder ein App-Neustart löschen diese Werte. Änderungen an Pace, Modus und Bahnsichtbarkeit erhalten die Bestzeit.</p>`,true,'BESTZEITEN')
  + card('Live-Status' ,'<div class="metric-grid" id="treadmill-metrics"></div><p class="help">Live-Werte erscheinen erst, wenn MarkerML2 seine Laufband-Telemetrie liefert.</p>',true,'HEADSET');
}
function sensors() {
  return card('BLE-Sensordaten','<div class="metric-grid" id="ble-metrics"></div><p class="help">MarkerML2 verwendet ein profilbasiertes BLE-Paket, unter anderem für Herzfrequenz, Temperatur und SpO₂. Hier erscheinen ausschließlich vom Headset übertragene Werte.</p><p class="help">Die Sensorverbindung wird am Headset eingerichtet.</p>',true,'HEADSET')
  + card('Server-Session',`<label>Sessionname<input id="session-name" placeholder="Laufbandtraining" maxlength="200"></label><p id="session-state" class="help"></p><div class="buttons"><button id="session-start" class="primary">Session anlegen</button><button id="session-stop">Session beenden</button></div><p class="help">Diese Session verwaltet die Aufzeichnung auf dem Server. Sie startet keinen Lauf in Unity.</p>`)
  + card('Aufzeichnung',`<p id="recording-state" class="help"></p><div class="buttons"><button id="recording-start" class="primary">● Aufnahme starten</button><button id="recording-stop">Aufnahme stoppen</button></div><p class="help">CSV und JSONL werden auf dem Server gespeichert. Ohne übertragene Sensordaten bleibt die Aufnahme leer.</p>`);
}
function markers() {
  return `<div class="project-note wide"><span class="project-note-icon">◇</span><div><strong>Kalibrierung & Avatar-Platzierung</strong><p>Kalibrierungsaktionen pausieren einen laufenden Lauf automatisch. Bahn und Avatar werden am Bodenmarker platziert; die Höhe kommt aus der erkannten Plane. Distanz, Laufzeit und Ghost-Aufnahme bleiben bei diesen Korrekturen erhalten.</p></div></div>`
  + card('Kalibrierungsstatus',`<div class="metric-grid" id="placement-metrics"></div><p id="calibration-status" class="help" role="status">Warte auf Brille.</p><p id="marker-placement-status" class="help" role="status"></p><button id="calibration-pause">Lauf zum Kalibrieren pausieren</button>`,true,'HEADSET')
  + card('Laufumgebung',`<div class="buttons"><button id="environment-treadmill" data-cal-command="scene.setTrackEnvironment">Laufband · bewegte Welt</button><button id="environment-stadium" data-cal-command="scene.setTrackEnvironment">Echte 400-m-Bahn · feste Welt</button></div><p id="track-environment-state" class="help" role="status"></p><p class="help">Ein Wechsel beginnt eine neue Session und setzt Laufstatistik und Rekorde zurück. Im Stadion bleibt die Welt stehen; dein Fortschritt kommt vom Headtracking. Der Lauf bleibt pausiert.</p>`,true)
  + card('Avatar-Bahn · beide Modi',`<form id="avatar-lane-form"><label for="avatar-lane">Bahn des Avatars<select id="avatar-lane">${Array.from({length:8},(_,i)=>`<option value="${i+1}" ${i===2?'selected':''}>Bahn ${i+1}</option>`).join('')}</select></label><button type="submit" class="primary" data-cal-command="runningMate.setLane">Avatar auf diese Bahn setzen</button></form><p id="avatar-lane-state" class="help" role="status"></p><p class="help">Direkt nach dem Öffnen der App erscheint der Avatar auf Bahn 3, sobald die Platzierung bereit ist – auch ohne Laufstart und in beiden Modi. Danach ändert diese Auswahl die Avatar-Bahn ohne seine Laufzeit oder Bestzeitaufnahme zurückzusetzen. Bahn 1 ist die 400-m-Referenz; äußere Bahnen sind länger.</p>`,true)
  + card('Stadionkalibrierung · zwei Punkte',`<ol class="placement-steps"><li><strong>Punkt A: gemeinsame Start-/Ziellinie auf Bahn 1</strong><span>Auf der Messlinie der innersten Bahn aufrecht stehen und Punkt A übernehmen. Zuerst einen Bodenmarker scannen. Die Bodenhöhe wird von der erkannten Plane übernommen.</span></li><li><strong>Punkt B: bekannte Strecke weiter auf Bahn 1</strong><span>In normaler Laufrichtung gegen den Uhrzeigersinn weitergehen. Die Strecke entlang der Messlinie ausmessen, auch durch die Kurve. Am gemessenen Punkt B übernehmen.</span></li><li><strong>Am Boden kontrollieren und feinjustieren</strong><span>Bahn einblenden. Ganze Bahn entlang und quer verschieben oder drehen. Die Bodenhöhe kommt aus der Plane. Bei falscher Grundausrichtung A und B erneut erfassen.</span></li></ol><label for="stadium-distance">Abstand A → B entlang Bahn 1 · m<input id="stadium-distance" type="number" min="5" max="100" step="any" value="20"></label><div class="buttons"><button id="stadium-point-a" data-cal-command="scene.captureTrackPoint">Punkt A hier übernehmen</button><button id="stadium-point-b" data-cal-command="scene.captureTrackPoint">Punkt B hier übernehmen</button><button id="calibration-show-track" data-cal-command="scene.setRunningMatePathVisible">Ganze Bahn anzeigen</button></div><p id="stadium-calibration-state" class="help" role="status"></p><p class="help">Der Abstand wird nicht automatisch vermessen. Die Einpassung verschiebt und dreht das vorhandene Standardoval, ohne es zu skalieren. Höhe und Feinausrichtung anschließend am realen Boden prüfen. Kalibrierung gilt für die laufende XR-Session.</p>`,true)
  + card('Sweet Spot · Side by Side',`<form id="placement-form"><div class="row"><label>Position<select id="placement-position"><option value="N">N · Vor dir</option><option value="NE">NE · Vorne rechts</option><option value="E" selected>E · Rechts</option><option value="SE">SE · Hinten rechts</option><option value="S">S · Hinter dir</option><option value="SW">SW · Hinten links</option><option value="W">W · Links</option><option value="NW">NW · Vorne links</option></select></label><label>Abstand · m<input id="placement-distance" type="number" value="2" min="0.5" max="20" step="any" required></label></div><label>Blickrichtung<select id="placement-facing"><option value="FaceUser">Zu dir</option><option value="BackToUser">Von dir weg</option><option value="LeftShoulder">Linke Schulter zu dir</option><option value="RightShoulder">Rechte Schulter zu dir</option></select></label><p id="placement-mode-hint" class="help" role="status"></p><button type="submit" class="primary" data-cal-command="avatar.configurePlacement">Platzierung übernehmen</button></form><p class="help">Position relativ zur kalibrierten Laufrichtung. Gilt für den Side-by-Side-Avatar; der Ghost behält seine Position auf der Bahn. Kein automatisches Folgen.</p>`)
  + card('Sweet-Spot-Vorschau',`<svg id="sweet-spot-diagram" viewBox="0 0 280 230" role="img" aria-label="Vorschau des gewählten Avatar-Sweet-Spots"><circle cx="140" cy="112" r="75" fill="#20242c" stroke="#536b8d" stroke-dasharray="4 4"/><path d="M140 25V200 M45 112H235" stroke="#475569"/><text x="140" y="14" text-anchor="middle" fill="#b1bfd2" font-size="11">VORNE · N</text><text x="252" y="116" fill="#b1bfd2" font-size="11">E</text><text x="15" y="116" fill="#b1bfd2" font-size="11">W</text><text x="140" y="217" text-anchor="middle" fill="#b1bfd2" font-size="11">HINTEN · S</text><circle cx="140" cy="112" r="9" fill="#409cff"/><path d="M140 97l-5 7h10z" fill="#409cff"/><circle id="sweet-avatar" r="11" fill="#f09665"/><path id="sweet-facing" d="M0 -17l-5 8h10z" fill="#b1bfd2"/></svg><p id="sweet-preview-label" class="help"></p><p id="placement-applied" class="help">Noch keine bestätigte Platzierung.</p>`,false,'VORSCHAU')
  + card('Neu ausrichten',`<div class="buttons"><button class="primary" id="recalibrate-world" data-cal-command="scene.rescanMarker">Bodenmarker neu scannen</button><button id="reposition-avatar" data-cal-command="avatar.reposition">Auf aktuellen Blick neu ausrichten</button></div><p class="help">Neu scannen blendet Bahn und Avatar aus, bis wieder ein Bodenmarker auf einer bestätigten Bodenfläche erkannt wird. Die Blickausrichtung verwendet die bereits erkannte Bodenfläche. Keine Körpergrößen- oder Augenhöhenangabe nötig.</p>`,true)
  + card('Feinausrichtung der Laufwelt',`<div class="calibration-nudges">${[['along','Entlang der Bahn','m',[-1,-.1,-.01,.01,.1,1]],['across','Quer zur Bahn','m',[-1,-.1,-.01,.01,.1,1]],['heading','Drehung','°',[-1,-.5,.5,1]]].map(([axis,label,unit,steps])=>`<div><strong>${label}</strong><div class="buttons">${steps.map(step=>`<button data-cal-command="runningMate.adjust" data-nudge-axis="${axis}" data-nudge="${step}">${step>0?'+':''}${unit==='m'?(Math.abs(step)>=1?step:Math.round(step*100)):step}${unit==='m'?(Math.abs(step)>=1?' m':' cm'):'°'}</button>`).join('')}</div></div>`).join('')}</div><form id="track-offsets-form"><div class="row"><label>Entlang · m<input id="track-offset-along" type="number" min="-100" max="100" step="any" value="0" required></label><label>Quer · m<input id="track-offset-across" type="number" min="-100" max="100" step="any" value="0" required></label><label>Drehung · Grad<input id="track-offset-heading" type="number" min="-180" max="180" step="any" value="0" required></label></div><button type="submit" data-cal-command="runningMate.adjust">Gesamte Bahn auf diese Versätze setzen</button></form><p class="help">Absolute Werte ab der letzten Kalibrierung; 0 setzt den jeweiligen Versatz zurück.</p><p id="calibration-offsets" class="help">Warte auf bestätigte Versätze.</p><button id="calibration-reset" data-cal-command="runningMate.adjust">Feinversätze zurücksetzen</button><p class="help">Verschiebt die virtuelle Bahn und beide Laufpartner gemeinsam relativ zur letzten Kalibrierung.</p>`,true)
  + card('Bodenhöhe aus erkannter Plane',`<p id="calibration-height" class="help"></p><p class="help">Die Höhe von Bahn und Avatar stammt direkt aus der am Marker erkannten Bodenfläche. Keine manuelle Höhen- oder Körpergrößeneinstellung.</p>`,true,'PLANE');
}
function organizeLayout() {
  const content = $('#content');
  // Existing controls are moved, keeping IDs, forms and live data bindings intact.
  const group = (className, label, nodes) => {
    const section = document.createElement('section');
    section.className = className;
    section.setAttribute('aria-label', label);
    nodes.forEach(node => { if (node) section.append(node); });
    return section;
  };
  const fold = (node, label) => {
    if (!node) return;
    const details = document.createElement('details');
    details.className = 'compact-disclosure';
    const summary = document.createElement('summary');
    summary.textContent = label;
    const body = document.createElement('div');
    body.className = 'disclosure-body';
    while (node.firstChild) body.append(node.firstChild);
    body.querySelector('.card-heading')?.remove();
    details.append(summary, body);
    node.append(details);
    node.classList.add('folded-card');
  };
  if (activeTab === 'treadmill') {
    content.querySelector('.project-note')?.remove();
    const settings = group('settings-stack', 'Laufeinstellungen', [content.querySelector('.card-config'), content.querySelector('.card-user')]);
    const live = group('live-stack', 'Live-Lauf und Steuerung', [content.querySelector('.card-status'), content.querySelector('.card-track'), content.querySelector('.card-run')]);
    const records = content.querySelector('.card-records');
    const preview = content.querySelector('.card-preview');
    const ghost = content.querySelector('.card-ghost');
    fold(preview, 'Konfigurationsvorschau');
    fold(ghost, 'Ghost-Testtempo');
    const extras = group('extra-tools', 'Weitere Einstellungen', [preview, ghost]);
    live.append(records, extras);
    content.replaceChildren(settings, live);
    const send = $('#send-settings');
    send.classList.add('primary');
    $('#settings-form button[type="submit"]').classList.remove('primary');
    send.parentElement.prepend(send);
    content.querySelector('.card-status h2').textContent = 'Live-Lauf';
    content.querySelector('.card-track h2').textContent = '400-m-Bahn';
    content.querySelector('.card-user h2').textContent = 'Dein Tempo';
    content.querySelector('.card-config h2').textContent = 'Laufeinstellungen';
    content.querySelector('.card-records h2').textContent = 'Bestzeiten';
  }
  if (activeTab === 'markers') {
    const cards = [...content.querySelectorAll('.card')];
    const byTitle = title => cards.find(card => card.querySelector('h2')?.textContent === title);
    const placement = group('placement-pair', 'Avatar platzieren', [byTitle('Sweet Spot · Side by Side'), byTitle('Sweet-Spot-Vorschau')]);
    const guide=document.createElement('div');
    guide.className='calibration-guide';
    guide.innerHTML='<div class="calibration-steps" aria-label="Kalibrierungsablauf"><span data-step="marker">1 · Bodenmarker</span><span data-step="placement">2 · Platzierung</span><span data-step="track">3 · Stadion A/B</span><span data-step="ready">✓ Bereit</span></div><p id="calibration-next" role="status"></p>';
    byTitle('Kalibrierungsstatus').prepend(guide);
    const stadium = byTitle('Stadionkalibrierung · zwei Punkte');
    const fine = byTitle('Feinausrichtung der Laufwelt');
    fold(stadium, 'Stadionkalibrierung · zwei Punkte');
    fold(fine, 'Feinausrichtung der Laufwelt');
    content.replaceChildren(content.querySelector('.project-note'), byTitle('Kalibrierungsstatus'), byTitle('Laufumgebung'), byTitle('Avatar-Bahn · beide Modi'), placement, byTitle('Neu ausrichten'), byTitle('Bodenhöhe aus erkannter Plane'), stadium, fine);
  }
  // One shared explanation for the live area keeps the controls together.
  const liveArea = content.querySelector('.live-stack');
  if (liveArea) {
    const liveNotes = [...liveArea.querySelectorAll('.card-status > p.help:not([id]), .card-track > p.help:not([id]), .card-run > p.help:not([id])')];
    const runCard = liveArea.querySelector('.card-run');
    liveNotes.forEach(note => runCard.append(note));
  }
  // Keep live messages and consequential action notices visible; fold static explanations.
  content.querySelectorAll('.card').forEach(card => {
    if (card.classList.contains('card-environment')) return;
    const notes = [...card.querySelectorAll('p.help:not([id])')];
    if (!notes.length) return;
    const details = document.createElement('details');
    details.className = 'field-help';
    const summary = document.createElement('summary');
    summary.textContent = 'Hinweise';
    details.append(summary, ...notes);
    (card.querySelector('.disclosure-body') || card).append(details);
  });
}
const renderers={treadmill,sensors,markers};
function render() {
  const tab=tabs.find(t=>t[0]===activeTab);
  $('#page-title').textContent=tab[2];$('#page-description').textContent=tab[3];
  $('#navigation').innerHTML=tabs.map(t=>`<button data-tab="${t[0]}" class="${activeTab===t[0]?'active':''}" ${activeTab===t[0]?'aria-current="page"':''} title="${t[2]}"><span class="nav-icon">${t[1]}</span><span class="nav-text">${t[2]}</span></button>`).join('');
  $('#content').dataset.view=activeTab;
  $('#content').innerHTML=renderers[activeTab]();organizeLayout();bind();updateLive();window.scrollTo({top:0,behavior:'instant'});
}
function readDraft() {
  const text=$('#pace').value.trim(), match=/^(\d{1,2}):([0-5]\d)$/.exec(text);
  const paceSeconds=match?Number(match[1])*60+Number(match[2]):NaN;
  const pace=$('#pace');pace.setCustomValidity(Number.isInteger(paceSeconds)&&paceSeconds>=180&&paceSeconds<=1200?'':'Pace zwischen 3:00 und 20:00 als mm:ss eingeben.');
  if(!pace.checkValidity()) return null;
  return {paceSeconds,mode:draft.mode,showTrack:$('#show-track').checked};
}
function drawPreview(settings) {
  if(!$('#setup-metrics')) return;
  $('#setup-metrics').innerHTML=metric('GHOST-ZIELPACE',paceText(settings.paceSeconds),'min/km')+metric('GHOST-TEMPO',(3600/settings.paceSeconds).toFixed(1),'km/h')+metric('400-M-RUNDE',paceText(Math.round(settings.paceSeconds*.4)),'min');
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
      try {localStorage.setItem('markerML2.settings',JSON.stringify(next));draft=next;settingsFeedback='Auf diesem Gerät gespeichert · noch nicht auf die Brille angewendet.';$('#save-state').textContent=settingsFeedback;drawPreview(draft);notice('Auf diesem Gerät gespeichert. Zum Übernehmen auf die Brille anwenden.');}
      catch {notice('Speichern ist in diesem Browser nicht verfügbar.');}
    };
    for(const id of ['pace','show-track']) $('#'+id).oninput=()=>{const next=readDraft();if(next){draft=next;drawPreview(draft);}settingsFeedback='Änderungen noch nicht auf die Brille angewendet.';$('#save-state').textContent=settingsFeedback;};
    document.querySelectorAll('[data-mode]').forEach(el=>el.onclick=()=>{
      draft.mode=el.dataset.mode;document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b===el)));
      drawPreview(draft);settingsFeedback='Änderungen noch nicht auf die Brille angewendet.';$('#save-state').textContent=settingsFeedback;
    });
    on('reset-settings',()=>{if(!window.confirm('Gespeicherte Einstellungen auf diesem Gerät durch Standardwerte ersetzen? Der Lauf auf der Brille bleibt unverändert.'))return;draft={...defaults};localStorage.removeItem('markerML2.settings');settingsFeedback='Standardwerte geladen · noch nicht auf die Brille angewendet.';render();});
    drawPreview(draft);
  }
  on('send-settings',async()=>{
    if(settingsPending)return;
    const next=readDraft();if(!next){$('#settings-form').reportValidity();return;}
    if(!window.confirm('Einstellungen auf die Brille anwenden? Der Lauf wird pausiert. Laufdaten und die aufgezeichnete Bestzeit bleiben erhalten.'))return;
    const submitted=JSON.stringify(next);
    settingsPending=true;settingsFeedback='Wird angewendet · warte auf Bestätigung der Brille …';
    $('#save-state').textContent=settingsFeedback;updateLive();
    try {
      await confirmedCommand('runningMate.configure',next);
      settingsFeedback=JSON.stringify(draft)===submitted?'Von der Brille bestätigt · Einstellungen angewendet.':'Übertragung bestätigt · neuere Änderungen noch nicht angewendet.';
    } catch(error) {settingsFeedback='Nicht angewendet: '+error.message;}
    finally {settingsPending=false;if($('#save-state'))$('#save-state').textContent=settingsFeedback;updateLive();}
  });
  document.querySelectorAll('[data-run]').forEach(button=>button.onclick=async()=>{
    if(runPending||button.disabled)return;
    const action=button.dataset.run;
    if(action==='reset'&&!window.confirm('Laufdaten zurücksetzen? Laufzeit, Distanz und Rekorde dieser App-Session werden gelöscht.'))return;
    runPending=true;updateLive();
    const feedback=$('#run-feedback');
    feedback.textContent='Warte auf Bestätigung der Brille …';
    try {
      await confirmedCommand('runningMate.command',{action});
      feedback.textContent=({start:'Laufstart',pause:'Pause',resume:'Fortsetzen',stop:'Stoppen',reset:'Zurücksetzen'})[action]+' von der Brille bestätigt.';
    } catch(error) {feedback.textContent='Aktion fehlgeschlagen: '+error.message;}
    finally {runPending=false;updateLive();}
  });
  if($('#user-speed-form')) {
    $('#user-speed-source').onchange=()=>{
      userSpeedDraft.source=$('#user-speed-source').value;
      $('#user-speed-value').disabled=userSpeedDraft.source==='Treadmill';
    };
    $('#user-speed-value').oninput=()=>{const value=Number($('#user-speed-value').value);if(Number.isFinite(value))userSpeedDraft.speedKmh=value;};
    $('#user-speed-form').onsubmit=async event=>{
      event.preventDefault();if(userSpeedPending||!$('#user-speed-form').reportValidity())return;
      const source=$('#user-speed-source').value,payload={source};
      if(source==='FixedTest')payload.speedKmh=Number($('#user-speed-value').value);
      userSpeedPending=true;updateLive();
      try {await confirmedCommand('runningMate.setUserSpeed',payload);notice('Nutzertempo von der Brille bestätigt. Der Avatar behält sein eigenes Tempo.');}
      catch(error){notice(error.message);}
      finally {userSpeedPending=false;updateLive();}
    };
  }
  if($('#ghost-speed-form')) $('#ghost-speed-form').onsubmit=async event=>{
    event.preventDefault();
    const input=$('#ghost-speed'), speedKmh=Number(input.value);
    if(!input.reportValidity()||!Number.isFinite(speedKmh)||speedKmh<0) return;
    await changeGhostSpeed(speedKmh);
  };
  on('ghost-speed-auto',()=>changeGhostSpeed(null));
  if($('#placement-form')) {
    $('#placement-form').onsubmit=event=>{
      event.preventDefault();if(!$('#placement-form').reportValidity())return;
      calibrate('avatar.configurePlacement',{position:$('#placement-position').value,facing:$('#placement-facing').value,distance:Number($('#placement-distance').value)});
    };
    for(const id of ['placement-position','placement-facing','placement-distance']) $('#'+id).oninput=drawSweetSpot;
    drawSweetSpot();
  }
  if($('#avatar-lane-form')) $('#avatar-lane-form').onsubmit=event=>{
    event.preventDefault();calibrate('runningMate.setLane',{lane:Number($('#avatar-lane').value)});
  };
  on('environment-treadmill',()=>changeEnvironment('Treadmill'));
  on('environment-stadium',()=>changeEnvironment('Stadium'));
  on('stadium-point-a',()=>calibrate('scene.captureTrackPoint',{point:'A'}));
  on('stadium-point-b',()=>{
    const input=$('#stadium-distance');if(!input.reportValidity())return;
    return calibrate('scene.captureTrackPoint',{point:'B',distanceAlongTrack:Number(input.value)});
  });
  on('calibration-show-track',()=>calibrate('scene.setRunningMatePathVisible',{visible:true}));
  on('calibration-pause',()=>calibrate('runningMate.command',{action:'pause'}));
  on('recalibrate-world',()=>calibrate('scene.rescanMarker',{}));
  on('reposition-avatar',()=>calibrate('avatar.reposition',{}));
  if($('#track-offsets-form')) $('#track-offsets-form').onsubmit=event=>{event.preventDefault();if(!$('#track-offsets-form').reportValidity())return;calibrate('runningMate.adjust',{along:Number($('#track-offset-along').value),across:Number($('#track-offset-across').value),heading:Number($('#track-offset-heading').value)});};
  on('calibration-reset',()=>calibrate('runningMate.adjust',{reset:true}));
  document.querySelectorAll('[data-nudge-axis]').forEach(button=>button.onclick=()=>{
    const offsets=state.telemetry?.treadmill?.calibration||{along:0,across:0,heading:0};
    const axis=button.dataset.nudgeAxis;
    calibrate('runningMate.adjust',{[axis]:Math.round((Number(offsets[axis])+Number(button.dataset.nudge))*1000)/1000});
  });
  document.querySelectorAll('[data-height-nudge]').forEach(button=>button.onclick=()=>calibrate('scene.adjustHeight',{deltaMetres:Number(button.dataset.heightNudge)}));
  for(const [id,path,getData] of [['session-start','session/start',()=>({name:$('#session-name').value})],['session-stop','session/stop',()=>({})],['recording-start','recording/start',()=>({})],['recording-stop','recording/stop',()=>({})]]) on(id,async()=>{await api(path,getData());});
}
function updateUserSpeed(run,isML2) {
  if(!$('#user-speed-status'))return;
  const fresh=connected&&isML2&&Date.now()-lastTelemetryAt<5000;
  const supported=state.registry?.commands?.includes('runningMate.setUserSpeed');
  $('#user-speed-apply').disabled=userSpeedPending||!fresh||!supported||run.environment==='Stadium';
  const format=value=>typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('de-DE',{maximumFractionDigits:2}):null;
  const source=run.userSpeedSource;
  $('#user-speed-metrics').innerHTML=metric('BESTÄTIGTE QUELLE',fresh?(source==='FixedTest'?'Festes Testtempo':source==='Treadmill'?'Laufband':source==='HeadTracking'?'Headtracking':null):null)
    +metric('LAUFBANDSIGNAL',fresh&&source==='Treadmill'?(run.treadmillSignalReady?'Aktuell':'Keine Daten'):'—');
  $('#user-speed-status').textContent=userSpeedPending?'Warte auf Bestätigung der Brille …':!fresh?'Keine aktuellen Daten von der Brille.':!supported?'Nutzertempo-Auswahl benötigt die aktualisierte App auf der Brille.':run.environment==='Stadium'?'Echte Stadionbahn aktiv: Nutzertempo kommt vom Headtracking. Für Test-/Laufbandtempo unter Kalibrierung die Laufbandumgebung wählen.':source==='Treadmill'?(run.treadmillSignalReady?'Laufbanddaten werden verwendet.':'Laufbandmodus aktiv · noch keine Sensordaten · 0 km/h.'): `Festes Nutzertempo: ${format(run.fixedUserSpeedKmh)} km/h. Ghost-Zielpace und Ghost-Testtempo bleiben unabhängig.`;
}
function recordTime(seconds) {
  if(typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<=0)return 'Noch kein Rekord';
  const tenths=Math.round(seconds*10),minutes=Math.floor(tenths/600),rest=Math.floor(tenths/10)%60;
  return `${minutes}:${String(rest).padStart(2,'0')},${tenths%10}`;
}
function updateRecords(run,isML2) {
  if(!$('#record-metrics'))return;
  const records=run.records,available=records&&typeof records==='object';
  $('#record-metrics').innerHTML=metric('SCHNELLSTE 100 M',available?recordTime(records.fastest100mSeconds):'—')
    +metric('BESTE RUNDE · 400 M',available?recordTime(records.bestLapSeconds):'—')
    +metric('SCHNELLSTER KILOMETER',available?recordTime(records.fastest1KmSeconds):'—');
  const live=isML2&&connected&&Date.now()-lastTelemetryAt<5000;
  $('#record-status').textContent=!available?(live?'Rekord-Telemetrie fehlt · aktualisierte App installieren.':'Warte auf Rekordzeiten von der Brille.'):live?'Live aus der Brille · min:ss,Zehntel':'Zuletzt empfangene Werte · aktuell keine Live-Verbindung.';
}
function hasGhostRecording(run) {
  return run.ghost?.hasRecording===true || run.ghost?.recordedLap===true || Number.isFinite(run.records?.bestLapSeconds);
}
function ghostPlaybackStatus(run) {
  const ghost=run.ghost;
  const source=hasGhostRecording(run)?'aufgezeichnete beste Runde':`Zielpace ${paceText(run.paceSeconds||defaults.paceSeconds)} min/km · noch keine vollständige Runde aufgezeichnet`;
  const mode=ghost?.testMode?`Testmodus aktiv · ${Number(ghost.testSpeedKmh).toLocaleString('de-DE')} km/h eingestellt. Rückwechsel verwendet ${source}.`:`${hasGhostRecording(run)?'Bestzeitmodus':'Zielpacemodus'} aktiv · ${source}.`;
  return mode+(run.state==='Running'?(ghost?.active?'':' Ghost derzeit inaktiv.'):' Lauf pausiert · Starten oder Fortsetzen bewegt den Ghost.');
}
async function changeGhostSpeed(speedKmh) {
  if(ghostSpeedPending)return;
  ghostSpeedPending=true;updateLive();
  try {
    await confirmedCommand('runningMate.setGhostSpeed',{speedKmh});
    notice(speedKmh===null?'Rückwechsel von der Brille bestätigt. Ohne aufgezeichnete Runde gilt die Zielpace; ein pausierter Lauf bleibt pausiert.':'Ghost-Testtempo von der Brille bestätigt.');
  } catch(error) {notice(error.message);}
  finally {ghostSpeedPending=false;updateLive();}
}
function updateGhostLive(run,isML2) {
  if(!$('#live-track')) return;
  const ghost=run.ghost, fresh=isML2&&connected&&lastTelemetryAt>0&&Date.now()-lastTelemetryAt<5000;
  const valid=n=>typeof n==='number'&&Number.isFinite(n);
  function marker(id,metres,visible,lane=1) {
    const node=$('#'+id);node.toggleAttribute('hidden',!visible||!valid(metres));
    if(!visible||!valid(metres)) return;
    const route=$('#live-route'), point=route.getPointAtLength((((metres%400)+400)%400)/400*route.getTotalLength());
    const length=route.getTotalLength(),at=((((metres%400)+400)%400)/400)*length;
    const before=route.getPointAtLength((at-.2+length)%length),after=route.getPointAtLength((at+.2)%length);
    const dx=after.x-before.x,dy=after.y-before.y,norm=Math.hypot(dx,dy)||1,offset=(lane-1)*1.5;
    node.setAttribute('cx',point.x+dy/norm*offset);node.setAttribute('cy',point.y-dx/norm*offset);
  }
  marker('live-user',run.trackPositionMetres,fresh&&run.placementReady);
  marker('live-ghost',ghost?.trackPositionMetres,fresh&&ghost?.active===true,run.avatarLane||3);
  const live=fresh&&run.placementReady&&valid(run.trackPositionMetres);
  $('#live-track-state').textContent=!fresh?'':!live?(run.markerPlacement?.required?'Warte auf Bodenmarker':'App-Update erforderlich'):run.state||'Live';
  $('#live-freshness').textContent=live?'Live · Brille verbunden':'Warte auf Positionsdaten';
  const fmt=n=>valid(n)?n.toLocaleString('de-DE',{maximumFractionDigits:1}):null;
  $('#ghost-metrics').innerHTML=metric('DEINE POSITION',live?fmt(run.trackPositionMetres):null,'m / 400')
    +metric('GHOST-POSITION',fresh&&ghost?.active?fmt(ghost.trackPositionMetres):null,'m / 400')
    +metric('GHOST-TEMPO',fresh&&ghost?.active?fmt(ghost.speedKmh):null,'km/h')
    +metric('DEIN VORSPRUNG',fresh&&ghost?.active?fmt(ghost.gapMetres):null,'m');
  const supported=fresh&&state.registry?.commands?.includes('runningMate.setGhostSpeed');
  for(const id of ['ghost-speed-apply','ghost-speed-auto']) $('#'+id).disabled=!supported||ghostSpeedPending;
  $('#ghost-speed-auto').textContent=hasGhostRecording(run)?'Zurück zur Bestzeit':'Zurück zur Zielpace';
  $('#ghost-mode-status').textContent=ghostSpeedPending?'Warte auf Bestätigung der Brille …':!fresh?'Keine aktuellen Ghost-Daten.':!supported?'Für diese Funktion muss die aktualisierte App auf der Brille installiert sein.':ghostPlaybackStatus(run);
}
function drawSweetSpot() {
  if(!$('#sweet-avatar'))return;
  const index=['N','NE','E','SE','S','SW','W','NW'].indexOf($('#placement-position').value), angle=index*Math.PI/4;
  const x=140+Math.sin(angle)*75, y=112-Math.cos(angle)*75;
  $('#sweet-avatar').setAttribute('cx',x);$('#sweet-avatar').setAttribute('cy',y);
  const facing=$('#placement-facing').value;
  const offset={FaceUser:180,BackToUser:0,LeftShoulder:90,RightShoulder:270}[facing];
  $('#sweet-facing').setAttribute('transform',`translate(${x} ${y}) rotate(${index*45+offset})`);
  $('#sweet-preview-label').textContent=`Entwurf: ${$('#placement-position').value} · ${$('#placement-distance').value} m · ${$('#placement-facing').selectedOptions[0].textContent}. Erst „Platzierung übernehmen“ sendet ihn an die Brille.`;
}
function updateCalibration(run,isML2) {
  if(!$('#calibration-status'))return;
  const fresh=isML2&&connected&&Date.now()-lastTelemetryAt<5000;
  const ready=fresh&&run.placementReady&&run.headPoseReady&&run.heightConfirmed;
  const stadium=run.environment==='Stadium',stadiumCal=run.stadiumCalibration||{};
  document.querySelectorAll('[data-cal-command]').forEach(button=>{
    const cmd=button.dataset.calCommand;
    let applicable=ready;
    if(cmd==='scene.setTrackEnvironment'||cmd==='scene.rescanMarker')applicable=fresh&&run.headPoseReady;
    if(cmd==='scene.captureTrackPoint')applicable=fresh&&run.headPoseReady&&stadium&&(button.id==='stadium-point-a'||stadiumCal.pointA);
    if(cmd==='scene.setRunningMatePathVisible')applicable=fresh&&run.placementReady;
    if(cmd==='scene.recalibrate'||cmd==='avatar.reposition')applicable=ready&&!stadium;
    if(cmd==='avatar.configurePlacement')applicable=ready&&!stadium&&run.mode==='SideBySide';
    button.disabled=calibrationPending||!applicable||!state.registry?.commands?.includes(cmd);
    const reason=calibrationPending?'Warte auf Bestätigung der Brille.':!fresh?'Brille verbinden und aktuelle Daten abwarten.':!state.registry?.commands?.includes(cmd)?'Diese Aktion wird von der verbundenen App-Version nicht unterstützt.':!applicable?(cmd==='avatar.configurePlacement'?'Nur bei fertiger Platzierung im Laufbandmodus Side by Side verfügbar.':cmd==='scene.captureTrackPoint'?'Stadionmodus aktivieren und zuerst Punkt A erfassen.':'Zuerst Bodenmarker, Headtracking und Platzierung prüfen.') : '';
    button.title=reason;

  });
  $('#track-environment-state').textContent=!state.registry?.commands?.includes('scene.setTrackEnvironment')?'Für den Wechsel zur echten Stadionbahn die aktualisierte App installieren.':fresh?`Aktiv: ${stadium?'Echte Stadionbahn · Welt bleibt fest':'Laufband · Welt bewegt sich'}`:'Warte auf aktuelle Brillendaten.';
  $('#avatar-lane-state').textContent=fresh&&run.avatarLane?`Bestätigt: Avatar auf Bahn ${run.avatarLane} · ${modeName(run.mode)}.`:'Für die Bahnauswahl die aktualisierte App installieren und verbinden.';
  $('#stadium-calibration-state').textContent=!state.registry?.commands?.includes('scene.captureTrackPoint')?'Stadionkalibrierung benötigt die aktualisierte App auf der Brille.':!fresh?'Keine aktuellen Brillendaten.':!stadium?'Zuerst „Echte 400-m-Bahn“ aktivieren.':stadiumCal.calibrated?`A/B bestätigt · gemessene direkte Basis ${Number(stadiumCal.baselineMetres).toFixed(2)} m · feste Welt bereit.`:stadiumCal.pointA?'Punkt A erfasst. Jetzt zum ausgemessenen Punkt B gehen und übernehmen.':'Stadionmodus aktiv. Punkt A an der Startlinie erfassen.';
  $('#calibration-pause').disabled=calibrationPending||!fresh||run.state!=='Running'||!state.registry?.commands?.includes('runningMate.command');
  $('#placement-mode-hint').textContent=!fresh?'Keine Verbindung zur Brille. App öffnen und Verbindung abwarten.':stadium?'Im Stadion wird die Avatarposition über die gemeinsame Bahnauswahl festgelegt.':run.mode!=='SideBySide'?'Aktiv ist Tempo-Partner: Diese Sweet-Spot-Regler verändern den sichtbaren Ghost nicht. Für ihn die Laufwelt unten neu ausrichten; für Sweet Spot zunächst Side by Side konfigurieren.':'Side-by-Side-Avatar aktiv · Platzierung nach dem Pausieren ändern.';
  $('#marker-placement-status').textContent=!fresh?'Bodenmarker-Status wartet auf Verbindung.':run.markerPlacement?run.markerPlacement.status:'Für Marker-/Plane-Platzierung die aktualisierte App installieren.';
  const supported=state.registry?.commands?.includes('scene.rescanMarker');
  const step=!fresh?'marker':!run.heightConfirmed?'marker':!run.placementReady||!run.headPoseReady?'placement':stadium&&!stadiumCal.calibrated?'track':'ready';
  const guidance=!fresh?'Brille verbinden, um mit der Kalibrierung zu beginnen.':step==='marker'?'Bodenmarker scannen und die umgebende Bodenfläche erfassen.':step==='placement'?'Headset-Tracking und Platzierung prüfen. Bahn und Avatar müssen am Boden sichtbar sein.':step==='track'?(stadiumCal.pointA?'Punkt A ist erfasst. Zum ausgemessenen Punkt B gehen und Punkt B übernehmen.':'Stadionkalibrierung öffnen und zuerst Punkt A an der Startlinie erfassen.'):'Kalibrierung bereit. Zum Laufband wechseln und den Lauf starten. Feinausrichtung nur bei Bedarf.';
  $('#calibration-next').textContent=guidance;
  document.querySelectorAll('[data-step]').forEach(node=>{node.classList.toggle('current-step',node.dataset.step===step);node.hidden=node.dataset.step==='track'&&!stadium;});
  $('#calibration-status').textContent=calibrationPending?'Warte auf Bestätigung der Brille …':!fresh?'Keine aktuellen Daten von der Brille.':!supported?'Für die Kalibrierung muss die aktualisierte App installiert sein.':stadium&&!stadiumCal.calibrated?'Punkte A/B erfassen; danach kann die ganze Bahn feinjustiert werden.':ready?'Bereit. Änderungen pausieren einen laufenden Lauf automatisch.':'Auf Headtracking und fertige Platzierung warten.';
  const fmt=n=>typeof n==='number'&&Number.isFinite(n)?n.toLocaleString('de-DE',{maximumFractionDigits:2}):'—';
  const c=fresh?run.calibration:null,p=fresh?run.placement:null;
  $('#calibration-offsets').textContent=c?`Bestätigt: entlang ${fmt(c.along*100)} cm · quer ${fmt(c.across*100)} cm · Drehung ${fmt(c.heading)}°`:'Keine bestätigten Feinversätze.';
  $('#calibration-height').textContent=c?`Erkannte Bodenreferenz: ${fmt(c.surfaceHeight)} m im XR-Koordinatensystem.`:'';
  $('#placement-applied').textContent=p?`Auf der Brille: ${p.position} · ${fmt(p.distance)} m · ${p.facing}${p.laneActive?' · Bahnauswahl aktiv':''}. Aktueller Modus: ${modeName(run.mode)}.`:'Noch keine bestätigte Platzierung.';
}
function liveBool(value) {return typeof value==='boolean'?(value?'Bestätigt':'Offen'):'—';}
function updateConnectionNotice() {
  const fresh = connected && state.headsetConnected && state.registry?.project === 'MarkerML2' && Date.now()-lastTelemetryAt<5000;
  const message = !connected ? 'Server nicht verbunden · Verbindung wird wiederhergestellt.'
    : !state.headsetConnected ? 'Keine Verbindung zur Brille · App öffnen und Verbindung abwarten.'
    : state.registry?.project !== 'MarkerML2' ? 'Headset verbunden · warte auf die MarkerML2-App.'
    : !fresh ? 'Keine aktuellen Daten von der Brille · angezeigte Live-Werte sind nicht aktuell.' : '';
  $('#connection-notice').textContent=message;
  $('#connection-notice').hidden=!message;
  for (const id of ['user-speed-status','ghost-mode-status','record-status','calibration-status','marker-placement-status','placement-mode-hint','track-environment-state','avatar-lane-state','stadium-calibration-state','live-freshness']) {
    const node=$('#'+id);
    if(node) node.hidden=!fresh;
  }
}
function updateLive() {
  const t=state.telemetry||{}, run=t.treadmill||{}, isML2=state.headsetConnected&&state.registry?.project==='MarkerML2';
  const fresh=isML2&&connected&&Date.now()-lastTelemetryAt<5000;
  const runSupported=state.registry?.commands?.includes('runningMate.command');
  const runReady=fresh&&runSupported&&run.placementReady&&run.headPoseReady&&run.heightConfirmed;
  const actions={start:['Stopped','Ready','Idle'].includes(run.state),pause:run.state==='Running',resume:run.state==='Paused',stop:['Running','Paused'].includes(run.state),reset:['Stopped','Ready','Paused'].includes(run.state)};
  document.querySelectorAll('[data-run]').forEach(button=>{
    const action=button.dataset.run;
    button.hidden=fresh?!actions[action]:action!=='start';
    const needsPlacement=action==='start'||action==='resume';
    button.disabled=!fresh||!runSupported||(needsPlacement&&!runReady)||runPending||calibrationPending||settingsPending||!actions[action];
    button.title=button.disabled?(!fresh?'Brille verbinden und aktuelle Daten abwarten.':needsPlacement&&!runReady?'Zuerst unter Kalibrierung Bodenmarker und Platzierung prüfen.':'Warte auf Bestätigung oder einen passenden Laufzustand.') : '';
  });
  if($('#send-settings')) {
    $('#send-settings').disabled=!fresh||settingsPending||runPending||!state.registry?.commands?.includes('runningMate.configure');
    if(!runPending&&!$('#run-feedback').textContent.includes('bestätigt')&&!$('#run-feedback').textContent.includes('fehlgeschlagen')) $('#run-feedback').textContent=!fresh?'':!runSupported?'Laufsteuerung wird von dieser App-Version nicht unterstützt.':!runReady?'Vor dem Start unter Kalibrierung Bodenmarker und Platzierung prüfen.':!Object.values(actions).some(Boolean)?'Unbekannter Laufstatus · auf aktuelle Brillendaten warten.':'';
    $('#reset-settings').disabled=settingsPending;
  }
  updateGhostLive(run,isML2);
  updateUserSpeed(run,isML2);
  updateRecords(run,isML2);
  updateCalibration(run,isML2);
  const indicators=[['Server',connected],['Headset',state.headsetConnected],['MarkerML2',isML2],['BLE',state.headsetConnected&&t.ble?.connected],['REC',state.recording]];
  $('#indicators').innerHTML=indicators.map(([name,on])=>`<span class="indicator"><i class="dot ${on?'on':''}"></i>${name}</span>`).join('');
  $('#device-state').hidden=!state.device?.simulated;
  $('#device-state').textContent=state.device?.simulated?'Simulator · Testdaten':'';
  updateConnectionNotice();
  $('#ack').textContent=state.lastAck?`${state.lastAck.success?'✓':'✕'} ${state.lastAck.commandType||'Befehl'}${state.lastAck.error?' · '+state.lastAck.error:''}`:'Noch kein Befehl gesendet';
  if($('#treadmill-metrics')) $('#treadmill-metrics').innerHTML=metric('LAUFSTATUS',isML2?({Stopped:'Gestoppt',Ready:'Bereit',Running:'Läuft',Paused:'Pausiert',Idle:'Bereit'}[run.state]||run.state):null)+metric('DISTANZ',isML2?run.distance:null,'m')+metric('ZEIT',isML2?run.elapsed:null,'s')+metric('RUNDEN',isML2?run.laps:null)+metric('AKTIVER MODUS',isML2&&run.mode?modeName(run.mode):null)+metric('TEMPO',isML2?run.speedKmh:null,'km/h');
  if($('#placement-metrics')) $('#placement-metrics').innerHTML=metric('HEADTRACKING',isML2?liveBool(run.headPoseReady):null)+metric('HÖHE',isML2?liveBool(run.heightConfirmed):null)+metric('PLATZIERUNG',isML2?liveBool(run.placementReady):null);
  if($('#ble-metrics')) {const b=t.ble||{};$('#ble-metrics').innerHTML=metric('HERZFREQUENZ',state.headsetConnected?b.hr:null,'BPM')+metric('TEMPERATUR',state.headsetConnected?b.temperature:null,'°C')+metric('SpO₂',state.headsetConnected?b.spo2:null,'%')+metric('PULS',state.headsetConnected?b.pr:null,'BPM')+metric('PERFUSION INDEX',state.headsetConnected?b.pi:null,'%');}
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
      if(m.type==='status') {state=m;if(m.headsetConnected)lastTelemetryAt=Date.now();updateLive();}
      else if(m.type==='registry') {state.registry=m.data;updateLive();log('registry','Headset-Katalog aktualisiert');}
      else if(m.type==='telemetry') {state.telemetry=m.data;lastTelemetryAt=Date.now();updateLive();}
      else if(m.type==='ack') {commandAcks.set(m.commandId,m);if(commandAcks.size>100)commandAcks.delete(commandAcks.keys().next().value);const waiter=commandWaiters.get(m.commandId);if(waiter){commandWaiters.delete(m.commandId);waiter(m);}state.lastAck=m;updateLive();log(m.success?'ack':'error',m);}
      else if(m.type==='command') log('command',m.command);
      else if(m.type==='error') {notice(m.message);log('error',m.message);}
    } catch {log('error','Ungültige Servernachricht');}
  };
  socket.onclose=()=>{connected=false;state.headsetConnected=false;updateLive();log('connection','Verbindung unterbrochen · erneuter Versuch');setTimeout(connect,reconnectDelay);reconnectDelay=Math.min(reconnectDelay*2,10000);};
  socket.onerror=()=>socket.close();
}
function setLogCollapsed(collapsed) {$('.workspace').classList.toggle('log-collapsed',collapsed);$('#toggle-log').textContent=collapsed?'Protokoll anzeigen':'Protokoll ausblenden';$('#toggle-log').setAttribute('aria-expanded',String(!collapsed));}
setLogCollapsed(localStorage.getItem('logExpanded')!=='true');
$('#toggle-log').onclick=()=>{const collapsed=!$('.workspace').classList.contains('log-collapsed');setLogCollapsed(collapsed);localStorage.setItem('logExpanded',String(!collapsed));};
$('#navigation').onclick=e=>{const b=e.target.closest('[data-tab]');if(b){activeTab=b.dataset.tab;render();}};
$('#clear-log').onclick=()=>{logs.length=0;$('#log').innerHTML='';};
$('#copy-log').onclick=async()=>{try{await navigator.clipboard.writeText(logs.map(l=>`${l.time} ${l.kind} ${typeof l.data==='string'?l.data:JSON.stringify(l.data)}`).join('\n'));notice('Log kopiert.');}catch{notice('Zwischenablage im Browser nicht verfügbar.');}};
$('#server-address').textContent=location.host;
render();connect();
setInterval(updateLive,1000);
