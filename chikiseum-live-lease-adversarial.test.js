// Pure fake-PG protocol faults. No DB, credentials, production calls or wallet minting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { acquireChikiseumLease } from './chikiseum-live-lease.js';

function fixture({ held = true, faultAt = null, lostAt = null } = {}) {
  const client = new EventEmitter(), queries = [], releases = [], value = { schema: 'synthetic-state' };
  let count = 0, connections = 0;
  client.query = async (sql, args = []) => {
    queries.push({ sql, args }); count++;
    if (count === lostAt) client.emit('end');
    if (count === faultAt) throw new Error('synthetic PG fault');
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ held }] };
    if (sql.startsWith('SELECT v')) return { rows: [{ v: value }] };
    return { rows: [{}] };
  };
  client.release = destroy => releases.push(destroy);
  const pool = { async connect() { connections++; return client; } };
  return { pool, client, queries, releases, value, connections: () => connections };
}

test('second worker cannot read/write state and its dedicated connection is destroyed', async () => {
  const f = fixture({ held: false }); assert.equal(await acquireChikiseumLease(f.pool), null);
  assert.equal(f.queries.length, 1); assert.deepEqual(f.releases, [true]);
  assert.equal(f.client.listenerCount('error'), 0); assert.equal(f.client.listenerCount('end'), 0);
});
test('lock, read, heartbeat and write use one connection and only the arena KV key', async () => {
  const f = fixture(), lease = await acquireChikiseumLease(f.pool);
  assert.equal(lease.valid, true); assert.deepEqual(await lease.read('chikiseum_live_v1'), f.value);
  await lease.ping(); await lease.write('chikiseum_live_v1', { synthetic: true });
  assert.equal(f.connections(), 1);
  await assert.rejects(lease.read('market_tokens')); await assert.rejects(lease.write('profiles', {}));
  const writes = f.queries.filter(q => q.sql.startsWith('INSERT'));
  assert.equal(writes.length, 1); assert.equal(writes[0].args[0], 'chikiseum_live_v1');
  assert.equal(writes[0].args[1], '{"synthetic":true}');
  await lease.close(); await lease.close(); assert.deepEqual(f.releases, [true]);
  assert.equal(f.queries.filter(q => q.sql.includes('pg_advisory_unlock')).length, 1);
  assert.equal(lease.valid, false); await assert.rejects(lease.ping());
});
test('query/write fault invalidates authority; closing destroys the session once', async () => {
  const f = fixture({ faultAt: 3 }), lease = await acquireChikiseumLease(f.pool);
  await assert.rejects(lease.write('chikiseum_live_v1', { synthetic: true }));
  assert.equal(lease.valid, false); await assert.rejects(lease.read('chikiseum_live_v1'));
  await lease.close(); await lease.close(); assert.deepEqual(f.releases, [true]);
});
test('lost connection events immediately reject later commands and are detached on close', async () => {
  for (const event of ['error', 'end']) {
    const f = fixture(), lease = await acquireChikiseumLease(f.pool); f.client.emit(event, new Error('synthetic loss'));
    assert.equal(lease.valid, false); await assert.rejects(lease.ping()); await lease.close();
    assert.equal(f.client.listenerCount('error'), 0); assert.equal(f.client.listenerCount('end'), 0);
    assert.deepEqual(f.releases, [true]);
  }
});
test('acquisition/read failure cannot leak the held advisory-lock connection', async () => {
  for (const faultAt of [1, 2]) {
    const f = fixture({ faultAt }); await assert.rejects(acquireChikiseumLease(f.pool));
    assert.deepEqual(f.releases, [true]); assert.equal(f.client.listenerCount('end'), 0);
  }
});
test('an end event during acquisition may not resurrect the lease as valid', async () => {
  const f = fixture({ lostAt: 2 });
  let lease = null;
  try { lease = await acquireChikiseumLease(f.pool); } catch { /* Fail-closed acquisition is allowed. */ }
  try { assert.equal(lease?.valid ?? false, false); }
  finally { await lease?.close(); }
});
test('persistence-size bound refuses payload without invoking any DB mutation', async () => {
  const f = fixture(), lease = await acquireChikiseumLease(f.pool);
  const before = f.queries.length;
  await assert.rejects(lease.write('chikiseum_live_v1', { oversized: 'x'.repeat(32 * 1024 * 1024) }));
  assert.equal(f.queries.length, before); assert.equal(lease.valid, true); await lease.close();
});
