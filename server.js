import http from 'node:http';
import { readFile, mkdir, appendFile, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const root = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 64 * 1024;
const csvCell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
const csv = values => values.map(csvCell).join(',') + '\n';
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function createService({ recordingsDir = resolve(root, 'recordings'), commandTimeout = 10000 } = {}) {
  let headset = null, device = null, registry = null, telemetry = {}, lastAck = null, session = null, recording = null;
  let ioQueue = Promise.resolve();
  let recordingError = null;
  const pending = new Map();
  const clients = new Set();
  const status = () => ({ type: 'status', headsetConnected: headset?.readyState === WebSocket.OPEN,
    platform: 'Magic Leap 2', device, registry, telemetry, lastAck, session, recording: recording && { id: recording.id, startedAt: recording.startedAt }, recordingError });
  const send = (ws, data) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
  const broadcast = data => { for (const ws of clients) send(ws, data); };
  function queueIO(operation) {
    const result = ioQueue.then(operation);
    ioQueue = result.catch(error => {
      recordingError = error.message;
      console.error('Recording write failed:', error.message);
      broadcast({ type: 'error', message: `Recording failed: ${error.message}` });
    });
    return result;
  }
  function record(file, line) {
    if (!recording) return;
    const directory = recording.directory;
    queueIO(() => appendFile(resolve(directory, file), line)).catch(() => {});
  }
  function event(type, data) { broadcast({ type, ...data, timestamp: new Date().toISOString() }); }
  function rejectPending(reason) {
    for (const [id, item] of pending) {
      clearTimeout(item.timer);
      lastAck = { type: 'ack', commandId: id, commandType: item.commandType, success: false, error: reason };
      event('ack', lastAck);
    }
    pending.clear();
  }
  async function body(req) {
    let raw = '', size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw Object.assign(new Error('Request body exceeds 64 KiB'), { status: 413 });
      raw += chunk;
    }
    try { const value = raw ? JSON.parse(raw) : {}; if (!isObject(value)) throw new Error(); return value; }
    catch { throw Object.assign(new Error('Expected a JSON object'), { status: 400 }); }
  }
  function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
  const server = http.createServer(async (req, res) => {
    const reply = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      // Commands are intentionally same-origin only; no CORS access is granted.
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return reply(403, { error: 'Cross-origin requests are not allowed' });
      if (req.method === 'GET' && url.pathname === '/api/status') return reply(200, status());
      if (req.method === 'GET' && url.pathname === '/api/registry') return reply(200, registry ?? {});
      if (req.method === 'POST' && url.pathname === '/api/command') {
        const input = await body(req);
        if (typeof input.commandType !== 'string' || !/^(avatar|scene|exercise|runningMate|sensor)\.[A-Za-z][A-Za-z0-9]*$/.test(input.commandType)) fail('Unsupported command family or invalid commandType');
        if (input.targetId !== undefined && (typeof input.targetId !== 'string' || input.targetId.length > 128)) fail('Invalid targetId');
        if (input.commandPayload !== undefined && !isObject(input.commandPayload)) fail('commandPayload must be an object');
        if (!headset || headset.readyState !== WebSocket.OPEN) fail('No headset connected', 503);
        const command = { type: 'command', commandId: randomUUID(), timestamp: new Date().toISOString(),
          commandType: input.commandType, targetId: input.targetId ?? '', commandPayload: input.commandPayload ?? {} };
        const timer = setTimeout(() => {
          pending.delete(command.commandId);
          lastAck = { type: 'ack', commandId: command.commandId, commandType: command.commandType, success: false, error: 'Headset acknowledgement timed out' };
          event('ack', lastAck);
        }, commandTimeout);
        timer.unref();
        pending.set(command.commandId, { timer, commandType: command.commandType });
        send(headset, command);
        record('commands.jsonl', JSON.stringify(command) + '\n');
        event('command', { command });
        return reply(202, { accepted: true, commandId: command.commandId });
      }
      if (req.method === 'POST' && url.pathname === '/api/session/start') {
        const data = await body(req);
        if (session) fail('A session is already active', 409);
        if (data.name !== undefined && (typeof data.name !== 'string' || data.name.length > 200)) fail('Session name must be a string of at most 200 characters');
        session = { id: randomUUID(), name: data.name || 'Training session', startedAt: new Date().toISOString() };
        broadcast(status()); return reply(201, session);
      }
      if (req.method === 'POST' && url.pathname === '/api/session/stop') {
        await body(req);
        if (recording) fail('Stop recording before ending the session', 409);
        const ended = session; session = null; broadcast(status()); return reply(200, { session: ended });
      }
      if (req.method === 'POST' && url.pathname === '/api/recording/start') {
        await body(req);
        if (recording) fail('A recording is already active', 409);
        const startedAt = new Date().toISOString();
        const id = startedAt.replaceAll(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
        const directory = resolve(recordingsDir, id);
        // Reserve before the first await so simultaneous requests cannot start two recordings.
        recording = { id, startedAt, directory, session: session && { ...session } };
        try {
          await queueIO(async () => {
            await mkdir(directory, { recursive: true });
            await writeFile(resolve(directory, 'ble_data.csv'), csv(['timestamp', 'hr', 'temperature', 'spo2', 'pr', 'pi']));
            await writeFile(resolve(directory, 'exercise_detections.csv'), csv(['timestamp', 'profile', 'confidence', 'intensity', 'frequency', 'amplitude', 'active']));
            await writeFile(resolve(directory, 'commands.jsonl'), '');
            await writeFile(resolve(directory, 'session_meta.json'), JSON.stringify({ id, startedAt, session, platform: 'Magic Leap 2' }, null, 2));
          });
        } catch (error) { recording = null; throw error; }
        recordingError = null; broadcast(status()); return reply(201, { id, startedAt });
      }
      if (req.method === 'POST' && url.pathname === '/api/recording/stop') {
        await body(req);
        const ended = recording;
        if (!ended) fail('No recording is active', 409);
        recording = null;
        await queueIO(() => writeFile(resolve(ended.directory, 'session_meta.json'), JSON.stringify({ id: ended.id, startedAt: ended.startedAt, stoppedAt: new Date().toISOString(), session: ended.session, platform: 'Magic Leap 2', error: recordingError }, null, 2)));
        broadcast(status()); return reply(200, { id: ended.id, stopped: true, error: recordingError });
      }
      if (url.pathname.startsWith('/api/')) return reply(404, { error: 'Unknown API route' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405, { error: 'Method not allowed' });
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      const asset = assets[url.pathname];
      if (!asset) return reply(404, { error: 'Not found' });
      const content = await readFile(resolve(root, 'public', asset[0]));
      res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'" });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) { reply(error.status || 500, { error: error.status ? error.message : 'Internal server error' }); if (!error.status) console.error(error); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/' && url.pathname !== '/ws') return socket.destroy();
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) return socket.destroy(); } catch { return socket.destroy(); }
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws, req) => {
    let role = null;
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', error => console.error('WebSocket:', error.message));
    const helloTimeout = setTimeout(() => { if (!role) ws.close(1008, 'Send hello within 5 seconds'); }, 5000);
    helloTimeout.unref();
    ws.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (!isObject(message)) throw new Error('Message must be an object');
        if (!role) {
          if (message.type !== 'hello' || !['dashboard', 'headset'].includes(message.role)) throw new Error('First message must be hello with role dashboard or headset');
          if (message.role === 'headset' && headset && headset !== ws && headset.readyState === WebSocket.OPEN) { ws.close(1008, 'A headset is already connected'); return; }
          role = message.role; clearTimeout(helloTimeout);
          if (role === 'headset') { headset = ws; device = { id: typeof message.deviceId === 'string' ? message.deviceId.slice(0,128) : 'headset', simulated: message.platform === 'simulator' }; registry = null; telemetry = {}; lastAck = null; broadcast(status()); }
          else clients.add(ws);
          send(ws, { type: 'welcome', protocolVersion: 1, role, platform: 'Magic Leap 2' });
          send(ws, status()); return;
        }
        if (message.type === 'ping') return send(ws, { type: 'pong' });
        if (role !== 'headset') throw new Error('Dashboard commands must use POST /api/command');
        if (message.type === 'registry') {
          if (!isObject(message.data)) throw new Error('registry.data must be an object');
          for (const key of ['avatars','shaders','animations','exerciseProfiles','huds']) {
            const entries = message.data[key];
            if (entries !== undefined && (!Array.isArray(entries) || entries.some(entry => typeof entry !== 'string' && !(isObject(entry) && (typeof entry.id === 'string' || typeof entry.name === 'string'))))) throw new Error(`registry.${key} must be an array of strings or named objects`);
          }
          if (message.data.capabilities !== undefined && !isObject(message.data.capabilities)) throw new Error('registry.capabilities must be an object');
          registry = message.data; event('registry', { data: registry });
        } else if (message.type === 'telemetry') {
          if (!isObject(message.data)) throw new Error('telemetry.data must be an object');
          for (const key of ['avatar','calibration','ble','huds','runningMate']) if (message.data[key] !== undefined && !isObject(message.data[key])) throw new Error(`telemetry.${key} must be an object`);
          if (message.data.exercises !== undefined && (!Array.isArray(message.data.exercises) || message.data.exercises.some(e => !isObject(e)))) throw new Error('telemetry.exercises must be an array of objects');
          telemetry = { ...telemetry, ...message.data };
          const timestamp = new Date().toISOString(), ble = message.data.ble;
          if (isObject(ble)) record('ble_data.csv', csv([timestamp, ble.hr, ble.temperature, ble.spo2, ble.pr, ble.pi]));
          if (Array.isArray(message.data.exercises)) for (const e of message.data.exercises) {
            if (isObject(e)) record('exercise_detections.csv', csv([timestamp, e.profile, e.confidence, e.intensity, e.frequency, e.amplitude, e.active]));
          }
          event('telemetry', { data: telemetry });
        } else if (message.type === 'ack') {
          if (typeof message.commandId !== 'string' || typeof message.success !== 'boolean') throw new Error('ack requires commandId and boolean success');
          const item = pending.get(message.commandId);
          if (!item) throw new Error('Unknown or expired commandId');
          clearTimeout(item.timer); pending.delete(message.commandId);
          lastAck = { type: 'ack', commandId: message.commandId, commandType: item.commandType, success: message.success, data: message.data, error: message.error };
          event('ack', lastAck);
        } else throw new Error('Unknown message type');
      } catch (error) { send(ws, { type: 'error', message: error.message }); }
    });
    ws.on('close', () => {
      clearTimeout(helloTimeout); clients.delete(ws);
      if (ws === headset) { headset = null; device = null; rejectPending('Headset disconnected'); broadcast(status()); }
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
  }, 15000);
  heartbeat.unref();
  return { server, status, async close() {
    clearInterval(heartbeat); rejectPending('Server shutting down');
    if (recording) {
      const ended = recording; recording = null;
      await queueIO(() => writeFile(resolve(ended.directory, 'session_meta.json'), JSON.stringify({ id: ended.id, startedAt: ended.startedAt, stoppedAt: new Date().toISOString(), session: ended.session, platform: 'Magic Leap 2', reason: 'server_shutdown', error: recordingError }, null, 2))).catch(() => {});
    }
    for (const ws of wss.clients) ws.terminate();
    await ioQueue; await new Promise(resolve => wss.close(resolve));
    if (server.listening) await new Promise(resolve => server.close(resolve));
  } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = createService();
  const port = Number(process.env.PORT || 8081), host = process.env.HOST || '0.0.0.0';
  service.server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  service.server.listen(port, host, () => {
    console.log(`Avatar VOS · Magic Leap 2\nLocal: http://localhost:${service.server.address().port}`);
    for (const list of Object.values(networkInterfaces())) for (const net of list || []) if (net.family === 'IPv4' && !net.internal) console.log(`LAN:   http://${net.address}:${service.server.address().port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); });
}
