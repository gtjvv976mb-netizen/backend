/* PERSISTENT LOCAL QA HOST — never production or public human proof.
 * Uses the actual server and signature/registry callbacks. Only the exclusive
 * persistence lease is synthetic. No funded keys or chain operations.
 * node chikiseum-live-native-host.mjs [private_metadata_path] [optional_port]
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import net from 'node:net';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const folder = dirname(fileURLToPath(import.meta.url));
const metadataPath = process.argv[2] ?? `/private/tmp/chikiseum-live-native-auth-${process.pid}.json`;
if (!metadataPath.startsWith('/private/tmp/') || existsSync(metadataPath) || existsSync(resolve(folder, '.env')))
  throw new Error('Fresh private/tmp metadata and an isolated checkout without .env required');
const serverSource = readFileSync(resolve(folder, 'server.js'), 'utf8');
if (!serverSource.includes('BIND_HOST')) throw new Error('Actual server must support the reviewed loopback bind before QA host starts');
let port = Number(process.argv[3] ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid QA port');
if (!port) {
  const reservation = net.createServer();
  await new Promise((ok, no) => { reservation.once('error', no); reservation.listen(0, '127.0.0.1', ok); });
  port = reservation.address().port; await new Promise(ok => reservation.close(ok));
}
const ephemeralTreasury = nacl.sign.keyPair();
process.env.RPC_URL = 'http://127.0.0.1:59999'; process.env.TREASURY_SECRET = JSON.stringify(Array.from(ephemeralTreasury.secretKey));
process.env.VERIFY_HOLDERS = 'false'; process.env.NETWORK = 'devnet'; process.env.PORT = String(port);
process.env.BIND_HOST = '127.0.0.1'; process.env.CHIKISEUM_LIVE_ENABLED = '0'; process.env.CHIK_SYNC_RT = '1';
delete process.env.DATABASE_URL; delete process.env.RENDER;
const base = `http://127.0.0.1:${port}`, prefix = '/chikiseum/live/v1';
const post = async (path, body) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(6000) });
  const value = await r.json(); if (!r.ok) throw new Error(`Local host ${path} failed ${r.status}/${value.code ?? 'error'}`); return value;
};
const srv = await import('./server.js');
ephemeralTreasury.secretKey.fill(0); delete process.env.TREASURY_SECRET;
await new Promise(ok => setTimeout(ok, 1400));
const service = srv._chikiseumServiceForTest();
const disabled = await fetch(base + prefix + '/health');
if (disabled.status !== 503) throw new Error('Feature flag must initially fail closed');
let durable = null;
const lease = { valid: true, fixture_only: true, async read() { return durable && structuredClone(durable); },
  async write(key, value) { if (!this.valid || key !== 'chikiseum_live_v1') throw new Error('Fixture persistence lease unavailable'); durable = structuredClone(value); },
  async ping() { if (!this.valid) throw new Error('Fixture lease closed'); }, async close() { this.valid = false; } };
service.enabled = true; service.closed = false; service.leaseFactory = async () => lease;
if (!(await service.boot())) throw new Error('Actual server auth/ownership callbacks could not boot'); service.start();
const players = {};
for (const side of ['A', 'B']) {
  const kp = nacl.sign.keyPair(), wallet = bs58.encode(kp.publicKey);
  const message = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(message, 'utf8'), kp.secretKey)).toString('base64');
  const verified = await post('/verify', { wallet, netId: `local-auth-QA-${side}-${process.pid}`, authMsg: message, authSig: signature });
  kp.secretKey.fill(0);
  if (!verified.signedIn || !verified.mktToken || !verified.sessionId || !Number.isInteger(verified.sessionEpoch)) throw new Error('Actual wallet verification failed');
  const auth = { wallet, mktToken: verified.mktToken, sessionId: verified.sessionId, sessionEpoch: verified.sessionEpoch };
  const row = srv._mintHatchedForTest('chikimon', wallet, { sp: 'galador', kind: 'legendary', lvl: 1 });
  const roster = await post(prefix + '/roster', auth), selected = roster.fighters.find(x => x.asset_id === row.id && x.eligible === true);
  if (!selected || selected.level !== 1) throw new Error('Actual server-owned fixture was not admitted by roster');
  players[side] = { auth, asset_id: row.id, canonical_species: selected.species, pvp_level: selected.level };
}
const sources = ['server.js', 'chikiseum-live-service.js', 'chikiseum-live-engine.js', 'chikiseum-live-navigation.js',
  'chikiseum-live-progression.js', 'chikiseum-live-lease.js', 'chikiseum-profiles.json', 'chikiseum_reference_arena_v2.json', 'chikiseum-live-native-host.mjs'];
const metadata = { schema: 'chikiseum.local-authenticated-native-fixture/v1', fixture_only: true,
  label: 'AUTOMATED SIGNED-WALLET FIXTURE • SYNTHETIC TEST LEASE • NOT PUBLIC HUMAN PROOF',
  contains_ephemeral_credentials: true, contains_private_keys: false, private_mode: '0600',
  production_requests: 0, real_sol_enabled: false, base_url: base, port, server_pid: process.pid,
  bind_host: '127.0.0.1', players, source_sha256: Object.fromEntries(sources.map(file => [file,
    createHash('sha256').update(readFileSync(resolve(folder, file))).digest('hex')])), created_at: new Date().toISOString() };
const raw = JSON.stringify(metadata, null, 2) + '\n';
writeFileSync(metadataPath, raw, { mode: 0o600, flag: 'wx' }); chmodSync(metadataPath, 0o600);
console.log('CHIKISEUM_LOCAL_AUTH_HOST_READY ' + JSON.stringify({ base_url: base, metadata_path: metadataPath,
  metadata_sha256: createHash('sha256').update(raw).digest('hex'), fixture_only: true, credentials_logged: false,
  physical_bind: '127.0.0.1', signed_wallets: 2, synthetic_snapshots: false, synthetic_lease_only: true }));
// Bound the fixture's lifetime. Metadata credentials become useless when the
// isolated memory process stops. Cleanup never deletes unrelated user files.
setTimeout(async () => { try { await service.stop(); } finally { process.exit(0); } }, 30 * 60 * 1000).unref();
