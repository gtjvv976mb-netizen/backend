// One PostgreSQL session owns the free arena. A second web worker fails closed, not split-brain.
// The lock and every arena-state read/write use the SAME connection; no treasury/schema mutation.
export async function acquireChikiseumLease(pool) {
  const client = await pool.connect();
  let valid = false, closed = false, held = false, connectionLost = false;
  const lost = () => { valid = false; connectionLost = true; };
  client.on('error', lost); client.on('end', lost);
  const release = () => {
    client.removeListener('error', lost); client.removeListener('end', lost);
    client.release(true); // Dedicated session must never return to the pool still holding a lock.
  };
  try {
    const result = await client.query('SELECT pg_try_advisory_lock(764081, 2) AS held');
    held = result.rows[0]?.held === true;
    if (!held) { closed = true; release(); return null; }
    await client.query('SELECT v FROM kv WHERE k=$1', ['chikiseum_live_v1']);
    if (connectionLost) throw new Error('Arena database session ended during acquisition');
    valid = true;
  } catch (error) { closed = true; release(); throw error; }
  const query = async (sql, args = []) => {
    if (!valid || closed) throw new Error('Exclusive Chikiseum database session unavailable');
    try { const r = await client.query(sql, args); if (!valid) throw new Error('Arena lease lost'); return r; }
    catch (error) { valid = false; throw error; }
  };
  return {
    get valid() { return valid && !closed; },
    async ping() { await query('SELECT 1'); },
    async read(key) {
      if (key !== 'chikiseum_live_v1') throw new Error('Arena key required');
      return (await query('SELECT v FROM kv WHERE k=$1', [key])).rows[0]?.v ?? null;
    },
    async write(key, value) {
      if (key !== 'chikiseum_live_v1') throw new Error('Arena key required');
      const raw = JSON.stringify(value);
      if (Buffer.byteLength(raw) > 32 * 1024 * 1024) throw new Error('Arena persistence capacity reached');
      await query('INSERT INTO kv(k,v) VALUES($1,$2::jsonb) ON CONFLICT(k) DO UPDATE SET v=$2::jsonb', [key, raw]);
    },
    async close() {
      if (closed) return;
      try { if (valid && held) await client.query('SELECT pg_advisory_unlock(764081, 2)'); }
      finally { valid = false; closed = true; held = false; release(); }
    },
  };
}
