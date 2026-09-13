// OPT-IN isolated localhost PostgreSQL only. Never imports server.js or uses
// environment DB URLs/production credentials. The owned QA DB is left intact.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { acquireChikiseumLease } from './chikiseum-live-lease.js';
import { ChikiseumLiveService, LIVE_KEY } from './chikiseum-live-service.js';
import { ChikiseumLiveEngine } from './chikiseum-live-engine.js';
import { ChikiseumLiveNavigation } from './chikiseum-live-navigation.js';
import { ChikiseumProgressBook } from './chikiseum-live-progression.js';

const DB = 'chikiseum_lease_qa', MARKER = 'Chikiseum isolated local lease QA v1; disposable owned test database';
const connection = { host: '127.0.0.1', port: 54481, user: 'michaelkennethbrillantes',
  password: 'LOCAL_TEST_TRUST_UNUSED', ssl: false, max: 4, connectionTimeoutMillis: 3000,
  query_timeout: 12000, statement_timeout: 10000 };
const pool = (database, name) => new pg.Pool({ ...connection, database, application_name: name });
const sha = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const receipt = { schema: 'chikiseum.actual-local-postgres-qa/v1', production_calls: false,
  production_credentials: false, public_test: false, activation_authorized: false,
  host: '127.0.0.1', port: 54481, database: DB, authentication: 'isolated local trust only',
  tests: [], measurements: {}, source_sha256: {}, database_left_for_root_cleanup: true };
receipt.passed = 0; receipt.failed = 0;
for (const name of ['chikiseum-live-lease.js', 'chikiseum-live-service.js', 'chikiseum-live-engine.js',
  'chikiseum-live-progression.js', 'chikiseum-live-navigation.js', 'chikiseum-live-real-postgres.test.js']) {
  receipt.source_sha256[name] = sha(readFileSync(new URL('./' + name, import.meta.url)));
}

test('actual isolated PostgreSQL lease, progression, fault and capacity gates',
  { skip: process.env.CHIKISEUM_REAL_PG_QA !== '1' }, async t => {
    const admin = pool('postgres', 'chikiseum-real-pg-qa-admin');
    let a, b, observer;
    const at = performance.now();
    async function gate(name, body) {
      await t.test(name, async () => {
        try { await body(); receipt.passed++; }
        catch (error) { receipt.failed++; throw error; }
      });
      receipt.tests.push(name);
    }
    try {
      const info = (await admin.query("SELECT version() AS version,current_database() AS db,current_user AS username,host(inet_server_addr()) AS address,inet_server_port() AS port")).rows[0];
      assert.equal(info.db, 'postgres'); assert.equal(info.username, connection.user);
      assert.equal(info.address, '127.0.0.1'); assert.equal(info.port, connection.port);
      receipt.postgresql_version = info.version;
      const existing = (await admin.query('SELECT datname,obj_description(oid,\'pg_database\') AS marker FROM pg_database WHERE datname=$1', [DB])).rows[0];
      if (!existing) {
        await admin.query('CREATE DATABASE chikiseum_lease_qa');
        await admin.query("COMMENT ON DATABASE chikiseum_lease_qa IS 'Chikiseum isolated local lease QA v1; disposable owned test database'");
        receipt.created_fresh_database = true;
      } else { assert.equal(existing.marker, MARKER, 'Refuse any unowned existing database'); receipt.created_fresh_database = false; }
      a = pool(DB, 'chikiseum-real-pg-qa-worker-A'); b = pool(DB, 'chikiseum-real-pg-qa-worker-B');
      observer = pool(DB, 'chikiseum-real-pg-qa-observer');
      await observer.query("CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY,v JSONB NOT NULL,CONSTRAINT chikiseum_qa_atomic_guard CHECK ((v->>'schema') <> 'chikiseum.synthetic-rejected-state'))");
      await gate('two independent actual PG pools cannot both own the advisory arena lock', async () => {
        const start = performance.now(), leases = await Promise.all([acquireChikiseumLease(a), acquireChikiseumLease(b)]);
        assert.equal(leases.filter(x => x?.valid).length, 1); assert.equal(leases.filter(x => x === null).length, 1);
        receipt.measurements.concurrent_claim_ms = performance.now() - start;
        for (const lease of leases) await lease?.close();
      });
      await gate('real canonical completed combat XP persists atomically and restores exactly once', async () => {
        let now = 1000, mono = 100;
        const engineFactory = () => new ChikiseumLiveEngine({ navigation: new ChikiseumLiveNavigation(),
          clock: () => now, movementClock: () => mono });
        const completed = engineFactory();
        for (const side of ['A', 'B']) completed.admit({ id: 'trainer-' + side, wallet: 'synthetic-wallet-' + side,
          asset_id: 'synthetic-asset-' + side, species: 'galador', level: 1, handle: 'Synthetic Trainer', inventory_verified: true });
        completed.queue('trainer-A'); const mid = completed.queue('trainer-B').match_id;
        completed.ready('trainer-A', mid); completed.ready('trainer-B', mid);
        for (let i = 0; i < 8; i++) {
          now += 6; mono += 6;
          for (const side of ['A', 'B']) completed.cast('trainer-' + side, mid, 0, `actual-pg-cast-${side}-${i}`);
          now += .05; mono += .05; completed.tick();
        }
        const summaries = completed.drainCompletions(); assert.equal(summaries.length, 1);
        assert.equal(summaries[0].winner, null); assert.ok(summaries[0].players.every(p => p.cast_count === 8 && p.damage_dealt > 0));
        const next = new ChikiseumProgressBook().withCompletion(summaries[0], now).book;
        const lease = await acquireChikiseumLease(a);
        const saved = { schema: 'chikiseum.live-store/v1', progression: next.snapshot(), engine: completed.checkpoint() };
        const writeAt = performance.now(); await lease.write(LIVE_KEY, saved);
        receipt.measurements.completed_store_write_ms = performance.now() - writeAt;
        const read = (await observer.query('SELECT v FROM kv WHERE k=$1', [LIVE_KEY])).rows[0].v;
        assert.deepEqual(read, saved); await lease.close();
        const options = { authenticate: async () => null, ownedAssets: async () => [],
          leaseFactory: () => acquireChikiseumLease(b), engineFactory, clock: () => now };
        const restored = new ChikiseumLiveService(options);
        assert.equal(await restored.boot(), true);
        assert.equal(restored.book.fighter('synthetic-asset-A').xp, 22);
        assert.equal(restored.book.fighter('synthetic-asset-B').xp, 22);
        assert.equal(restored.engine.drainCompletions().length, 0);
        await restored.flush(true); await restored.flush(true);
        assert.equal(restored.book.fighter('synthetic-asset-A').xp, 22); await restored.stop();
        const second = new ChikiseumLiveService(options); assert.equal(await second.boot(), true);
        assert.equal(second.book.fighter('synthetic-asset-A').xp, 22); assert.equal(second.engine.drainCompletions().length, 0);
        await second.stop();
        receipt.measurements.real_combat_elapsed_seconds = now - 1000;
        receipt.measurements.completion_xp_per_player = 22;
        receipt.measurements.completed_store_bytes = Buffer.byteLength(JSON.stringify(saved));
      });
      await gate('concurrent observer reads see whole JSON versions, never partial UPSERT state', async () => {
        const lease = await acquireChikiseumLease(a), seen = new Set(); let done = false, observations = 0;
        const payload = i => ({ schema: 'chikiseum.pg-atomic-fixture/v1', seq: i,
          left: { seq: i, body: 'x'.repeat(8192) }, right: { seq: i, body: 'x'.repeat(8192) } });
        await lease.write(LIVE_KEY, payload(0));
        const reader = (async () => {
          while (!done) {
            const row = (await observer.query('SELECT v FROM kv WHERE k=$1', [LIVE_KEY])).rows[0].v;
            assert.equal(row.left.seq, row.seq); assert.equal(row.right.seq, row.seq);
            assert.equal(row.left.body.length, 8192); assert.equal(row.left.body, row.right.body);
            observations++; seen.add(row.seq); await delay(1);
          }
        })();
        try { for (let i = 1; i <= 20; i++) { await lease.write(LIVE_KEY, payload(i)); await delay(1); } }
        finally { done = true; await reader; await lease.close(); }
        assert.ok(observations >= 2); assert.ok(seen.size >= 2);
        receipt.measurements.atomic_observer_reads = observations; receipt.measurements.atomic_distinct_versions = seen.size;
      });
      await gate('terminating only the owned dedicated PG PID invalidates stale lease and lets a new worker claim', async () => {
        const lease = await acquireChikiseumLease(a), before = await lease.read(LIVE_KEY);
        const owners = (await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND application_name=$2 AND backend_type='client backend'", [DB, 'chikiseum-real-pg-qa-worker-A'])).rows;
        assert.equal(owners.length, 1); const pid = owners[0].pid;
        const terminated = (await observer.query('SELECT pg_terminate_backend($1) AS terminated', [pid])).rows[0].terminated;
        assert.equal(terminated, true);
        const lostAt = performance.now();
        for (let i = 0; i < 200 && lease.valid; i++) await delay(5);
        assert.equal(lease.valid, false); await assert.rejects(lease.write(LIVE_KEY, { stale_worker: true }));
        const replacement = await acquireChikiseumLease(b); assert.equal(replacement.valid, true);
        assert.deepEqual(await replacement.read(LIVE_KEY), before);
        receipt.measurements.terminated_owned_pid = pid;
        receipt.measurements.loss_to_reclaim_ms = performance.now() - lostAt;
        await lease.close(); await replacement.close();
      });
      await gate('real PG statement rejection preserves previous JSON and invalidates the writer', async () => {
        const lease = await acquireChikiseumLease(a), before = await lease.read(LIVE_KEY);
        await assert.rejects(lease.write(LIVE_KEY, { schema: 'chikiseum.synthetic-rejected-state', would_be_partial: true }), error => error.code === '23514');
        assert.equal(lease.valid, false);
        const after = (await observer.query('SELECT v FROM kv WHERE k=$1', [LIVE_KEY])).rows[0].v;
        assert.deepEqual(after, before); await lease.close();
      });
      await gate('actual database stays unchanged when the 32MiB client write guard rejects a payload', async () => {
        const lease = await acquireChikiseumLease(b), before = await lease.read(LIVE_KEY);
        await assert.rejects(lease.write(LIVE_KEY, { too_big: 'x'.repeat(32 * 1024 * 1024) }));
        assert.equal(lease.valid, true); assert.deepEqual(await lease.read(LIVE_KEY), before); await lease.close();
      });
      await gate('128 compact full-cache checkpoints persist with headroom and restore as cancelled without XP', async () => {
        const clock = () => 2000;
        const make = () => new ChikiseumLiveEngine({ navigation: new ChikiseumLiveNavigation(), clock, movementClock: () => 200, maxMatches: 128 });
        const engine = make();
        const casts = Array.from({ length: 4096 }, (_, i) => [`legal-cast-${i}`, { side: 'A', slot: 0 }]);
        const moves = Array.from({ length: 16384 }, (_, i) => [`legal-move-${i}`, ['A', 0, 1]]);
        for (let i = 0; i < 128; i++) {
          for (const side of ['A', 'B']) engine.admit({ id: `capacity-${side}-${i}`, wallet: `capacity-wallet-${side}-${i}`,
            asset_id: `capacity-asset-${side}-${i}`, species: 'galador', level: 1, handle: 'Synthetic Capacity Trainer', inventory_verified: true });
          engine.queue(`capacity-A-${i}`); const mid = engine.queue(`capacity-B-${i}`).match_id;
          engine.ready(`capacity-A-${i}`, mid); engine.ready(`capacity-B-${i}`, mid);
          const m = engine.matches.get(mid); m.cast_requests = new Map(casts); m.move_requests = new Map(moves);
          m.pending_casts = [{ side: 'A', slot: 0, request_id: 'legal-cast-4095', resolve_at: 2000.05 }];
          for (let j = 0; j < 1024; j++) engine._event(m, m.players[0], 'impact', 0, { amount: 0 });
        }
        // Only this capacity case injects bounded runtime cache/event fixtures;
        // no fabricated completed fight or XP is produced.
        const checkpoint = engine.checkpoint(), bytes = Buffer.byteLength(JSON.stringify(checkpoint));
        assert.ok(bytes < 8 * 1024 * 1024);
        for (const m of engine.matches.values()) { assert.equal(m.cast_requests.size, 4096); assert.equal(m.move_requests.size, 16384); assert.equal(m.events.length, 1024); assert.equal(m.pending_casts.length, 1); }
        const value = { schema: 'chikiseum.live-store/v1', progression: new ChikiseumProgressBook().snapshot(), engine: checkpoint };
        const lease = await acquireChikiseumLease(a), writeAt = performance.now(); await lease.write(LIVE_KEY, value);
        receipt.measurements.compact_write_ms = performance.now() - writeAt;
        const loaded = await lease.read(LIVE_KEY); assert.deepEqual(loaded, value);
        const restored = make(); assert.equal(restored.restore(loaded.engine).cancelled_on_restart, 128);
        assert.equal(restored.drainCompletions().length, 0); await lease.close();
        receipt.measurements.compact_checkpoint_bytes = bytes;
        receipt.measurements.compact_store_bytes = Buffer.byteLength(JSON.stringify(value));
        receipt.measurements.compact_jsonb_bytes = Number((await observer.query('SELECT pg_column_size(v) AS bytes FROM kv WHERE k=$1', [LIVE_KEY])).rows[0].bytes);
        receipt.measurements.capacity_matches = 128; receipt.measurements.capacity_cancelled_on_restart = 128;
        receipt.measurements.capacity_fake_completions = 0;
      });
      receipt.duration_ms = performance.now() - at;
      assert.equal(receipt.failed, 0);
      console.log('CHIKISEUM_REAL_POSTGRES_QA_JSON ' + JSON.stringify(receipt));
    } finally { await Promise.all([a?.end(), b?.end(), observer?.end(), admin.end()]); }
  });
