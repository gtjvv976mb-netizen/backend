/* Isolated FULL server integration. Real generated Ed25519 sign-ins and actual
 * server-issued asset fixtures; only the exclusive persistence lease is synthetic.
 * No .env, production requests, funded keys, chain submitter or public-cert claim.
 * Run directly: node chikiseum-live-server.test.mjs [/private/tmp/output-prefix]
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import net from 'node:net';
const folder = dirname(fileURLToPath(import.meta.url));
const prefix = process.argv[2] ?? '/private/tmp/chikiseum-full-real-server-qa-v1';
const sourceFiles = ['server.js', 'pvp-engine.js', 'chikiseum-live-service.js', 'chikiseum-live-engine.js',
  'chikiseum-live-navigation.js', 'chikiseum-live-progression.js', 'chikiseum-live-lease.js',
  'chikiseum-profiles.json', 'chikiseum_reference_arena_v2.json', 'chikiseum-live-server.test.mjs'];
const sha = raw => createHash('sha256').update(raw).digest('hex');
const pins = () => Object.fromEntries(sourceFiles.map(p => [p, sha(readFileSync(resolve(folder, p)))]));
const before = pins();
if (existsSync(resolve(folder, '.env'))) throw new Error('Isolated checkout must not contain .env');
const reservation = net.createServer();
await new Promise((ok, no) => { reservation.once('error', no); reservation.listen(0, '127.0.0.1', ok); });
const port = reservation.address().port; await new Promise(ok => reservation.close(ok));
const treasury = nacl.sign.keyPair();
process.env.RPC_URL = 'http://127.0.0.1:59999';
process.env.TREASURY_SECRET = JSON.stringify(Array.from(treasury.secretKey));
process.env.VERIFY_HOLDERS = 'false'; process.env.NETWORK = 'devnet'; process.env.PORT = String(port);
process.env.CHIKISEUM_LIVE_ENABLED = '0'; process.env.CHIK_SYNC_RT = '1';
delete process.env.DATABASE_URL; delete process.env.RENDER;
const BASE = `http://127.0.0.1:${port}`, P = '/chikiseum/live/v1';
const checks = [];
const diagnosticLines = [];
const check = (condition, label) => { checks.push({ pass: !!condition, label }); const line = `${condition ? 'PASS' : 'FAIL'} ${label}`; diagnosticLines.push(line); console.log(line); };
const pause = ms => new Promise(ok => setTimeout(ok, ms));
const post = async (path, body, extraHeaders = {}) => {
  if (!path.startsWith('/')) throw new Error('Only local test routes are permitted');
  const response = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body), signal: AbortSignal.timeout(6000) });
  return { status: response.status, data: await response.json() };
};
const get = async path => {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(6000) }); return { status: r.status, data: await r.json() };
};
let requestCounter = 0, service, fatal = null, writes = 0, leaseCloses = 0, durable = null;
const lease = { valid: true, fixture_only: true, async read() { return durable && structuredClone(durable); },
  async write(key, data) { if (key !== 'chikiseum_live_v1' || !this.valid) throw new Error('Fixture lease misuse'); durable = structuredClone(data); writes++; },
  async ping() { if (!this.valid) throw new Error('Fixture lease closed'); }, async close() { this.valid = false; leaseCloses++; } };
const rpc = async (who, route, payload = {}) => post(P + '/' + route, { ...who.auth, ...payload });
const command = async (who, route, payload = {}) => {
  const r = await rpc(who, route, payload); check(r.status === 200, `${route}: authenticated owner accepted (${r.status}/${r.data.code ?? 'ok'})`);
  if (r.status !== 200) throw new Error(`Owner ${route} failed with ${r.status}/${r.data.code}`); return r.data;
};
const rid = type => `server-fixture-${type}-${++requestCounter}`;
async function proven(kp = nacl.sign.keyPair()) {
  const wallet = bs58.encode(kp.publicKey), msg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(msg, 'utf8'), kp.secretKey)).toString('base64');
  const v = await post('/verify', { wallet, netId: rid('signin'), authMsg: msg, authSig: sig });
  check(v.status === 200 && v.data.signedIn === true, 'real /verify validates generated wallet signature');
  check(typeof v.data.mktToken === 'string' && v.data.mktToken.length >= 24 && typeof v.data.sessionId === 'string' && v.data.sessionId.length >= 16,
    'real /verify issues wallet-bound token and current session');
  check(Number.isInteger(v.data.sessionEpoch) && v.data.sessionEpoch >= 1, 'real /verify supplies authoritative live epoch');
  return { kp, auth: { wallet, mktToken: v.data.mktToken, sessionId: v.data.sessionId, sessionEpoch: v.data.sessionEpoch } };
}
async function newMatch(A, B) {
  const searching = await command(A, 'queue'); check(searching.searching === true && searching.match_id === null, 'first human waits in bounded queue');
  const matched = await command(B, 'queue'); check(matched.searching === false && typeof matched.match_id === 'string', 'second real human pairs without AI');
  const mid = matched.match_id; const first = await command(A, 'ready', { match_id: mid }); check(first.status === 'ready', 'one ready is insufficient to start');
  const active = await command(B, 'ready', { match_id: mid });
  check(active.status === 'active' && active.combat_mode === 'realtime' && active.turn === 0, 'both ready start simultaneous realtime combat, no turn lock');
  check(active.currency === 'NONE' && active.real_sol_enabled === false && active.inventory_verified === true && active.mode === 'live', 'live snapshot is verified free-only, no credit/SOL authority');
  check(active.realtime.duration === 180 && active.realtime.remaining <= 180 && active.realtime.remaining > 178, 'server starts real 180 second match clock');
  check(active.arena.floor_radius_m === 24 && active.arena.reference_plan_sha256 === '4f37041b6c132b542284dd22c4d1b7445ccc3c3900c3ee6a6bdc58e21eea682b', 'live snapshots pin full-floor actual mesh navigation');
  return mid;
}
try {
  const srv = await import('./server.js');
  await pause(1400);
  service = srv._chikiseumServiceForTest();
  const ordinary = await get('/health'); check(ordinary.status === 200, 'legacy /health still works while new PvP disabled');
  const cupBefore = await get('/cup/status'); check(cupBefore.status === 200 && typeof cupBefore.data === 'object', 'legacy Cup status unchanged and reachable');
  const disabled = await get(P + '/health'); check(disabled.status === 503 && disabled.data.ready === false && disabled.data.reason === 'disabled', 'real server default new live namespace fails closed');
  const A = await proven(), B = await proven(), C = await proven();
  const disabledPrivate = await rpc(A, 'roster'); check(disabledPrivate.status === 503, 'auth does not bypass disabled durable service');
  const unsignedWallet = bs58.encode(nacl.sign.keyPair().publicKey);
  const unsigned = await post('/verify', { wallet: unsignedWallet });
  check(unsigned.data.signedIn === false && !unsigned.data.mktToken && !unsigned.data.sessionId, 'unsigned /verify never creates live identity credentials');
  // ONLY the module-only seam replaces persistence for this isolated test process.
  service.enabled = true; service.closed = false; service.leaseFactory = async () => lease;
  check(await service.boot(), 'real server callbacks boot with explicit synthetic exclusive test lease'); service.start();
  const health = await get(P + '/health'); check(health.status === 200 && health.data.ready && health.data.rewards === false && health.data.entry_stake === 0, 'test-only ready health is explicitly no-stakes/no-rewards');
  const normalA = srv._mintHatchedForTest('chikimon', A.auth.wallet, { sp: 'firix', kind: 'normal', lvl: 30 });
  const normalB = srv._mintHatchedForTest('chikimon', B.auth.wallet, { sp: 'firix', kind: 'normal', lvl: 30 });
  const legendA = srv._mintHatchedForTest('chikimon', A.auth.wallet, { sp: 'galador', kind: 'legendary', lvl: 30 });
  const legendB = srv._mintHatchedForTest('chikimon', B.auth.wallet, { sp: 'galador', kind: 'legendary', lvl: 30 });
  const legendC = srv._mintHatchedForTest('chikimon', C.auth.wallet, { sp: 'galador', kind: 'legendary', lvl: 30 });
  for (const [patch, label] of [
    [{ mktToken: '' }, 'empty token'], [{ mktToken: B.auth.mktToken }, 'other-wallet token'],
    [{ sessionId: '' }, 'empty session'], [{ sessionId: B.auth.sessionId }, 'other-wallet session'],
    [{ sessionId: 'guessed-session' }, 'guessed session'], [{ sessionEpoch: A.auth.sessionEpoch + 1 }, 'wrong epoch'],
    [{ sessionEpoch: 0 }, 'legacy missing epoch'], [{ wallet: B.auth.wallet }, 'claimed other wallet']]) {
    const r = await post(P + '/roster', { ...A.auth, ...patch }); check(r.status === 401, `real callbacks reject ${label}`);
  }
  for (const key of ['wallet', 'mktToken', 'sessionId', 'sessionEpoch']) {
    const body = { ...A.auth }; delete body[key]; const r = await post(P + '/roster', body); check(r.status === 400, `required auth field ${key} cannot be omitted`);
  }
  const hostile = await post(P + '/roster', A.auth, { Origin: 'https://evil.invalid' }); check(hostile.status === 403 && hostile.data.code === 'ORIGIN_DENIED', 'real namespace rejects hostile web origin');
  for (const extra of [{ level: 30 }, { hp: 9999 }, { species: 'doge' }, { damage: 9999 }, { stake: 1 }, { currency: 'SOL' }, { slots: [6] }, { winner: 'A' }]) {
    const r = await rpc(A, 'session', { asset_id: normalA.id, ...extra }); check(r.status === 400, 'client fighter/stat/money/outcome extras rejected by real HTTP whitelist');
  }
  const missing = await rpc(A, 'session', { asset_id: 'made-up-asset' }); check(missing.status === 403, 'fake owned asset cannot be admitted');
  const stolen = await rpc(A, 'session', { asset_id: legendB.id }); check(stolen.status === 403, 'real registry prevents selecting rival asset');
  const roster = await command(A, 'roster'); check(roster.schema === 'chikiseum.live-roster/v1' && roster.fighters.length === 2, 'actual owned normal and legendary registry assets are listed');
  check(roster.fighters.every(x => x.level === 1 && x.xp === 0), 'client-authored MMO registry level30 does not elevate separate PvP level1');
  check(roster.fighters.every(x => x.eligible), 'clean hatched registry fixtures pass actual eligibility gate');
  const sA = await command(A, 'session', { asset_id: normalA.id }), sB = await command(B, 'session', { asset_id: normalB.id });
  check(sA.fighter.species === 'firix' && sA.fighter.level === 1 && sA.fighter.rarity === 'normal', 'normal admission is rebuilt by server canonical roster/earned level');
  check(sA.schema === 'chikiseum.live-session/v1' && !sA.token && sA.fighter.asset_id === normalA.id, 'live admission binds exact own asset, no practice bearer');
  const normalMid = await newMatch(A, B); const normalState = await command(A, 'state', { match_id: normalMid });
  check(normalState.you.hand.length === 3 && normalState.you.asset_id === normalA.id, 'normal kit privately renders exact original three-card hand');
  await command(A, 'cancel', { match_id: normalMid });
  check((await command(B, 'state', { match_id: normalMid })).status === 'forfeit', 'active cancel releases match and marks server forfeit');
  check(service.engine.drainCompletions().length === 0, 'cancelled/forfeit match never emits XP completion');
  const la = await command(A, 'session', { asset_id: legendA.id }), lb = await command(B, 'session', { asset_id: legendB.id });
  await command(C, 'session', { asset_id: legendC.id });
  check(la.fighter.rarity === 'legendary' && la.fighter.max_hp > sA.fighter.max_hp, 'canonical legendary rarity advantage retained with separate PvP levels');
  const mid = await newMatch(A, B); const a0 = await command(A, 'state', { match_id: mid });
  check(a0.you.hand.length === 12 && a0.you.asset_id === legendA.id, 'legendary kit privately renders all twelve original ability slots');
  check(a0.players.every(p => p.asset_id === undefined && p.slots === undefined), 'public players hide owned asset IDs and actual hand');
  const outsider = await rpc(C, 'state', { match_id: mid }); check(outsider.status === 403 && outsider.data.code === 'PRIVATE_VIEW_DENIED', 'real authenticated third player cannot read rival private match');
  const casts = await Promise.all([rpc(A, 'cast', { match_id: mid, slot: 0, request_id: 'real-human-cast-A-one' }), rpc(B, 'cast', { match_id: mid, slot: 0, request_id: 'real-human-cast-B-one' })]);
  check(casts.every(x => x.status === 200 && x.data.cast_queued === true && x.data.cast_ack === x.data.you.cast_ack), 'two actual owners cast immediately with own exact ACK');
  check(casts[0].data.players[1].hp === a0.players[1].hp, 'accepted cast snapshot does not optimistically invent rival damage');
  await pause(150); const resolved = await command(A, 'state', { match_id: mid });
  check(resolved.players.every(p => p.hp < p.max_hp), 'both attacks resolve from real server ticks without opponent confirmation');
  check(resolved.events.filter(e => e.type === 'impact').length === 2 && resolved.events.every(e => e.confirmed && !e.request_id), 'confirmed public events preserve both real casts without private request IDs');
  check(resolved.events.filter(e => e.type === 'cast').every(e => e.species === 'galador' && e.slot === 0 && e.card_key === 'galador:0'), 'real HTTP confirmed casts preserve exact ability sprite identity');
  const replay = await command(A, 'cast', { match_id: mid, slot: 0, request_id: 'real-human-cast-A-one' });
  check(replay.cast_queued === false && replay.cast_ack === 'real-human-cast-A-one' && replay.you.cast_ack === replay.cast_ack, 'completed replay acknowledges same request without recasting');
  check(replay.events.filter(e => e.type === 'impact').length === 2, 'idempotent real HTTP cast replay adds no extra damage event');
  const cold = await rpc(A, 'cast', { match_id: mid, slot: 0, request_id: rid('cooldown') }); check(cold.status === 409 && cold.data.code === 'COOLDOWN', 'real server rejects early card cooldown recast');
  await pause(65); const moved = await command(A, 'move', { match_id: mid, dx: 0, dz: 1, request_id: 'real-human-move-A-one' });
  check(moved.players[0].position.z > 0 && moved.players[0].position.z <= .76 + 1e-6, 'actual owner movement uses server elapsed cap, no caller coordinates');
  const movedReplay = await command(A, 'move', { match_id: mid, dx: 0, dz: 1, request_id: 'real-human-move-A-one' });
  check(movedReplay.players[0].position.z === moved.players[0].position.z, 'movement ACK replay cannot advance twice');
  const badMove = await rpc(A, 'move', { match_id: mid, dx: 1, dz: 0, request_id: 'real-human-move-A-one' }); check(badMove.status === 400, 'movement ID cannot be reused for a different intent');
  const fakePosition = await rpc(A, 'move', { match_id: mid, dx: 0, dz: 1, request_id: rid('fakepos'), x: 23 }); check(fakePosition.status === 400, 'authoritative movement rejects client destination');
  await pause(200); const regen = await command(A, 'state', { match_id: mid }); check(regen.players[0].energy > replay.players[0].energy && regen.players[0].energy <= 6, 'fractional energy regenerates on server clock');
  const Anew = await proven(A.kp);
  const stale = await rpc(A, 'state', { match_id: mid }); check(stale.status === 401, 'actual newer /verify invalidates prior signed session immediately');
  const fresh = await command(Anew, 'session', { asset_id: legendA.id });
  check(fresh.trainer_id !== la.trainer_id && !service.engine.admissions.has(la.trainer_id), 'new login retires old exact session admission before rematch');
  const oldOpponent = await command(B, 'state', { match_id: mid }); check(oldOpponent.status === 'forfeit' && oldOpponent.winner === 'B', 'session revocation forfeits old duel on server, not hidden optimistic UI');
  const secondMid = await newMatch(Anew, B);
  check(srv._transferAssetForTest(legendA.id, A.auth.wallet, C.auth.wallet, 'chikiseum-local-integration-fixture'), 'actual registry fixture transfers ownership');
  const lost = await rpc(Anew, 'state', { match_id: secondMid }); check(lost.status === 403 && lost.data.code === 'ASSET_UNAVAILABLE', 'actual owned registry recheck prevents playing sold/transferred fighter');
  const kept = await command(B, 'state', { match_id: secondMid }); check(kept.status === 'forfeit' && kept.winner === 'B', 'ownership loss retires real active duel with safe opponent outcome');
  check(service.engine.drainCompletions().length === 0, 'revocation/session/ownership forfeits never award progression');
  // Existing legacy protocol is exercised unchanged, not silently redirected to live.
  const snap = { element: 'Fire', name: 'Legacy fixture', br: 8, cardTier: 1, arenaSkills: [] };
  const challenge = await post('/pvp/challenge', { from: B.auth.wallet, to: C.auth.wallet, snap, mktToken: B.auth.mktToken });
  check(challenge.status === 200, 'legacy /pvp/challenge remains existing protocol');
  const inbox = await post('/pvp/available', { wallet: C.auth.wallet, snap, mktToken: C.auth.mktToken });
  const invitation = inbox.data.challenges?.find(c => c.from === B.auth.wallet);
  const legacy = await post('/pvp/challenge/accept', { wallet: C.auth.wallet, challengeId: invitation?.id, snap, mktToken: C.auth.mktToken });
  check(legacy.data.ok === true && typeof legacy.data.sec === 'string', 'legacy accept still returns its existing per-match secret');
  const legacyState = await get(`/pvp/state?matchId=${legacy.data.matchId}&wallet=${C.auth.wallet}`);
  check(legacyState.data.status === 'active' && legacyState.data.combat_mode !== 'realtime', 'legacy state remains turn PvP, not new live namespace');
  const unauthorizedLegacy = await post('/pvp/forfeit', { wallet: C.auth.wallet, matchId: legacy.data.matchId }); check(!!unauthorizedLegacy.data.error, 'legacy mutation secret gate is not weakened');
  const legacyForfeit = await post('/pvp/forfeit', { wallet: C.auth.wallet, matchId: legacy.data.matchId, sec: legacy.data.sec }); check(legacyForfeit.data.ok === true, 'legacy rightful player can still forfeit');
  const cupAfter = await get('/cup/status'); check(JSON.stringify(cupBefore.data) === JSON.stringify(cupAfter.data), 'new free duels leave legacy Cup state byte-identical');
  const invalidCup = await post('/cup/register', { wallet: 'invalid-wallet' }); check(invalidCup.status === 400, 'legacy Cup validation still rejects invalid wallet');
  check((await get('/health')).status === 200, 'legacy general health remains healthy after real live gameplay');
  await service.stop(); check(leaseCloses === 1 && writes > 0 && durable?.schema === 'chikiseum.live-store/v1', 'test lease receives real durable checkpoints and closes cleanly');
  check(Object.keys(durable.progression.receipts).length === 0, 'fixture forfeits/cancels did not alter server-earned XP receipts');
} catch (error) {
  fatal = { name: error.name, message: error.message }; diagnosticLines.push('FIXTURE_FATAL ' + fatal.message); console.error('FIXTURE_FATAL', fatal.message);
  try { await service?.stop(); } catch {}
}
const after = pins(); check(JSON.stringify(before) === JSON.stringify(after), 'all integration sources remained frozen during test');
const failures = checks.filter(c => !c.pass).length + (fatal ? 1 : 0);
const diagnosticLog = diagnosticLines.join('\n') + '\n'; writeFileSync(prefix + '.log', diagnosticLog);
const receipt = { schema: 'chikiseum.full-real-server-integration-qa/v1', fixture_only: true,
  production_authentication_proven: false, production_deployment_performed: false, activation_authorized: false,
  real_sol_enabled: false, funded_keys_used: false, production_requests: 0, synthetic_snapshots_used: false,
  real_ed25519_verify: true, real_server_asset_registry: true, synthetic_exclusive_lease_only: true,
  database: 'isolated_memory_fixture', passed: checks.filter(c => c.pass).length, failed: failures, fatal,
  raw_assertion_log: prefix + '.log', raw_assertion_log_sha256: sha(diagnosticLog),
  checks, source_sha256: before, source_after_sha256: after, store_writes: writes, generated_at: new Date().toISOString() };
const raw = JSON.stringify(receipt, null, 2) + '\n'; writeFileSync(prefix + '.json', raw);
console.log('CHIKISEUM_FULL_SERVER_QA_DONE ' + JSON.stringify({ passed: receipt.passed, failed: failures, receipt: prefix + '.json', sha256: sha(raw) }));
process.exit(failures ? 1 : 0);
