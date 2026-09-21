/* Realm Link, end to end against the REAL server.
 *
 *   node realm-link.test.mjs
 *
 * Boots server.js on a random port with no database and no chain, then drives the whole pairing
 * flow with genuine Ed25519 sign-ins — mint a code on the website, redeem it on a device, verify
 * with the credential, and then try to sell.
 *
 * THE CHECK THIS FILE EXISTS FOR is the last one: a paired device is refused by every route that
 * moves value, and a signed-in browser is not. "The app cannot sell" has been a client-side claim
 * in this project for a long time; this is where it becomes a server-side fact.
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import net from 'node:net';

const reservation = net.createServer();
await new Promise((ok, no) => { reservation.once('error', no); reservation.listen(0, '127.0.0.1', ok); });
const port = reservation.address().port;
await new Promise((ok) => reservation.close(ok));

const treasury = nacl.sign.keyPair();
process.env.RPC_URL = 'http://127.0.0.1:59999';
process.env.TREASURY_SECRET = JSON.stringify(Array.from(treasury.secretKey));
process.env.VERIFY_HOLDERS = 'false';
process.env.NETWORK = 'devnet';
process.env.PORT = String(port);
process.env.CHIKISEUM_LIVE_ENABLED = '0';
delete process.env.DATABASE_URL;
delete process.env.RENDER;

const BASE = `http://127.0.0.1:${port}`;
let failures = 0;
const check = (ok, label) => {
	if (ok) { console.log('  ok    ' + label); } else { failures++; console.log('  FAIL  ' + label); }
};
const post = async (path, body) => {
	const r = await fetch(BASE + path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(8000),
	});
	let data = {};
	try { data = await r.json(); } catch (e) { /* some routes answer empty */ }
	return { status: r.status, data };
};
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function signIn(kp = nacl.sign.keyPair()) {
	const wallet = bs58.encode(kp.publicKey);
	const msg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
	const authSig = Buffer.from(nacl.sign.detached(Buffer.from(msg, 'utf8'), kp.secretKey)).toString('base64');
	const v = await post('/verify', { wallet, authMsg: msg, authSig });
	return { kp, wallet, msg, authSig, verify: v.data };
}

await import('./server.js');
await pause(1500);

console.log('\nthe website mints a pairing code');
const web = await signIn();
check(web.verify.signedIn === true && web.verify.mktToken, 'a real Ed25519 sign-in still works, untouched');

{
	const anon = await post('/link/new', { wallet: web.wallet });
	check(anon.status === 401 && anon.data.code === 'NOT_PROVEN', 'an unproven caller cannot mint a code for someone else');
}
const minted = await post('/link/new', { wallet: web.wallet, authMsg: web.msg, authSig: web.authSig });
check(minted.status === 200 && /^[A-Z0-9]{8}$/.test(minted.data.code || ''), `a proven wallet mints an 8-character code (${minted.data.code})`);
check(typeof minted.data.expires_at === 'string' && minted.data.expires_in === 600, 'the code carries a ten-minute expiry');
{
	const byToken = await post('/link/new', { wallet: web.wallet, mktToken: web.verify.mktToken });
	check(byToken.status === 200 && byToken.data.code, 'a market token from a signature also proves the wallet');
	check(byToken.data.code !== minted.data.code, 'and every code is distinct');
}

console.log('\nthe device redeems it');
{
	const wrong = await post('/link/redeem', { code: 'ZZZZZZZZ', device_id: 'dev-wrong' });
	check(wrong.status === 400 && wrong.data.code === 'BAD_CODE', 'a wrong code is refused');
	const noDev = await post('/link/redeem', { code: minted.data.code });
	check(noDev.status === 400 && noDev.data.code === 'NO_DEVICE', 'a redeem without a device id is refused');
}
const red = await post('/link/redeem', { code: minted.data.code, device_id: 'dev-A', device_name: 'iPhone 17', client: 'ios-app' });
check(red.status === 200 && red.data.wallet === web.wallet, 'the code resolves to the right account');
check(typeof red.data.linkToken === 'string' && red.data.linkToken.length === 64, 'and yields a 64-character device credential');
{
	const again = await post('/link/redeem', { code: minted.data.code, device_id: 'dev-B' });
	check(again.status === 400, 'the code is single use — a second redeem is refused');
}

console.log('\nthe app signs in with the credential');
const app = await post('/verify', { wallet: web.wallet, linkToken: red.data.linkToken, device_id: 'dev-A', client: 'ios-app' });
check(app.status === 200 && app.data.signedIn === true, 'a link token signs the app in');
check(typeof app.data.mktToken === 'string' && app.data.mktToken.length >= 24, 'it receives a market token');
check(typeof app.data.sessionId === 'string' && app.data.sessionId.length >= 16, 'and a live session id');
check(app.data.mktToken !== web.verify.mktToken, 'which is NOT the browser token — that is what makes the app distinguishable');
check('wallet' in app.data && 'eligible' in app.data && 'profile' in app.data && 'balance' in app.data,
	'the response envelope is unchanged, because the compiled game reads it');
{
	const wrongDevice = await post('/verify', { wallet: web.wallet, linkToken: red.data.linkToken, device_id: 'dev-OTHER' });
	check(wrongDevice.data.signedIn === false, 'the credential is bound to its device');
	const wrongWallet = await post('/verify', { wallet: bs58.encode(nacl.sign.keyPair().publicKey), linkToken: red.data.linkToken, device_id: 'dev-A' });
	check(wrongWallet.data.signedIn === false, 'and to its account');
	const junk = await post('/verify', { wallet: web.wallet, linkToken: 'f'.repeat(64), device_id: 'dev-A' });
	check(junk.data.signedIn === false, 'a made-up credential proves nothing');
}

console.log('\n*** the app cannot sell — and the website still can ***');
{
	const sell = await post('/market/op', { wallet: web.wallet, mktToken: app.data.mktToken, op: 'list', sid: 'x', listing: { id: 'l1' } });
	check(sell.status === 403 && sell.data.code === 'APP_READ_ONLY', '/market/op from the app is refused 403');
	check(/not available in the app/i.test(sell.data.error || ''), 'with copy that names no outside destination');

	for (const path of ['/market/buy-onchain', '/market/order-pay', '/nft/market/buy', '/nft/market/list',
	                    '/nft/market/delist', '/nft/market/confirm', '/meme/buy', '/claim',
	                    '/cup/register', '/cup/ready']) {
		const r = await post(path, { wallet: web.wallet, mktToken: app.data.mktToken });
		check(r.status === 403 && r.data.code === 'APP_READ_ONLY', `${path} from the app is refused`);
	}

	// The same route, the same wallet, a browser token: NOT refused by this guard. It may fail for
	// its own reasons, but it must never fail with APP_READ_ONLY.
	const webSell = await post('/market/op', { wallet: web.wallet, mktToken: web.verify.mktToken, op: 'list', sid: 'x', listing: { id: 'l1' } });
	check(webSell.data.code !== 'APP_READ_ONLY', 'the website is not caught by the app guard');
}

console.log('\nearning still works from the app — that is the whole point');
{
	// These must not be refused with APP_READ_ONLY. They can fail on their own merits (no such
	// asset, nothing to claim); what matters is WHY.
	for (const [path, body] of [
		['/profile', { wallet: web.wallet, mktToken: app.data.mktToken, profile: {} }],
		['/assets/nft/mint', { wallet: web.wallet, mktToken: app.data.mktToken, id: 'nope' }],
		['/world/node/claim', { wallet: web.wallet, mktToken: app.data.mktToken }],
		['/quest/claim', { wallet: web.wallet, mktToken: app.data.mktToken }],
	]) {
		const r = await post(path, body);
		check(r.data.code !== 'APP_READ_ONLY', `${path} is NOT blocked for the app`);
	}
}

console.log('\nthe website can see and revoke the device');
{
	const list = await post('/link/devices', { wallet: web.wallet, authMsg: web.msg, authSig: web.authSig });
	check(list.status === 200 && Array.isArray(list.data.devices), 'the devices list answers');
	const one = (list.data.devices || []).find((d) => d.device_id === 'dev-A');
	check(!!one && one.device_name === 'iPhone 17', 'the paired phone is listed by name');
	check(!!one && !JSON.stringify(one).includes(red.data.linkToken), 'and the list never contains the credential itself');

	const revoked = await post('/link/revoke', { wallet: web.wallet, device_id: 'dev-A', authMsg: web.msg, authSig: web.authSig });
	check(revoked.status === 200 && revoked.data.revoked === 1, 'the website revokes it');
	const after = await post('/verify', { wallet: web.wallet, linkToken: red.data.linkToken, device_id: 'dev-A' });
	check(after.data.signedIn === false, 'and the credential stops working immediately');
}

console.log('\nthe app can sign itself out with only its own credential');
{
	const m = await post('/link/new', { wallet: web.wallet, authMsg: web.msg, authSig: web.authSig });
	const r = await post('/link/redeem', { code: m.data.code, device_id: 'dev-C', device_name: 'iPad' });
	const out = await post('/link/revoke', { linkToken: r.data.linkToken, device_id: 'dev-C' });
	check(out.status === 200 && out.data.revoked === 1, 'revoking by token alone works');
	const bad = await post('/link/revoke', { linkToken: 'a'.repeat(64) });
	check(bad.status === 401, 'but a made-up token revokes nothing');
}

console.log('\naccount deletion: requested from the phone, cancelled by the owner');
{
	const m = await post('/link/new', { wallet: web.wallet, authMsg: web.msg, authSig: web.authSig });
	const r = await post('/link/redeem', { code: m.data.code, device_id: 'dev-D', device_name: 'iPhone' });
	const del = await post('/link/delete_account', { linkToken: r.data.linkToken, device_id: 'dev-D' });
	check(del.status === 200 && del.data.accepted === true, 'the app can request deletion (5.1.1(v))');
	check(typeof del.data.completes_at === 'string', 'and is told when it completes, rather than it happening now');

	const listed = await post('/link/devices', { wallet: web.wallet, authMsg: web.msg, authSig: web.authSig });
	check(!!listed.data.deletion, 'the pending request is visible to the wallet holder');

	const fresh = `Chikoria sign-in\nwallet:${web.wallet}\nts:${Date.now()}`;
	const freshSig = Buffer.from(nacl.sign.detached(Buffer.from(fresh, 'utf8'), web.kp.secretKey)).toString('base64');
	await post('/verify', { wallet: web.wallet, authMsg: fresh, authSig: freshSig });
	const after = await post('/link/devices', { wallet: web.wallet, authMsg: fresh, authSig: freshSig });
	check(!after.data.deletion, 'the owner signing in on the website cancels it');

	const anon = await post('/link/delete_account', { wallet: web.wallet });
	check(anon.status === 401, 'and nobody can request deletion for a wallet they cannot prove');
}

console.log('\na paired device cannot extend itself');
{
	const m = await post('/link/new', { wallet: web.wallet, authMsg: web.msg, authSig: web.authSig });
	const r = await post('/link/redeem', { code: m.data.code, device_id: 'dev-E' });
	const v = await post('/verify', { wallet: web.wallet, linkToken: r.data.linkToken, device_id: 'dev-E' });
	const tryMint = await post('/link/new', { wallet: web.wallet, mktToken: v.data.mktToken });
	check(tryMint.status === 401 && tryMint.data.code === 'NOT_PROVEN', 'the app cannot mint pairing codes for more devices');
	const tryList = await post('/link/devices', { wallet: web.wallet, mktToken: v.data.mktToken });
	check(tryList.status === 401, 'nor list the account devices');
}

console.log(failures === 0 ? `\nAll checks passed.\n` : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
