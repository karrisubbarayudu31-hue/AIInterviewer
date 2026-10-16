"use strict";
const { createHash, randomBytes } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function makeStore(env, fetcher = fetch) {
  const base = new URL(env.SUPABASE_URL);
  if (base.protocol !== 'https:') throw Error('SUPABASE_URL must use HTTPS');
  // New secret keys authenticate through apikey; only legacy JWTs belong in Bearer.
  const serverKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const apiHeaders = { apikey: serverKey,
    ...(serverKey.startsWith('sb_secret_') ? {} : { authorization: 'Bearer ' + serverKey }) };
  async function call(path, options = {}) {
    const response = await fetcher(new URL(path, base), {
      ...options, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { ...apiHeaders,
        'content-type': 'application/json', ...options.headers }
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new HttpError(response.status === 409 ? 409 : 503, 'Account service unavailable. Please retry.');
    return value;
  }
  const rows = (table, query) => call('/rest/v1/' + table + '?' + query);
  async function license(userId) {
    const found = await rows('omer_licenses', 'user_id=eq.' + encodeURIComponent(userId) + '&select=*');
    const item = found[0];
    if (!item || item.revoked || Date.parse(item.expires_at) <= Date.now()) throw new HttpError(403, 'Your license is inactive, expired, or revoked.');
    return item;
  }
  async function sessionFor(token) {
    if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) throw new HttpError(401, 'Please sign in.');
    const found = await rows('omer_sessions', 'token_hash=eq.' + hash(token) + '&select=*');
    const item = found[0];
    if (!item || Date.parse(item.expires_at) <= Date.now()) throw new HttpError(401, 'Your session has expired. Please sign in.');
    return item;
  }
  async function authorize(token) {
    const item = await sessionFor(token);
    const active = await license(item.user_id);
    return { id: item.user_id, email: active.email, license: active, expiresAt: item.expires_at };
  }
  async function prepareChat(token, dailyLimit) {
    const item = await sessionFor(token);
    // No authorization cache: check the current license on every answer.
    // Only a valid session may start these independent database operations.
    const [active, record] = await Promise.all([
      license(item.user_id), load(item.user_id),
      quota('requests:' + item.user_id, 600, 60000),
      quota('answers:' + item.user_id, dailyLimit, 86400000)
    ]);
    return { user: { id: item.user_id, email: active.email, license: active, expiresAt: item.expires_at }, record };
  }
  async function quota(bucket, limit, milliseconds) {
    const slot = Math.floor(Date.now() / milliseconds);
    const allowed = await call('/rest/v1/rpc/omer_take_quota', { method: 'POST', body: JSON.stringify({
      p_bucket: bucket + ':' + slot, p_limit: limit, p_expires: new Date((slot + 1) * milliseconds).toISOString()
    }) });
    if (!allowed) throw new HttpError(429, 'Usage limit reached. Please try later.');
  }
  async function login(input) {
    const email = String(input.email || '').trim().toLowerCase();
    if (!email || email.length > 254 || typeof input.password !== 'string' || input.password.length > 1024) throw new HttpError(400, 'Enter your email and password.');
    await quota('login:' + hash(email), 10, 600000);
    const response = await fetcher(new URL('/auth/v1/token?grant_type=password', base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { apikey: serverKey, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: input.password })
    });
    const auth = await response.json();
    if (!response.ok || !auth.user?.id || !auth.user.email_confirmed_at) throw new HttpError(401, 'Sign-in failed. Check your credentials and confirm your email.');
    const id = auth.user.id;
    if (input.licenseKey) {
      const found = await rows('omer_licenses', 'key_hash=eq.' + hash(String(input.licenseKey).trim()) + '&select=*');
      const item = found[0];
      if (!item || item.email.toLowerCase() !== email || item.revoked || Date.parse(item.expires_at) <= Date.now() || (item.user_id && item.user_id !== id)) throw new HttpError(403, 'License activation failed. Contact the owner.');
      if (!item.user_id) await call('/rest/v1/omer_licenses?id=eq.' + item.id + '&user_id=is.null&revoked=eq.false', {
        method: 'PATCH', body: JSON.stringify({ user_id: id })
      });
    }
    const active = await license(id);
    const token = secret();
    const expiresAt = new Date(Math.min(Date.now() + 8 * 3600000, Date.parse(active.expires_at))).toISOString();
    await call('/rest/v1/omer_sessions', { method: 'POST', body: JSON.stringify({ token_hash: hash(token), user_id: id, expires_at: expiresAt }) });
    return { token, expiresAt, email };
  }
  async function load(id) {
    const found = await rows('omer_data', 'user_id=eq.' + id + '&select=*');
    return found[0] || { version: 0, payload: { sessions: [], resumes: [], documents: [], transcripts: {}, messages: {} } };
  }
  async function save(id, version, payload) {
    if (Buffer.byteLength(JSON.stringify(payload)) > 9 * 1024 * 1024) throw new HttpError(413, 'Cloud data limit reached. Remove old sessions or documents.');
    if (!version) return call('/rest/v1/omer_data', { method: 'POST', body: JSON.stringify({ user_id: id, version: 1, payload }) });
    const result = await call('/rest/v1/omer_data?user_id=eq.' + id + '&version=eq.' + version, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ version: version + 1, payload })
    });
    if (!result.length) throw new HttpError(409, 'Data changed in another request. Please retry.');
  }
  return { call, rows, license, authorize, prepareChat, quota, login, load, save };
}
module.exports = { makeStore, hash, secret, HttpError };
