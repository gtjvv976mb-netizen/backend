/* The app's load diagnostics: accepted, replaced per session, bounded, and readable only with the key.
 *
 *   DIAG_KEY=… node client-diag.test.mjs      (the key whose SHA-256 is DIAG_READ_SHA256 in server.js)
 *
 * Without DIAG_KEY the read-side checks that need the real key are skipped; the refusals still run.
 */
import nacl from 'tweetnacl';
import net from 'node:net';

const reservation = net.createServer();
await new Promise((ok, no) => { reservation.once('error', no); reservation.listen(0, '127.0.0.1', ok); });
const port = reservation.address().port;
await new Promise((ok) => reservation.close(ok));

process.env.RPC_URL = 'http://127.0.0.1:59999';
process.env.TREASURY_SECRET = JSON.stringify(Array.from(nacl.sign.keyPair().secretKey));
process.env.NETWORK = 'devnet';
process.env.PORT = String(port);
process.env.CHIKISEUM_LIVE_ENABLED = '0';
delete process.env.CHIKI_MINT;
delete process.env.DATABASE_URL;
delete process.env.RENDER;

const BASE = `http://127.0.0.1:${port}`;
let failures = 0;
const check = (ok, label) => { if (ok) console.log('  ok    ' + label); else { failures++; console.log('  FAIL  ' + label); } };
const post = (body) => fetch(BASE + '/client-diag', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

await import('./server.js');
await new Promise((ok) => setTimeout(ok, 1500));

check((await post({ session: 's1', stage: 'a' })).status === 200, 'a report is accepted');
check((await post({ session: 's1', stage: 'b' })).status === 200, 'a later snapshot of the same launch is accepted');
check((await post({ session: 's2', stage: 'c' })).status === 200, 'another launch is accepted');
check((await post({ stage: 'x' })).status === 400, 'a report with no session is refused');
check((await post({ session: 's3', blob: 'x'.repeat(40000) })).status === 413, 'an oversized report is refused');
check((await fetch(BASE + '/client-diag')).status === 404, 'reading without the key is refused');
check((await fetch(BASE + '/client-diag?key=wrong')).status === 404, 'reading with a wrong key is refused');

if (process.env.DIAG_KEY) {
	const got = await fetch(BASE + '/client-diag?key=' + encodeURIComponent(process.env.DIAG_KEY)).then((r) => r.json());
	const list = got.reports || [];
	check(list.length === 2, 'two launches are held, not three snapshots');
	check(list[0].session === 's2' && list[1].report.stage === 'b', 'newest first, and a launch keeps only its latest snapshot');
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
