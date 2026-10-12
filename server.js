"use strict";
const http = require('node:http');
const ws = require('ws');
const { makeStore, hash, secret, HttpError } = require('./store');
const compat = require('./compat');
function serverSettings(env) {
  const address = String(env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '').trim();
  if (!address) throw Error('Missing PUBLIC_URL or Render-provided RENDER_EXTERNAL_URL');
  const publicUrl = new URL(address);
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') throw Error('Public URL must be an HTTPS origin');
  const baseUrl = new URL(String(env.MODEL_BASE_URL || 'https://api.openai.com/v1').trim());
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw Error('MODEL_BASE_URL must be an HTTPS API endpoint without credentials or query parameters');
  let provider = env.MODEL_PROVIDER || 'openai';
  if (baseUrl.hostname === 'generativelanguage.googleapis.com') provider = /\/openai\/?$/.test(baseUrl.pathname) ? 'openai' : 'gemini';
  if (!['openai', 'gemini', 'anthropic'].includes(provider)) throw Error('MODEL_PROVIDER must be openai, gemini, or anthropic');
  return { publicUrl: publicUrl.origin, config: {
    provider, baseUrl: baseUrl.toString().replace(/\/+$/, ''),
    apiKey: env.MODEL_API_KEY, model: env.MODEL_NAME, authMode: env.MODEL_AUTH_MODE || 'api-key'
  } };
}
function createService(env, dependencies = {}) {
const WebSocket = dependencies.WebSocket || ws.WebSocket;
const WebSocketServer = ws.WebSocketServer;
for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'MODEL_API_KEY', 'MODEL_NAME']) if (!env[key]) throw Error('Missing server environment: ' + key);
const { publicUrl, config } = serverSettings(env);
const store = dependencies.store || makeStore(env);
const dailyLimit = Number(env.DAILY_ANSWER_LIMIT || 100);
const dailySpeech = Number(env.DAILY_TRANSCRIPTION_LIMIT || 20);
if (![dailyLimit, dailySpeech].every(n => Number.isInteger(n) && n > 0 && n <= 10000)) throw Error('Invalid usage limits');
const tickets = new Map();
const inFlight = new Set();
const streams = new Map();
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
async function body(req, limit = 6 * 1024 * 1024) {
  let size = 0; const parts = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new HttpError(413, 'Request too large.'); parts.push(chunk); }
  try { return JSON.parse(Buffer.concat(parts).toString() || '{}'); } catch { throw new HttpError(400, 'Invalid request.'); }
}
const bearer = req => /^Bearer ([\w-]+)$/.exec(req.headers.authorization || '')?.[1];
async function credential(user, token) {
  await store.quota('speech:' + user.id, dailySpeech, 86400000);
  if (tickets.size >= 1000) throw new HttpError(503, 'Please retry later.');
  const ticket = secret();
  tickets.set(ticket, { user, token, expires: Date.now() + 30000 });
  const relay = 'omer-relay1.' + Buffer.from(JSON.stringify({ url: publicUrl.replace(/^https:/, 'wss:') + '/realtime?ticket=' + ticket })).toString('base64url');
  return env.TRANSCRIPTION_PROVIDER === 'deepgram'
    ? 'omer-dg1.' + Buffer.from(JSON.stringify({ token: relay, model: env.DEEPGRAM_MODEL || 'nova-3' })).toString('base64url') : relay;
}
const ticketCleanup = setInterval(() => { for (const [key, item] of tickets) if (item.expires <= Date.now()) tickets.delete(key); }, 10000);
ticketCleanup.unref();
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://server');
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/auth/login') {
      // Render appends the actual client address; never trust the first X-Forwarded-For value.
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').pop().trim();
      await store.quota('ip-login:' + hash(ip), 30, 600000);
      return json(res, 200, await store.login(await body(req, 8192)));
    }
    const token = bearer(req);
    const user = await store.authorize(token);
    await store.quota('requests:' + user.id, 600, 60000);
    if (url.pathname === '/auth/status' && req.method === 'GET') return json(res, 200, { email: user.email, expiresAt: user.expiresAt });
    if (url.pathname === '/auth/logout' && req.method === 'POST') {
      await store.call('/rest/v1/omer_sessions?token_hash=eq.' + hash(token), { method: 'DELETE' });
      for (const entry of streams.get(user.id) || []) entry.close();
      return json(res, 200, { ok: true });
    }
    const isChat = url.pathname === '/api/chat';
    if (isChat && inFlight.has(user.id)) throw new HttpError(409, 'Another answer is running. Please retry.');
    if (isChat) inFlight.add(user.id);
    try {
      const record = await store.load(user.id);
      const state = { data: record.payload, dirty: false, user, config, dailyLimit, credential: () => credential(user, token) };
      await compat.context.run(state, async () => {
        let answer;
        if (url.pathname === '/api/chat' && req.method === 'POST') {
          await store.quota('answers:' + user.id, dailyLimit, 86400000);
          const input = await body(req);
          const streamId = compat.startSse(res);
          const keepAlive = setInterval(() => { if (!res.writableEnded) res.write(': waiting\n\n'); }, 10000);
          keepAlive.unref();
          try {
            const question = compat.promptFromChat(input);
            answer = await compat.requestCompletionStream(null, input, delta => compat.writeSseDelta(res, delta));
            compat.rememberConversation(input, question, answer);
            await store.authorize(token);
            if (state.dirty) await store.save(user.id, record.version, state.data);
            return compat.finishSse(res, streamId);
          } catch (error) {
            return compat.writeSseError(res, error, streamId);
          } finally { clearInterval(keepAlive); }
        }
        if (url.pathname === '/library/import' && req.method === 'POST') {
          const input = await body(req);
          if (!Array.isArray(input.items) || input.items.length > 10) throw new HttpError(400, 'Invalid documents.');
          const target = input.kind === 'resume' ? state.data.resumes : state.data.documents;
          const imported = input.items.map(item => ({ id: require('node:crypto').randomUUID(), userId: user.id,
            title: String(item.title || '').slice(0, 256), fileName: String(item.fileName || '').slice(0, 256),
            mimeType: String(item.mimeType || ''), fileSizeBytes: Number(item.fileSizeBytes || 0),
            content: String(item.content || ''), rawBase64: item.mimeType === 'application/pdf' ? String(item.rawBase64 || '') : '',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
          target.unshift(...imported); state.dirty = true;
          answer = { canceled: false, imported: imported.map(({ id, title }) => ({ id, title })) };
        } else if (url.pathname.startsWith('/api/trpc/') && ['GET', 'POST'].includes(req.method)) {
          const names = decodeURIComponent(url.pathname.slice(10)).split(',');
          if (names.length > 30) throw new HttpError(400, 'Too many operations.');
          const inputs = req.method === 'GET' ? JSON.parse(url.searchParams.get('input') || '{}') : await body(req);
          const values = [];
          for (let index = 0; index < names.length; index++) values.push({ result: { data: compat.superjson(await compat.handleProcedure(names[index], compat.getInput(inputs, index))) } });
          answer = url.searchParams.get('batch') === '1' || names.length > 1 ? values : values[0];
        } else throw new HttpError(404, 'Route not found.');
        await store.authorize(token);
        if (state.dirty) await store.save(user.id, record.version, state.data);
        json(res, 200, answer);
      });
    } finally { if (isChat) inFlight.delete(user.id); }
  } catch (error) {
    if (!res.headersSent) json(res, error.status || 500, { error: { json: { message: error.status ? error.message : 'Server request failed.', code: -32603, data: { httpStatus: error.status || 500 } } } });
    else res.end();
  }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
server.on('upgrade', async (req, socket, head) => {
  let upstream;
  try {
    const url = new URL(req.url, 'http://server');
    const ticket = url.searchParams.get('ticket');
    const item = tickets.get(ticket); tickets.delete(ticket);
    if (url.pathname !== '/realtime' || !item || item.expires <= Date.now()) throw Error('Invalid ticket');
    const user = await store.authorize(item.token);
    const active = streams.get(user.id) || new Set();
    if (active.size >= 2) throw Error('Too many streams');
    streams.set(user.id, active);
    const entry = { close: () => upstream?.terminate() }; active.add(entry);
    const release = () => { active.delete(entry); if (!active.size) streams.delete(user.id); };
    try {
      if (env.TRANSCRIPTION_PROVIDER === 'deepgram') {
        const q = new URLSearchParams({ model: env.DEEPGRAM_MODEL || 'nova-3', encoding: 'linear16', sample_rate: '16000', channels: '1', interim_results: 'true', punctuate: 'true', smart_format: 'true', diarize: 'true', endpointing: '300' });
        upstream = new WebSocket('wss://api.deepgram.com/v1/listen?' + q, { headers: { Authorization: 'Token ' + env.DEEPGRAM_API_KEY }, handshakeTimeout: 15000, maxPayload: 1024 * 1024 });
      } else upstream = new WebSocket('wss://eu.rt.speechmatics.com/v2', { headers: { Authorization: 'Bearer ' + env.SPEECHMATICS_API_KEY }, handshakeTimeout: 15000, maxPayload: 1024 * 1024 });
      await new Promise((resolve, reject) => { upstream.once('open', resolve); upstream.once('error', reject); });
      await store.authorize(item.token);
      wss.handleUpgrade(req, socket, head, downstream => {
        let closed = false;
        const close = () => { if (closed) return; closed = true; clearInterval(check); clearTimeout(maxDuration); downstream.close(1008, 'Session ended'); upstream.terminate(); release(); };
        entry.close = close;
        let checking = false;
        const check = setInterval(async () => { if (checking) return; checking = true; try { await store.authorize(item.token); } catch { close(); } finally { checking = false; } }, dependencies.checkInterval || 15000);
        const maxDuration = setTimeout(close, 60 * 60000);
        downstream.on('message', (data, binary) => { if (upstream.bufferedAmount > 2 * 1024 * 1024) return close(); if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary }); });
        upstream.on('message', (data, binary) => { if (downstream.bufferedAmount > 2 * 1024 * 1024) return close(); if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary }); });
        downstream.on('close', close); downstream.on('error', close); upstream.on('close', close); upstream.on('error', close);
      });
    } catch (e) { release(); throw e; }
  } catch { upstream?.terminate(); socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
});
server.requestTimeout = 130000;
server.headersTimeout = 15000;
return { server, close() { clearInterval(ticketCleanup); for (const entries of streams.values()) for (const entry of entries) entry.close(); server.close(); server.closeAllConnections(); } };
}
module.exports = { createService, serverSettings };
if (require.main === module) {
  const service = createService(process.env);
  service.server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Omer license server ready'));
  process.on('SIGTERM', () => service.close());
}
