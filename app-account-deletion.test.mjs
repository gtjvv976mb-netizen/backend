/* Account deletion is CARRIED OUT, not just recorded (App Store 5.1.1(v)).
 *
 *   node app-account-deletion.test.mjs
 *
 * Boots server.js on a random port with no database and no chain, with the app-account grace period
 * and the deletion sweep shortened to fractions of a second, then: makes an app account, saves a
 * game on it, asks for deletion from the "phone", waits, and checks the account is really gone —
 * save erased, device credential dead — while an account that did NOT ask is untouched.
 */
import nacl from 'tweetnacl';
import net from 'node:net';

const reservation = net.createServer();
await new Promise((ok, no) => { reservation.once('error', no); reservation.listen(0, '127.0.0.1', ok); });
const port = reservation.address().port;
await new Promise((ok) => reservation.close(ok));

const treasury = nacl.sign.keyPair();
process.env.RPC_URL = 'http://127.0.0.1:59999';
process.env.TREASURY_SECRET = JSON.stringify(Array.from(treasury.secretKey));
process.env.NETWORK = 'devnet';
process.env.PORT = String(port);
process.env.CHIKISEUM_LIVE_ENABLED = '0';
process.env.DELETE_GRACE_APP_MS = '400';
process.env.DELETION_SWEEP_MS = '250';
delete process.env.CHIKI_MINT;
delete process.env.DATABASE_URL;
delete process.env.RENDER;

const BASE = `http://127.0.0.1:${port}`;
let failures = 0;
const check = (ok, label) => {
	if (ok) { console.log('  ok    ' + label); } else { failures++; console.log('  FAIL  ' + label); }
};
const post = async (path, body) => {
	const r = await fetch(BASE + path, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
	});
	let data = {};
	try { data = await r.json(); } catch (e) { /* some routes answer empty */ }
	return { status: r.status, data };
};
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
const load = (a, dev) => fetch(`${BASE}/profile?wallet=${a.wallet}&linkToken=${a.linkToken}&device_id=${dev}`).then((r) => r.json());

await import('./server.js');
await pause(1500);

console.log('\nan app account asks to be deleted, and is');
const gone = (await post('/account/new', { device_id: 'phone-X', client: 'ios-app' })).data;
const kept = (await post('/account/new', { device_id: 'phone-Y', client: 'ios-app' })).data;
await post('/profile', { wallet: gone.wallet, linkToken: gone.linkToken, device_id: 'phone-X', profile: { mmo: { trainer: 'Ash' } } });
await post('/profile', { wallet: kept.wallet, linkToken: kept.linkToken, device_id: 'phone-Y', profile: { mmo: { trainer: 'Misty' } } });
check((await load(gone, 'phone-X')).profile?.mmo?.trainer === 'Ash', 'the account has a save before deletion');

const req = await post('/link/delete_account', { linkToken: gone.linkToken, device_id: 'phone-X' });
check(req.status === 200 && req.data.accepted === true, 'the app asks for deletion');

// grace 400 ms + sweep every 250 ms: well under three seconds end to end
let erased = false;
for (let i = 0; i < 20 && !erased; i++) {
	await pause(300);
	// NOT /verify: signing back in is how a player withdraws the request, so polling with it would
	// cancel the very deletion under test. Reading the save does not.
	erased = !(await load(gone, 'phone-X')).profile;
}
check(erased, 'after the grace period the save is gone');
const v = await post('/verify', { wallet: gone.wallet, linkToken: gone.linkToken, device_id: 'phone-X' });
check(v.data.signedIn !== true, 'and no longer signs in');
const after = await post('/profile', { wallet: gone.wallet, linkToken: gone.linkToken, device_id: 'phone-X', profile: { mmo: { trainer: 'Ash again' } } });
check(after.status === 401 || after.status === 403, 'and can no longer write a save');
const peek = await fetch(`${BASE}/profile?wallet=${gone.wallet}`).then((r) => r.json()).catch(() => ({}));
check(!peek.profile, 'the save itself is erased');
const again = await post('/link/delete_account', { linkToken: gone.linkToken, device_id: 'phone-X' });
check(again.status === 401, 'there is nothing left to ask about');

console.log('\nan account that did not ask is untouched');
check((await load(kept, 'phone-Y')).profile?.mmo?.trainer === 'Misty', 'its save is still there');
const still = await post('/verify', { wallet: kept.wallet, linkToken: kept.linkToken, device_id: 'phone-Y' });
check(still.data.signedIn === true, 'and it still signs in');

console.log(failures === 0 ? `\nAll checks passed.\n` : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
