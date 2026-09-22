/* App-native accounts, end to end against the REAL server.
 *
 *   node app-account.test.mjs
 *
 * Boots server.js on a random port with no database and no chain, and drives the three flows the
 * owner asked for: create an account in the app with no wallet anywhere, play on it with the
 * 500,000 $CHIKI gate off, and bind it to a real Phantom wallet to gain the ability to sell.
 *
 * THE CHECKS THIS FILE EXISTS FOR are the two in the middle:
 *
 *   1. An app-native account's address is OFF the Ed25519 curve, so no key for it can exist. That
 *      is what makes "this account cannot sell" a fact about the address rather than a flag we
 *      promise to keep in sync — and it is what stops a payout being sent somewhere nobody can
 *      ever spend from.
 *   2. The entry gate is off for an app session while every FAUCET stays shut. The tempting fix
 *      (MIN_HOLD=0) would have opened /claim and the ten 1,000,000 $CHIKI winner slots at the same
 *      time; these assert that did not happen.
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import net from 'node:net';
import { PublicKey } from '@solana/web3.js';

const reservation = net.createServer();
await new Promise((ok, no) => { reservation.once('error', no); reservation.listen(0, '127.0.0.1', ok); });
const port = reservation.address().port;
await new Promise((ok) => reservation.close(ok));

const treasury = nacl.sign.keyPair();
process.env.RPC_URL = 'http://127.0.0.1:59999';
process.env.TREASURY_SECRET = JSON.stringify(Array.from(treasury.secretKey));
// THE GATE MUST BE ARMED, or this suite proves nothing about removing it. With VERIFY_HOLDERS
// off — which is what the other suites here run with — holdOk is true for everybody and there is
// no gate for anyone to be let through. Both values are set explicitly rather than inherited, so
// the thing under test cannot be disarmed by the environment this happens to run in.
//
// No RPC is reached despite this: chikiBalance returns 0 immediately when CHIKI_MINT is unset, so
// every wallet here reads as holding nothing — which is exactly the player this change is for.
// (The boot line's "holdMin" is MIN_HOLD_MINUTES, a different setting; the threshold is MIN_HOLD.)
process.env.VERIFY_HOLDERS = 'true';
process.env.MIN_HOLD = '500000';
delete process.env.CHIKI_MINT;
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
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
	});
	let data = {};
	try { data = await r.json(); } catch (e) { /* some routes answer empty */ }
	return { status: r.status, data };
};
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
const onCurve = (a) => { try { return PublicKey.isOnCurve(new PublicKey(a).toBytes()); } catch { return null; } };

function signer(kp = nacl.sign.keyPair()) {
	const wallet = bs58.encode(kp.publicKey);
	const msg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
	const authSig = Buffer.from(nacl.sign.detached(Buffer.from(msg, 'utf8'), kp.secretKey)).toString('base64');
	return { kp, wallet, authMsg: msg, authSig };
}

await import('./server.js');
await pause(1500);

console.log('\nthe app makes an account with no wallet anywhere in the flow');
const made = await post('/account/new', { device_id: 'phone-A', device_name: 'iPhone 17', client: 'ios-app' });
check(made.status === 200 && typeof made.data.wallet === 'string', 'POST /account/new answers with an account');
check(typeof made.data.linkToken === 'string' && made.data.linkToken.length === 64, 'and a 64-character device credential');
check(made.data.walletless === true, 'it says plainly that this account has no wallet');

const app = made.data.wallet;
console.log(`  (the account address is ${app})`);
check(onCurve(app) === false, '*** the address is OFF the Ed25519 curve — no private key for it can exist ***');
check((() => { try { new PublicKey(app); return true; } catch { return false; } })(),
	'and it is still a valid PublicKey, so every wallet-keyed thing in the server works unchanged');
{
	const real = signer();
	check(onCurve(real.wallet) === true, 'by contrast a real signing wallet is always ON the curve');
	const many = Array.from({ length: 200 }, () => onCurve(bs58.encode(nacl.sign.keyPair().publicKey)));
	check(many.every((v) => v === true), 'across 200 generated keypairs, not one is off-curve (so no false positives)');
}
{
	const dupes = new Set();
	for (let i = 0; i < 5; i++) {
		const r = await post('/account/new', { device_id: 'phone-dupe-' + i });
		if (r.data.wallet) dupes.add(r.data.wallet);
	}
	check(dupes.size === 5, 'every account gets a distinct address');
	check([...dupes].every((a) => onCurve(a) === false), 'and every one of them is off-curve');
	// Per DEVICE, not global — five more from the same phone must hit the ceiling.
	let flood = { status: 200 };
	for (let i = 0; i < 6 && flood.status === 200; i++) flood = await post('/account/new', { device_id: 'phone-A' });
	check(flood.status === 429 && flood.data.code === 'RATE_LIMIT', 'one device cannot mint accounts without limit');
	const other = await post('/account/new', { device_id: 'phone-elsewhere' });
	check(other.status === 200, 'and one noisy device does not lock everybody else out');
	const noDev = await post('/account/new', {});
	check(noDev.status === 400 && noDev.data.code === 'NO_DEVICE', 'and an account needs a device to belong to');
}

console.log('\nit can play — the 500,000 $CHIKI gate is off in the app');
const v = await post('/verify', { wallet: app, linkToken: made.data.linkToken, device_id: 'phone-A', client: 'ios-app' });
check(v.status === 200 && v.data.signedIn === true, 'the credential signs the app in');
check(v.data.eligible === true, '*** eligible with a zero balance — the entry gate is gone ***');
// THE FIELD THAT ACTUALLY OPENS THE GATE, and it is not `eligible`.
//
// The compiled pack does not trust /verify's verdict: Onboarding recomputes eligibility itself
// from the balance against its own hardcoded 500,000, and the only thing that overrides that is a
// `waived` flag it takes from /verify's `gateWaived`. Verified by decoding the shipped bytecode —
// Onboarding.gdc's identifier table contains `gateWaived` and `waived` and does NOT contain
// `eligible`. So a change that set `eligible` alone would look right in every server test here and
// still leave an App Store player staring at a locked gate. The pack cannot be rebuilt from source
// in this repo, so this assertion is the guard on that.
check(v.data.gateWaived === true, '*** gateWaived is set — the field the compiled pack actually reads ***');
check(v.data.walletless === true && v.data.canSell === false, 'and the response says what kind of account it is');
check(v.data.app === true, 'and that this is an app session');
check(typeof v.data.mktToken === 'string' && v.data.mktToken.length >= 24, 'it gets a market token');
check('wallet' in v.data && 'profile' in v.data && 'balance' in v.data && 'chikis' in v.data,
	'the response envelope is unchanged, because the compiled game reads it');
{
	// THE GATE BEING OFF MUST NOT MEAN THE HOLD VERDICT WAS FAKED. /claim, /chat/send and the ten
	// quest winner slots re-read holdOk for themselves, so waiving it globally (MIN_HOLD=0) would
	// have opened all of them. This harness runs with VERIFY_HOLDERS=false, where holdOk is `true`
	// for everyone by design, so what is asserted here is that the app path did not INVENT a
	// different answer — `eligible` moved, `holdOk` did not.
	const web = signer();
	const plain = await post('/verify', { wallet: web.wallet, authMsg: web.authMsg, authSig: web.authSig });
	check(plain.status === 200 && plain.data.signedIn === true, 'a real Ed25519 sign-in still works, untouched');
	check(plain.data.app === undefined, 'and is not marked as an app session');
	check(v.data.holdOk === plain.data.holdOk, 'the app path reports the SAME hold verdict a browser does — only entry was waived');

	// *** THE CONTROL, and the reason this suite arms the gate at all. ***
	// The same wallet, holding the same nothing, on the WEBSITE: still gated. The owner's standing
	// instruction is that the desktop version does not change, so "remove the 500k gate" is scoped
	// to app sessions and this is what holds that line. If someone later reaches for MIN_HOLD=0,
	// this check is what fails.
	check(plain.data.eligible === false, '*** a browser holding nothing is STILL refused — the website is unchanged ***');
	check(plain.data.gateWaived === undefined, 'and gets no waiver');
	check(typeof plain.data.gateNote === 'string' && /500,000/.test(plain.data.gateNote),
		'and is still told to hold 500,000 $CHIKI');
	check(v.data.gateNote === undefined, 'while the app player is NOT told that, having been let in');
}

console.log('\na player who pairs a real wallet is not gated in the app either');
{
	// The owner offered two ways in: make an account, or connect the Phantom wallet you have. A
	// paired player holding under 500,000 must not hit the gate the app player just walked past.
	const holder = signer();
	const code = await post('/link/new', { wallet: holder.wallet, authMsg: holder.authMsg, authSig: holder.authSig });
	const red = await post('/link/redeem', { code: code.data.code, device_id: 'phone-paired', client: 'ios-app' });
	check(red.status === 200, 'the wallet pairs a phone');
	const inApp = await post('/verify', { wallet: holder.wallet, linkToken: red.data.linkToken, device_id: 'phone-paired' });
	check(inApp.data.eligible === true && inApp.data.gateWaived === true,
		'*** and plays with 0 $CHIKI, because it is an app session ***');
	check(inApp.data.walletless === undefined, 'this account is NOT walletless — a real wallet is behind it');

	const onWeb = await post('/verify', { wallet: holder.wallet, authMsg: holder.authMsg, authSig: holder.authSig });
	check(onWeb.data.eligible === false, 'the very same wallet is still gated on the website');
}

console.log('\nand it can SAVE — an account that cannot save is not an account');
{
	const save = await post('/profile', {
		wallet: app, linkToken: made.data.linkToken, device_id: 'phone-A',
		profile: { mmo: { trainer: 'Ash', t: 1 } },
	});
	check(save.status === 200, '*** the cloud save accepts a device credential, because no signature can ever exist ***');
	const load = await fetch(`${BASE}/profile?wallet=${app}&linkToken=${made.data.linkToken}&device_id=phone-A`).then((r) => r.json());
	check(!!(load.profile && load.profile.mmo && load.profile.mmo.trainer === 'Ash'), 'and reads it back');
	const peek = await fetch(`${BASE}/profile?wallet=${app}`).then((r) => r.json());
	check(!(peek.profile && peek.profile.mmo), 'while a stranger who knows the address still gets no save');
	const forged = await post('/profile', {
		wallet: app, linkToken: 'f'.repeat(64), device_id: 'phone-A',
		profile: { mmo: { trainer: 'Thief' } },
	});
	check(forged.status === 401, 'and a made-up credential cannot overwrite it');
}

console.log('\n*** it cannot be sent anything on-chain — the money-destroying paths refuse ***');
{
	const claim = await post('/claim', { wallet: app, mktToken: v.data.mktToken });
	check(claim.status === 403, '/claim refuses');
	check(claim.data.code === 'NO_WALLET' || claim.data.code === 'APP_READ_ONLY', `  with a refusal, not a transfer (${claim.data.code})`);

	for (const path of ['/assets/nft/mint', '/assets/nft/prepare', '/nft/market/buy', '/nft/market/list',
	                    '/nft/market/delist', '/nft/market/confirm', '/meme/buy', '/quest/rewards/payout',
	                    '/market/buy-onchain', '/market/order-pay',
	                    '/chikiseum/live/v1/wager_post', '/chikiseum/live/v1/wager_accept', '/chikiseum/live/v1/wager_deposit']) {
		const r = await post(path, { wallet: app, mktToken: v.data.mktToken, id: 'x' });
		check(r.status === 403, `${path} refuses an account with no wallet`);
	}
	// The refusal must name the remedy. A dead end fails the player and fails App Review.
	const m = await post('/assets/nft/mint', { wallet: app, mktToken: v.data.mktToken, id: 'x' });
	check(/phantom|wallet/i.test(m.data.error || ''), 'and the copy says how to fix it rather than just "no"');
	check(!/app ?store|buy|purchase/i.test(m.data.error || ''), 'without steering anyone to an outside purchase');
}

console.log('\nselling still refuses, exactly as it did for a paired phone');
{
	const sell = await post('/market/op', { wallet: app, mktToken: v.data.mktToken, op: 'list', sid: 'x', listing: { id: 'l1' } });
	check(sell.status === 403, '/market/op from an app account is refused');
	const cup = await post('/cup/register', { wallet: app, mktToken: v.data.mktToken });
	check(cup.status === 403, 'and so is the Cup, which pays a real SOL prize');
}

console.log('\nearning still works — that is the whole point of the account');
{
	for (const [path, body] of [
		['/profile', { wallet: app, linkToken: made.data.linkToken, device_id: 'phone-A', profile: { mmo: { t: 1 } } }],
		['/world/node/claim', { wallet: app, mktToken: v.data.mktToken }],
		['/quest/complete', { wallet: app, mktToken: v.data.mktToken, questId: 's_meet' }],
	]) {
		const r = await post(path, body);
		check(r.data.code !== 'NO_WALLET' && r.data.code !== 'APP_READ_ONLY', `${path} is NOT blocked for an app account`);
	}
	// /quest/complete accrues real $CHIKI to the pouch unconditionally. For an account with no
	// wallet that reward cannot be SENT — but it must not be thrown away either, because binding
	// is exactly the thing that makes it sendable.
	const q = await post('/quest/rewards', { wallet: app, mktToken: v.data.mktToken });
	check(q.status !== 500, '/quest/rewards answers for an app account');
	const payout = await post('/quest/rewards/payout', { wallet: app, mktToken: v.data.mktToken, key: 'nope' });
	check(payout.status === 403, 'the payout route refuses (there is nowhere to send it)');
	const after = await post('/quest/rewards', { wallet: app, mktToken: v.data.mktToken });
	check(JSON.stringify(after.data) === JSON.stringify(q.data), '*** and the refusal did not quietly wipe what was earned ***');
}

console.log('\nbinding a Phantom wallet is what unlocks selling');
const owner = signer();
{
	const anon = await post('/account/claim', { linkToken: 'f'.repeat(64), device_id: 'phone-A' });
	check(anon.status === 401, 'a made-up device credential mints no claim code');

	const c = await post('/account/claim', { linkToken: made.data.linkToken, device_id: 'phone-A' });
	check(c.status === 200 && /^[A-Z0-9]{8}$/.test(c.data.code || ''), `the app mints an 8-character claim code (${c.data.code})`);

	const unsigned = await post('/link/bind', { wallet: owner.wallet, code: c.data.code });
	check(unsigned.status === 401 && unsigned.data.code === 'NOT_PROVEN', 'binding without a signature is refused');

	const wrongCode = await post('/link/bind', { wallet: owner.wallet, authMsg: owner.authMsg, authSig: owner.authSig, code: 'ZZZZZZZZ' });
	check(wrongCode.status === 400, 'a wrong code binds nothing');

	const bound = await post('/link/bind', { wallet: owner.wallet, authMsg: owner.authMsg, authSig: owner.authSig, code: c.data.code });
	check(bound.status === 200 && bound.data.ok === true, '*** a signed wallet claims the account ***');
	check(bound.data.from === app && bound.data.to === owner.wallet, 'from the app address to the real wallet');
	check(bound.data.moved && bound.data.moved.profile === true, 'and the cloud save came with it');
	check(bound.data.moved.questPouch === true, '*** and the quest $CHIKI earned before there was a wallet to receive it ***');
	check(bound.data.devices >= 1, 'the paired phone moved too, so nobody has to re-pair');

	const again = await post('/link/bind', { wallet: owner.wallet, authMsg: owner.authMsg, authSig: owner.authSig, code: c.data.code });
	check(again.status === 400, 'the claim code is single use');
}

console.log('\nafter the bind, the phone keeps playing — on the real account');
{
	const after = await post('/verify', { wallet: owner.wallet, linkToken: made.data.linkToken, device_id: 'phone-A' });
	check(after.data.signedIn === true, 'the same device credential still signs in');
	check(after.data.walletless === undefined, 'and the account is no longer walletless');

	// The phone that was asleep during the bind still asks for the OLD address. It must get a
	// COMPLETE, signed-in envelope at the new one — the compiled pack reads that envelope and has
	// no idea what a "rebind" is, so anything less would show a signed-out screen.
	const stale = await post('/verify', { wallet: app, linkToken: made.data.linkToken, device_id: 'phone-A' });
	check(stale.data.wallet === owner.wallet, 'a device that missed the bind is answered at the new address');
	check(stale.data.signedIn === true, '*** and is SIGNED IN, not bounced to a sign-in screen ***');
	check(!!stale.data.mktToken && !!stale.data.sessionId, 'with a working token and session, like any other verify');
	check(stale.data.movedFrom === app && stale.data.rebind === true, 'plus a hint saying where it moved from');
	check('eligible' in stale.data && 'profile' in stale.data && 'chikis' in stale.data && 'balance' in stale.data,
		'and the envelope is the standard one the compiled pack knows how to read');

	const prof = await post('/profile', { wallet: owner.wallet, mktToken: '', get: true });
	check(prof.status !== 500, 'the profile route survives the move');
}

console.log('\nthe bound wallet CAN sell — the whole reason to bind');
{
	const fresh = `Chikoria sign-in\nwallet:${owner.wallet}\nts:${Date.now()}`;
	const freshSig = Buffer.from(nacl.sign.detached(Buffer.from(fresh, 'utf8'), owner.kp.secretKey)).toString('base64');
	const web = await post('/verify', { wallet: owner.wallet, authMsg: fresh, authSig: freshSig });
	check(web.data.signedIn === true && !!web.data.mktToken, 'signing in on the website with Phantom works');
	const sell = await post('/market/op', { wallet: owner.wallet, mktToken: web.data.mktToken, op: 'list', sid: 'x', listing: { id: 'l1' } });
	check(sell.data.code !== 'APP_READ_ONLY' && sell.data.code !== 'NO_WALLET',
		'*** and selling is no longer refused for being an app account ***');
	const mint = await post('/assets/nft/mint', { wallet: owner.wallet, mktToken: web.data.mktToken, id: 'x' });
	check(mint.data.code !== 'NO_WALLET', 'minting is no longer refused for having no wallet');
}

console.log('\nbinding refuses rather than merging two save files');
{
	const a2 = await post('/account/new', { device_id: 'phone-B' });
	await post('/verify', { wallet: a2.data.wallet, linkToken: a2.data.linkToken, device_id: 'phone-B' });
	await post('/profile', { wallet: a2.data.wallet, linkToken: a2.data.linkToken, device_id: 'phone-B', profile: { mmo: { trainer: 'Misty' } } });
	const c2 = await post('/account/claim', { linkToken: a2.data.linkToken, device_id: 'phone-B' });
	// owner.wallet now carries the first account's save.
	const clash = await post('/link/bind', { wallet: owner.wallet, authMsg: owner.authMsg, authSig: owner.authSig, code: c2.data.code });
	check(clash.status === 409 && clash.data.code === 'WALLET_IN_USE',
		'a wallet that already has progress refuses a second account rather than losing one of them');
	check(/merge|lose|support/i.test(clash.data.error || ''), 'and says why, with somewhere to go');

	const still = await post('/verify', { wallet: a2.data.wallet, linkToken: a2.data.linkToken, device_id: 'phone-B' });
	check(still.data.signedIn === true, 'the refused account is untouched and still playable');

	// The refusal hands the code back: the player picks a different wallet and it just works.
	const w2 = signer();
	const retry = await post('/link/bind', { wallet: w2.wallet, authMsg: w2.authMsg, authSig: w2.authSig, code: c2.data.code });
	check(retry.status === 200 && retry.data.to === w2.wallet, 'and the refusal did not burn the code — another wallet can still claim it');
}

console.log('\ntwo binds racing on one claim code move the account exactly once');
{
	const a8 = await post('/account/new', { device_id: 'phone-H' });
	await post('/profile', { wallet: a8.data.wallet, linkToken: a8.data.linkToken, device_id: 'phone-H', profile: { mmo: { trainer: 'Gary' } } });
	const c8 = await post('/account/claim', { linkToken: a8.data.linkToken, device_id: 'phone-H' });
	const w8 = signer();
	const body = { wallet: w8.wallet, authMsg: w8.authMsg, authSig: w8.authSig, code: c8.data.code };
	const [r1, r2] = await Promise.all([post('/link/bind', body), post('/link/bind', body)]);
	const wins = [r1, r2].filter((r) => r.status === 200);
	const loses = [r1, r2].filter((r) => r.status !== 200);
	check(wins.length === 1, 'exactly one of them succeeds');
	check(loses.length === 1 && loses[0].data.code !== 'MOVE_SPLIT', `the other is refused cleanly, not half-moved (${loses[0] && loses[0].data.code})`);
	const moved = await fetch(`${BASE}/profile?wallet=${w8.wallet}&linkToken=${a8.data.linkToken}&device_id=phone-H`).then((r) => r.json());
	check(!!(moved.profile && moved.profile.mmo && moved.profile.mmo.trainer === 'Gary'), 'and the save is at the wallet, intact');
}

console.log('\na device credential is only good from the device it was issued to');
{
	const a7 = await post('/account/new', { device_id: 'phone-G' });
	const noDev = await post('/verify', { wallet: a7.data.wallet, linkToken: a7.data.linkToken });
	check(noDev.data.signedIn !== true, '*** a leaked credential with the device id left out does not sign in ***');
	const wrongDev = await post('/verify', { wallet: a7.data.wallet, linkToken: a7.data.linkToken, device_id: 'phone-X' });
	check(wrongDev.data.signedIn !== true, 'nor with a different device id');
	const saveNoDev = await post('/profile', { wallet: a7.data.wallet, linkToken: a7.data.linkToken, profile: { mmo: { trainer: 'Thief' } } });
	check(saveNoDev.status === 401, 'and the cloud save cannot be written without it');
	const right = await post('/verify', { wallet: a7.data.wallet, linkToken: a7.data.linkToken, device_id: 'phone-G' });
	check(right.data.signedIn === true, 'while the issuing device signs in as before');
}

console.log('\nthe deny lists hold on every spelling the router also accepts');
{
	// Express routes /market/op/ and /MARKET/OP to the same handler. The guards used to match the
	// raw path, so a trailing slash walked straight past both of them.
	const a9 = await post('/account/new', { device_id: 'phone-I' });
	const v9 = await post('/verify', { wallet: a9.data.wallet, linkToken: a9.data.linkToken, device_id: 'phone-I' });
	for (const path of ['/market/op/', '/Market/Op', '/market/op//']) {
		const r = await post(path, { wallet: a9.data.wallet, mktToken: v9.data.mktToken, op: 'list', sid: 'x', listing: { id: 'l1' } });
		check(r.status === 403, `${path} is refused for an app token`);
	}
	for (const path of ['/cup/register/', '/CUP/register', '/claim/']) {
		const r = await post(path, { wallet: a9.data.wallet, mktToken: v9.data.mktToken });
		check(r.status === 403, `${path} is refused for a walletless account`);
	}
}

console.log('\nan app account cannot borrow the wallet-holder powers');
{
	const mint = await post('/link/new', { wallet: app, mktToken: v.data.mktToken });
	check(mint.status === 401, 'it cannot mint pairing codes for more devices');
	const list = await post('/link/devices', { wallet: app, mktToken: v.data.mktToken });
	check(list.status === 401, 'nor list devices');
	const a3 = await post('/account/new', { device_id: 'phone-C' });
	const steal = await post('/link/redeem', { code: (await post('/account/claim', { linkToken: a3.data.linkToken, device_id: 'phone-C' })).data.code, device_id: 'thief' });
	check(steal.status === 400, '*** a claim code cannot be redeemed as a pairing code — no account takeover by typing 8 characters ***');
}

console.log('\npairing over an app account would orphan it, so it is refused');
{
	// The trap: a player makes an app account, plays for a week, then connects the wallet they had
	// all along the way they already know how — a code from the website. That used to switch this
	// device to the wallet's empty account and strand the week at an address with no credential
	// pointing at it, silently.
	const a5 = await post('/account/new', { device_id: 'phone-E' });
	await post('/profile', { wallet: a5.data.wallet, linkToken: a5.data.linkToken, device_id: 'phone-E', profile: { mmo: { trainer: 'Brock' } } });
	const w = signer();
	const code = await post('/link/new', { wallet: w.wallet, authMsg: w.authMsg, authSig: w.authSig });
	const paired = await post('/link/redeem', { code: code.data.code, device_id: 'phone-E' });
	check(paired.status === 409 && paired.data.code === 'WOULD_ORPHAN', '*** refused, rather than silently stranding a week of play ***');
	check(/connect your wallet|settings/i.test(paired.data.error || ''), 'and it names the flow they actually wanted');

	const intact = await fetch(`${BASE}/profile?wallet=${a5.data.wallet}&linkToken=${a5.data.linkToken}&device_id=phone-E`).then((r) => r.json());
	check(intact.profile && intact.profile.mmo && intact.profile.mmo.trainer === 'Brock', 'the app account is untouched');

	// ...and the code they minted is NOT burned by the refusal — a fresh device can still use it.
	const elsewhere = await post('/link/redeem', { code: code.data.code, device_id: 'phone-F' });
	check(elsewhere.status === 200 && elsewhere.data.wallet === w.wallet, 'and their pairing code still works on a device that has no account');
}

console.log('\ndeletion works, and for an app account the phone can withdraw it');
{
	const a4 = await post('/account/new', { device_id: 'phone-D' });
	const del = await post('/link/delete_account', { linkToken: a4.data.linkToken, device_id: 'phone-D' });
	check(del.status === 200 && del.data.accepted === true, 'the app can request deletion (5.1.1(v))');
	check(del.data.grace_days === 1, 'with a short grace, because no wallet holder can be waiting to object');
	const back = await post('/verify', { wallet: a4.data.wallet, linkToken: a4.data.linkToken, device_id: 'phone-D' });
	check(back.data.signedIn === true, 'the player comes back on the same device');
	const gone = await post('/link/delete_account', { linkToken: a4.data.linkToken, device_id: 'phone-D' });
	check(gone.data.already !== true, 'and that withdrew the request — the only owner an app account has');
}

console.log(failures === 0 ? `\nAll checks passed.\n` : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
