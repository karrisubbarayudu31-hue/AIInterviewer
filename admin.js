"use strict";
// Owner-only tool. Credentials come from environment, never command-line arguments.
const { makeStore, hash, secret } = require('./store');
async function main() {
  const store = makeStore(process.env);
  const [action, value, days = '30'] = process.argv.slice(2);
  if (action === 'issue') {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value || '') || !Number.isInteger(Number(days)) || Number(days) < 1 || Number(days) > 3650) throw Error('Usage: node admin.js issue email@example.com 30');
    const key = 'omer_' + secret();
    const result = await store.call('/rest/v1/omer_licenses', { method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ email: value.trim().toLowerCase(), key_hash: hash(key), expires_at: new Date(Date.now() + Number(days) * 86400000).toISOString() }) });
    console.log('License ID: ' + result[0].id + '\nLicense key (shown only now): ' + key);
  } else if (action === 'revoke') {
    if (!/^[0-9a-f-]{36}$/i.test(value || '')) throw Error('Provide the license UUID.');
    const result = await store.call('/rest/v1/omer_licenses?id=eq.' + value, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ revoked: true }) });
    if (!result.length) throw Error('License not found.');
    console.log('License revoked. New requests are denied; active streams stop on their next check.');
  } else if (action === 'list') {
    console.table(await store.rows('omer_licenses', 'select=id,email,revoked,expires_at,user_id&order=created_at.desc'));
  } else throw Error('Use issue <email> <days>, revoke <license-id>, or list.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
