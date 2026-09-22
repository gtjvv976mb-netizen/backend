/* Realm Link — a Chikoria account on an iOS device, with no wallet on the device.
 *
 * The app has no Phantom and never will: it ships through the App Store, where a wallet-connect
 * button is a guideline 3.1.1 problem and a transaction is a 3.1.5(b) one. So identity moves off
 * the device. There are two ways in, and a one-way door between them.
 *
 *   PAIR  — the player already has a wallet. They sign in on chikimonsters.com/link/, mint a
 *           short code, type it into the app once, and the app holds a DEVICE CREDENTIAL from
 *           then on. The account is a real wallet; the phone is a remote control for it.
 *
 *   CREATE — the player has no wallet and does not want one. The app makes an account on the
 *           spot, with no website, no code and no crypto anywhere in the flow. See below for
 *           what that account's address actually is.
 *
 *   BIND  — a CREATEd account later moves onto a real wallet: the app mints a claim code, the
 *           player types it on the website while signed in with Phantom, and the account
 *           migrates. This is the ONLY way an app-native account gains the ability to sell,
 *           and it is one-way.
 *
 * THE ONE PROPERTY THIS FILE EXISTS TO GUARANTEE:
 *
 *     A link token authorises PLAYING an account. It must never authorise MOVING VALUE.
 *
 * That is not a client-side promise. `realm/chiki-ios.js` refuses the selling routes, and the app
 * carries no code that can sign a transaction — but a client is a client, and someone who is not
 * using our client can send whatever they like. The market token minted for a link session is
 * therefore drawn from a SEPARATE pool (`appTokens`), which makes "this request came from a
 * paired device" a decidable fact on the server. server.js refuses the value-moving routes on
 * exactly that fact.
 *
 * Why a separate pool rather than a flag on the wallet: `marketTokens` is keyed by wallet and
 * reused, so a player signed in on the web and paired on a phone would share one token and the
 * provenance would be unanswerable. Keying by TOKEN keeps the two sessions distinguishable even
 * for the same wallet at the same moment.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT AN APP-NATIVE ACCOUNT'S ADDRESS IS, AND WHY IT IS SHAPED THAT WAY
 *
 * Every table, map, socket, cloud save and compiled-GDScript call site in this game is keyed by a
 * base58 Solana address, and /verify refuses anything `new PublicKey()` will not parse. The
 * compiled Godot pack cannot be rebuilt from source — it is patched by swapping individual .gdc
 * bytecode files — so "give app accounts a different kind of id" is not an option that exists.
 *
 * So an app-native account IS given an address: 32 random bytes that land OFF the Ed25519 curve.
 *
 *   - It parses as a PublicKey, so every one of those call sites works unchanged.
 *   - No private key for it can exist. Not lost, not escrowed, not "discarded by the server" —
 *     mathematically absent, the same reason a PDA cannot sign.
 *   - Therefore the server can tell an app-native account from a real wallet FROM THE ADDRESS
 *     ALONE. No database lookup, no flag to get out of sync, nothing a stale token or a lost row
 *     can defeat. Every wallet a player can actually sign with is on-curve, so there are no false
 *     positives in the direction that matters.
 *
 * That last property is what the value-moving guard in server.js rests on. A flag would have
 * been a promise; this is a proof.
 *
 * THE PRICE, STATED PLAINLY: an app-native account cannot receive anything on-chain, because
 * nobody — including us — can ever spend from it. Sending it SOL or minting it an NFT would
 * destroy the asset. server.js must refuse those routes for these addresses, and BIND exists so
 * a player who wants them has a way to get them.
 */

import crypto from "node:crypto";

// Ambiguous glyphs removed: a player reads this off one screen and types it into another, and
// O/0 and I/1/L are where that goes wrong. 8 chars from 32 symbols ~ 40 bits.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LEN = 8;
const CODE_TTL_MS = 10 * 60 * 1000;          // long enough to walk to the other device
const CODE_MAX_PER_WALLET = 5;               // outstanding, not lifetime
const CODE_RATE_WINDOW_MS = 60 * 1000;
const CODE_RATE_MAX = 6;                     // per wallet per minute
const REDEEM_RATE_WINDOW_MS = 60 * 1000;
const REDEEM_RATE_MAX = 10;                  // per device_id per minute, against code guessing
// The per-device limit is keyed on a string the caller chooses, so on its own it limits nothing
// against a guesser who rotates device_ids. The global cap is the one that actually bounds the
// guess rate: 300/min against a 40-bit code space is ~7,000 years to a 50% hit on one live code.
const REDEEM_GLOBAL_MAX = 300;               // per minute across all devices
// Claim codes are guessed from the WEBSITE side by a signed-in wallet. A wallet is free to make,
// so this needs the same pair: a per-wallet limit for the honest case, a global one for the attack.
const CLAIM_RATE_WINDOW_MS = 60 * 1000;
const CLAIM_RATE_MAX = 10;                   // per wallet per minute
const CLAIM_GLOBAL_MAX = 300;                // per minute across all wallets
const DEVICES_MAX_PER_WALLET = 10;
const DELETE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
// An app-native account has no owner who can turn up and object, so its grace period exists only
// to survive a mis-tap, not to outlast a thief.
const DELETE_GRACE_APP_MS = 24 * 60 * 60 * 1000;
// Account creation is free and unauthenticated, which makes it the one route here an attacker can
// use to fill a database. A real device makes one account, or a handful across reinstalls.
const CREATE_RATE_WINDOW_MS = 60 * 60 * 1000;
const CREATE_RATE_MAX = 5;                   // per device_id per hour
const CREATE_GLOBAL_WINDOW_MS = 60 * 1000;
const CREATE_GLOBAL_MAX = 120;               // per minute across all devices, a blunt backstop
const CLAIM_TTL_MS = 10 * 60 * 1000;

const KV_TOKENS = "link_tokens";
const KV_DELETIONS = "link_deletions";
const KV_BOUND = "link_bound";

function randomCode() {
	let out = "";
	const bytes = crypto.randomBytes(CODE_LEN * 2);
	for (let i = 0; out.length < CODE_LEN && i < bytes.length; i++) {
		// Rejection sampling: 256 % 31 !== 0, so a bare modulo would bias the first few symbols.
		if (bytes[i] < 248) out += ALPHABET[bytes[i] % ALPHABET.length];
	}
	return out.length === CODE_LEN ? out : randomCode();
}

/** Constant-time compare for secrets that arrive from the network. */
function sameSecret(a, b) {
	const x = Buffer.from(String(a || ""), "utf8");
	const y = Buffer.from(String(b || ""), "utf8");
	if (x.length !== y.length || x.length === 0) return false;
	return crypto.timingSafeEqual(x, y);
}

const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);

export function createRealmLink({ store, isPubkey, newAddress, isWalletless, log = console }) {
	if (!store || typeof store.kvGet !== "function") throw new Error("realm-link needs a store");
	if (typeof isPubkey !== "function") throw new Error("realm-link needs isPubkey");
	// Injected rather than imported so this module keeps no opinion about which Solana library is
	// in use — the same reason isPubkey is injected. server.js owns both.
	if (typeof newAddress !== "function") throw new Error("realm-link needs newAddress");
	if (typeof isWalletless !== "function") throw new Error("realm-link needs isWalletless");

	// code -> { wallet, exp, used }   In memory only, and deliberately so: a code lives ten
	// minutes, and a redeploy that forgets one costs the player a re-tap of "Get a code". A token
	// forgotten would sign a player out of their phone, which is why THOSE are persisted.
	const codes = new Map();
	// claimCode -> { wallet, linkToken, exp, used }   DELIBERATELY A SEPARATE MAP from `codes`.
	// The two kinds of code travel in opposite directions and mean opposite things: a pairing code
	// says "this wallet invites a device", a claim code says "this device offers its account". If
	// they shared a map, /link/redeem would happily redeem a claim code and hand any passer-by a
	// device credential for somebody's app account — a takeover by typing eight characters.
	const claims = new Map();
	// token -> { wallet, device_id, device_name, client, linked_at, last_seen, walletless? }
	let tokens = Object.create(null);
	// appMarketToken -> { wallet, linkToken }   The separate pool described at the top of the file.
	const appTokens = new Map();
	// wallet -> { requested_at, completes_at, device_id }
	let deletions = Object.create(null);
	// retired app-native address -> { to, at }   Kept forever, small, and load-bearing: it is how a
	// device that was offline during a bind learns where its account went instead of being told its
	// credential is simply invalid.
	let bound = Object.create(null);

	const rate = new Map();                       // key -> [timestamps]
	function rateOk(key, windowMs, max) {
		const now = Date.now();
		const hits = (rate.get(key) || []).filter((t) => now - t < windowMs);
		if (hits.length >= max) { rate.set(key, hits); return false; }
		hits.push(now);
		rate.set(key, hits);
		if (rate.size > 20000) { for (const k of rate.keys()) { rate.delete(k); if (rate.size <= 10000) break; } }
		return true;
	}

	// ---- persistence, with the same restore gate the market sessions use --------------------
	//
	// The port is open before the restore finishes, so a /link/redeem can land while this read is
	// still in flight. Writing before it completes would persist a near-empty map over every
	// player's paired device. The market-session code learned this the hard way; the comment at
	// `saveMarketSessions` in server.js is the incident.
	let ready = false;
	const restored = Promise.all([
		store.kvGet(KV_TOKENS).then((v) => { if (v && typeof v === "object") tokens = Object.assign(Object.create(null), v, tokens); }).catch(() => {}),
		store.kvGet(KV_DELETIONS).then((v) => { if (v && typeof v === "object") deletions = Object.assign(Object.create(null), v, deletions); }).catch(() => {}),
		store.kvGet(KV_BOUND).then((v) => { if (v && typeof v === "object") bound = Object.assign(Object.create(null), v, bound); }).catch(() => {}),
	]).then(() => { ready = true; });

	async function save() {
		// Every leg of `restored` catches its own failure and the chain then sets `ready`, so once
		// this await returns the gate is open. A failed read leaves the in-memory map as it was.
		if (!ready) await restored;
		try {
			await Promise.all([store.kvSet(KV_TOKENS, tokens), store.kvSet(KV_DELETIONS, deletions), store.kvSet(KV_BOUND, bound)]);
		} catch (e) { log.warn("realm-link persist failed:", String(e?.message || e)); }
	}

	function sweepCodes() {
		const now = Date.now();
		for (const [c, r] of codes) if (r.exp <= now || r.used) codes.delete(c);
		for (const [c, r] of claims) if (r.exp <= now || r.used) claims.delete(c);
	}

	// ---- codes -------------------------------------------------------------------------------

	function newCode(wallet) {
		if (!isPubkey(wallet)) return { error: "valid 'wallet' required", status: 400 };
		if (!rateOk("new:" + wallet, CODE_RATE_WINDOW_MS, CODE_RATE_MAX))
			return { error: "too many codes — wait a minute and try again", status: 429, code: "RATE_LIMIT" };
		sweepCodes();
		let outstanding = 0;
		for (const r of codes.values()) if (r.wallet === wallet) outstanding++;
		if (outstanding >= CODE_MAX_PER_WALLET)
			return { error: "too many unused codes for this account", status: 429, code: "TOO_MANY_CODES" };

		let code = randomCode();
		for (let i = 0; codes.has(code) && i < 8; i++) code = randomCode();
		const exp = Date.now() + CODE_TTL_MS;
		codes.set(code, { wallet, exp, used: false });
		return { code, expires_at: new Date(exp).toISOString(), expires_in: Math.round(CODE_TTL_MS / 1000) };
	}

	function redeem({ code, device_id, device_name, client }) {
		const id = clean(device_id, 64);
		if (!id) return { error: "device_id required", status: 400, code: "NO_DEVICE" };
		if (!rateOk("redeem:" + id, REDEEM_RATE_WINDOW_MS, REDEEM_RATE_MAX))
			return { error: "too many attempts — wait a minute", status: 429, code: "RATE_LIMIT" };
		if (!rateOk("redeem:*", REDEEM_RATE_WINDOW_MS, REDEEM_GLOBAL_MAX))
			return { error: "too many attempts right now — try again in a moment", status: 429, code: "RATE_LIMIT" };

		sweepCodes();
		const typed = clean(code, 32).toUpperCase().replace(/[^A-Z0-9]/g, "");
		if (typed.length !== CODE_LEN) return { error: "that code is not valid", status: 400, code: "BAD_CODE" };

		// Scanned rather than looked up, so a wrong code costs the same time as a right one.
		let found = null;
		for (const [c, r] of codes) if (sameSecret(c, typed) && !r.used && r.exp > Date.now()) { found = [c, r]; break; }
		if (!found) return { error: "that code is not valid any more", status: 400, code: "BAD_CODE" };

		const [c, rec] = found;

		// PAIRING OVER AN APP ACCOUNT WOULD ORPHAN IT — refuse, and name the thing they meant to do.
		//
		// A player creates an account in the app, plays for a week, then decides to connect the
		// Phantom wallet they had all along. The obvious move is the one they already know: get a
		// code on the website and type it in. That used to work, and it was the worst outcome
		// available — this device would silently switch to the wallet's (empty) account, and the
		// week of play would still exist, at an address with no credential pointing at it any more.
		// Nobody would see an error. BIND is the flow that keeps it; this refusal is how they find
		// out that flow exists. Checked BEFORE the code is burned, so their code still works after.
		const held = Object.values(tokens).find((v) => v.device_id === id && isWalletless(v.wallet));
		if (held) return {
			error: "This device already has a Chikoria account. Connect your wallet to THAT account instead — open Settings and choose 'Connect a wallet', so everything you have played comes with you.",
			status: 409, code: "WOULD_ORPHAN",
		};

		rec.used = true;                     // burn first: a double-submit must not mint two tokens
		codes.delete(c);

		// One credential per (wallet, device). Re-pairing the same phone replaces its token rather
		// than accumulating rows the player then has to tidy up in the devices list.
		for (const [t, v] of Object.entries(tokens)) {
			if (v.wallet === rec.wallet && v.device_id === id) { delete tokens[t]; dropAppTokensFor(t); }
		}
		let mine = Object.values(tokens).filter((v) => v.wallet === rec.wallet);
		if (mine.length >= DEVICES_MAX_PER_WALLET) {
			// Oldest first — the player is actively pairing this one, so it must not be the loser.
			mine.sort((a, b) => (a.linked_at || 0) - (b.linked_at || 0));
			const evict = mine.slice(0, mine.length - DEVICES_MAX_PER_WALLET + 1);
			for (const [t, v] of Object.entries(tokens)) if (evict.includes(v)) { delete tokens[t]; dropAppTokensFor(t); }
		}

		const token = crypto.randomBytes(32).toString("hex");
		tokens[token] = {
			wallet: rec.wallet,
			device_id: id,
			device_name: clean(device_name, 40) || "iPhone",
			client: clean(client, 24) || "ios-app",
			linked_at: Date.now(),
			last_seen: Date.now(),
		};
		save().catch(() => {});
		return { wallet: rec.wallet, linkToken: token, label: tokens[token].device_name };
	}

	// ---- app-native accounts -------------------------------------------------------------------
	//
	// CREATE. No wallet, no website, no code — the player taps "Create an account" and is playing.
	// This is the whole point: the App Store build must be playable by someone who has never heard
	// of Solana, and the 500,000 $CHIKI hold that used to guard the gate is not something an app
	// player can be asked to go and acquire.
	//
	// The account's address is off-curve (see the file header). That is checked here rather than
	// assumed, because every value-moving guard downstream is resting on it: if newAddress ever
	// returned an on-curve address, an app-native account would silently become spendable-looking
	// and the guard would wave it through.

	function createAccount({ device_id, device_name, client }) {
		const id = clean(device_id, 64);
		if (!id) return { error: "device_id required", status: 400, code: "NO_DEVICE" };
		if (!rateOk("create:" + id, CREATE_RATE_WINDOW_MS, CREATE_RATE_MAX))
			return { error: "too many accounts from this device — try again later", status: 429, code: "RATE_LIMIT" };
		if (!rateOk("create:*", CREATE_GLOBAL_WINDOW_MS, CREATE_GLOBAL_MAX))
			return { error: "too many new accounts right now — try again in a moment", status: 429, code: "RATE_LIMIT" };

		let wallet = "";
		for (let i = 0; i < 8 && !wallet; i++) {
			const a = String(newAddress() || "");
			// BOTH checks, every time. isPubkey alone would accept a real, signable address.
			// `tokens` is keyed by token, not by address, so the collision check has to look at the
			// values: an address already held by any device is not one to hand out a second time.
			if (a && isPubkey(a) && isWalletless(a) && !bound[a] && !Object.values(tokens).some((v) => v.wallet === a)) wallet = a;
		}
		if (!wallet) {
			log.error("realm-link: could not mint an off-curve account address — refusing to issue a signable one");
			return { error: "could not create an account right now", status: 503, code: "NO_ADDRESS" };
		}

		const token = crypto.randomBytes(32).toString("hex");
		tokens[token] = {
			wallet,
			device_id: id,
			device_name: clean(device_name, 40) || "iPhone",
			client: clean(client, 24) || "ios-app",
			linked_at: Date.now(),
			last_seen: Date.now(),
			walletless: true,
		};
		save().catch(() => {});
		return { wallet, linkToken: token, label: tokens[token].device_name, walletless: true };
	}

	// BIND. The app mints a claim code; the player types it on the website while signed in with a
	// wallet they have PROVEN by signature. Only then does the account gain the ability to sell —
	// which is exactly the rule the owner asked for: play on an app account, sell with Phantom.
	//
	// The migration itself is not done here. Moving an account means moving profiles, sessions,
	// sockets, market rows and cloud saves that live in server.js, and a half-done move is worse
	// than a refused one. This returns the pair of addresses and lets the caller do it
	// transactionally; `commitBind` is called back once it has.

	function claimCode(linkToken, device_id) {
		const rec = resolve(linkToken, device_id);
		if (!rec) return { error: "sign in on this device first", status: 401, code: "NOT_LINKED" };
		// THE ADDRESS, NOT THE FLAG. `rec.walletless` is a token property: it is set at creation,
		// cleared at bind, and persisted through kv — three chances to be stale or wrong. The header
		// of this file argues that the address is a proof and a flag is only a promise, and then this
		// line used to consult the promise. It consults the proof now. `rec.walletless` survives as a
		// hint for the devices list, and nothing gates on it.
		if (!isWalletless(rec.wallet)) return { error: "this device is already on a wallet account", status: 409, code: "ALREADY_WALLET" };
		if (!rateOk("claim:" + rec.wallet, CODE_RATE_WINDOW_MS, CODE_RATE_MAX))
			return { error: "too many codes — wait a minute and try again", status: 429, code: "RATE_LIMIT" };
		sweepCodes();
		for (const [c, r] of claims) if (r.wallet === rec.wallet && !r.used) claims.delete(c);   // one live offer per account

		let code = randomCode();
		for (let i = 0; claims.has(code) && i < 8; i++) code = randomCode();
		const exp = Date.now() + CLAIM_TTL_MS;
		claims.set(code, { wallet: rec.wallet, linkToken: String(linkToken), exp, used: false });
		return { code, expires_at: new Date(exp).toISOString(), expires_in: Math.round(CLAIM_TTL_MS / 1000) };
	}

	/**
	 * Resolve a claim code for a wallet the CALLER HAS ALREADY PROVEN. This function cannot check
	 * that — server.js holds verifyWalletSig — so it is the caller's job, and the caller is the
	 * only route that may reach it. Returns { from, to } for the migration; nothing is moved and
	 * nothing is burned until commitBind.
	 */
	function claimResolve({ code, wallet }) {
		if (!isPubkey(wallet)) return { error: "valid 'wallet' required", status: 400 };
		if (isWalletless(wallet)) return { error: "that is not a wallet you can sign with", status: 400, code: "NOT_A_WALLET" };
		if (!rateOk("claimres:" + wallet, CLAIM_RATE_WINDOW_MS, CLAIM_RATE_MAX))
			return { error: "too many attempts — wait a minute", status: 429, code: "RATE_LIMIT" };
		if (!rateOk("claimres:*", CLAIM_RATE_WINDOW_MS, CLAIM_GLOBAL_MAX))
			return { error: "too many attempts right now — try again in a moment", status: 429, code: "RATE_LIMIT" };
		sweepCodes();
		const typed = clean(code, 32).toUpperCase().replace(/[^A-Z0-9]/g, "");
		if (typed.length !== CODE_LEN) return { error: "that code is not valid", status: 400, code: "BAD_CODE" };
		let found = null;
		for (const [c, r] of claims) if (sameSecret(c, typed) && !r.used && !r.inflight && r.exp > Date.now()) { found = [c, r]; break; }
		if (!found) return { error: "that code is not valid any more", status: 400, code: "BAD_CODE" };
		const [c, rec] = found;
		// The code is now owned by one migration until commitBind burns it or releaseClaim gives it
		// back. Two /link/bind calls carrying the same code used to both resolve it and both start
		// moving the account; the second one now sees "not valid" instead of a half-moved profile.
		// (A wallet that signs cannot equal an app address — one is on-curve, the other is not — so
		// there is no same-account case to check for here.)
		rec.inflight = true;
		return { from: rec.wallet, to: wallet, _code: c };
	}

	/** A bind that resolved a code and then did not commit hands the code back so a retry can use it. */
	function releaseClaim(code) {
		const rec = claims.get(String(code || ""));
		if (rec && !rec.used) rec.inflight = false;
	}

	/**
	 * The migration landed. Burn the code, move every device credential from the retired address
	 * onto the wallet, and remember where the account went.
	 *
	 * The devices deliberately KEEP WORKING and are not signed out. The player is standing there
	 * having just proved this is their account; making them re-pair the phone they are holding
	 * would be a punishment for doing the thing we asked them to do.
	 */
	function commitBind({ from, to, code }) {
		if (!isPubkey(from) || !isPubkey(to)) return { error: "bad bind", status: 400 };
		const c = String(code || "");
		const rec = claims.get(c);
		if (rec) { rec.used = true; claims.delete(c); }

		let moved = 0;
		for (const [t, v] of Object.entries(tokens)) {
			if (v.wallet !== from) continue;
			v.wallet = to;
			delete v.walletless;               // it is a real wallet account now; the guard reads this
			v.bound_at = Date.now();
			dropAppTokensFor(t);               // force a fresh app token minted against the new wallet
			moved++;
		}
		bound[from] = { to, at: Date.now() };
		if (deletions[from]) delete deletions[from];   // a pending delete is moot — the owner just arrived
		save().catch(() => {});
		return { bound: true, from, to, devices: moved };
	}

	/** Where an app-native account went, if it was bound. "" when it was not. */
	function boundTo(wallet) {
		const v = bound[String(wallet || "")];
		return v ? v.to : "";
	}

	// ---- tokens ------------------------------------------------------------------------------

	/** The record for a token, if it is real and bound to this device. Touches last_seen. */
	function resolve(token, device_id) {
		const t = String(token || "");
		if (t.length !== 64) return null;
		const rec = tokens[t];
		if (!rec) return null;
		// A token is bound to the device that minted it, and the caller has to say which device it
		// is. This used to be checked only when a device_id was SENT, which made the check optional
		// for exactly the caller it exists for: a leaked token worked as long as the thief left the
		// field out. Now a token with a device on record needs that device, every time.
		const id = clean(device_id, 64);
		if (rec.device_id && id !== rec.device_id) return null;
		const now = Date.now();
		if (now - (rec.last_seen || 0) > 60 * 1000) { rec.last_seen = now; save().catch(() => {}); }
		return rec;
	}

	function dropAppTokensFor(linkToken) {
		for (const [k, v] of appTokens) if (v.linkToken === linkToken) appTokens.delete(k);
	}

	/**
	 * The market token handed to a paired device. Separate pool on purpose — see the file header.
	 * Stable per link token so a reload does not invalidate the one the game is holding.
	 */
	function mintAppToken(wallet, linkToken) {
		for (const [k, v] of appTokens) if (v.linkToken === linkToken && v.wallet === wallet) return k;
		if (appTokens.size > 50000) { for (const k of appTokens.keys()) { appTokens.delete(k); if (appTokens.size <= 25000) break; } }
		const t = crypto.randomBytes(24).toString("hex");
		appTokens.set(t, { wallet, linkToken });
		return t;
	}

	/** The wallet behind an app market token, or "" — this is what makes "from the app" decidable. */
	function appTokenWallet(token) {
		const v = appTokens.get(String(token || ""));
		return v ? v.wallet : "";
	}

	function devices(wallet) {
		if (!isPubkey(wallet)) return [];
		return Object.entries(tokens)
			.filter(([, v]) => v.wallet === wallet)
			.map(([t, v]) => ({
				device_id: v.device_id,
				device_name: v.device_name,
				client: v.client,
				linked_at: v.linked_at,
				last_seen: v.last_seen,
				// Never the token itself. The devices list is rendered on a web page.
				token_tail: t.slice(-6),
			}))
			.sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
	}

	/** Revoke by device_id (wallet-authenticated) or by the token itself (the app signing out). */
	function revoke({ wallet, device_id, linkToken }) {
		let removed = 0;
		const byToken = String(linkToken || "");
		if (byToken && tokens[byToken]) {
			dropAppTokensFor(byToken);
			delete tokens[byToken];
			removed++;
		} else if (isPubkey(wallet)) {
			const id = clean(device_id, 64);
			for (const [t, v] of Object.entries(tokens)) {
				if (v.wallet !== wallet) continue;
				if (id && v.device_id !== id) continue;
				dropAppTokensFor(t);
				delete tokens[t];
				removed++;
			}
		}
		if (removed) save().catch(() => {});
		return { revoked: removed };
	}

	// ---- account deletion (App Store 5.1.1(v)) ------------------------------------------------
	//
	// A Chikoria account IS a wallet, and the app deliberately cannot prove ownership of one — so a
	// link token must not be enough to destroy it. The shape here is DELAY AND CANCEL: the request
	// is accepted from the app (which is what the guideline requires), it completes after a grace
	// period, and signing in on the website with the actual wallet cancels it. A stolen phone
	// therefore cannot erase an account the owner still uses.
	//
	// EXECUTION IS NOT WIRED HERE, ON PURPOSE. What "delete" removes from a wallet-keyed game
	// economy — the profile, the on-chain assets it does not own, the market history other players
	// settled against — is a product decision, not a detail, and it is still open in IOS-APP.md.
	// `due()` lists the accounts past their grace period so whoever makes that decision can act on
	// it; nothing in this file erases anything.

	function requestDeletion({ wallet, device_id }) {
		if (!isPubkey(wallet)) return { error: "valid 'wallet' required", status: 400 };
		const now = Date.now();
		const existing = deletions[wallet];
		if (existing) return { accepted: true, completes_at: new Date(existing.completes_at).toISOString(), already: true };
		// An app-native account has no wallet holder who might turn up and object, and nothing
		// on-chain that outlives it — so the long grace protects nobody and just leaves a player who
		// asked to be forgotten waiting a week. It still is not instant, because the one thing a
		// grace period genuinely buys here is an undo for a mis-tap.
		const app = isWalletless(wallet);
		const grace = app ? DELETE_GRACE_APP_MS : DELETE_GRACE_MS;
		deletions[wallet] = { requested_at: now, completes_at: now + grace, device_id: clean(device_id, 64), app };
		save().catch(() => {});
		return { accepted: true, completes_at: new Date(deletions[wallet].completes_at).toISOString(), grace_days: Math.round(grace / 86400000) };
	}

	/** Called when a wallet proves ownership by SIGNATURE — the owner is alive, so stand down. */
	function cancelDeletion(wallet) {
		if (!deletions[wallet]) return { cancelled: false };
		delete deletions[wallet];
		save().catch(() => {});
		return { cancelled: true };
	}

	/**
	 * The same stand-down, reachable by the DEVICE instead of a signature — and only for an
	 * app-native account. For those there is no stronger owner than the phone: nobody can sign for
	 * the address, so cancel-by-signature would mean a request can never be withdrawn at all. For a
	 * real wallet this stays refused, because "a stolen phone must not be able to cancel the very
	 * request its theft would have prompted" is the reason the grace period exists.
	 */
	function cancelDeletionByDevice(linkToken, device_id) {
		const rec = resolve(linkToken, device_id);
		if (!rec || !isWalletless(rec.wallet)) return { cancelled: false };   // the address, not the flag
		return cancelDeletion(rec.wallet);
	}

	function deletionStatus(wallet) { return deletions[wallet] || null; }

	function due(now = Date.now()) {
		return Object.entries(deletions)
			.filter(([, v]) => v.completes_at <= now)
			.map(([wallet, v]) => ({ wallet, ...v }));
	}

	function stats() {
		return {
			codes: codes.size, claims: claims.size, tokens: Object.keys(tokens).length,
			appTokens: appTokens.size, deletions: Object.keys(deletions).length,
			bound: Object.keys(bound).length, ready,
		};
	}

	return {
		newCode, redeem, resolve, revoke, devices,
		createAccount, claimCode, claimResolve, releaseClaim, commitBind, boundTo,
		mintAppToken, appTokenWallet,
		requestDeletion, cancelDeletion, cancelDeletionByDevice, deletionStatus, due,
		stats, restored,
		// exported for tests
		_constants: { CODE_LEN, CODE_TTL_MS, CLAIM_TTL_MS, DELETE_GRACE_MS, DELETE_GRACE_APP_MS, DEVICES_MAX_PER_WALLET, CREATE_RATE_MAX, CLAIM_RATE_MAX, REDEEM_GLOBAL_MAX, CLAIM_GLOBAL_MAX },
	};
}
