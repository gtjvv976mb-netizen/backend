/* Realm Link — pairing an iOS device to a Chikoria account without a wallet on the device.
 *
 * The app has no Phantom and never will: it ships through the App Store, where a wallet-connect
 * button is a guideline 3.1.1 problem and a transaction is a 3.1.5(b) one. So identity moves off
 * the device. The player signs in on chikimonsters.com/link/ with the wallet they already have,
 * mints a short code, types it into the app once, and the app holds a DEVICE CREDENTIAL from then
 * on.
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
const DEVICES_MAX_PER_WALLET = 10;
const DELETE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const KV_TOKENS = "link_tokens";
const KV_DELETIONS = "link_deletions";

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

export function createRealmLink({ store, isPubkey, log = console }) {
	if (!store || typeof store.kvGet !== "function") throw new Error("realm-link needs a store");
	if (typeof isPubkey !== "function") throw new Error("realm-link needs isPubkey");

	// code -> { wallet, exp, used }   In memory only, and deliberately so: a code lives ten
	// minutes, and a redeploy that forgets one costs the player a re-tap of "Get a code". A token
	// forgotten would sign a player out of their phone, which is why THOSE are persisted.
	const codes = new Map();
	// token -> { wallet, device_id, device_name, client, linked_at, last_seen }
	let tokens = Object.create(null);
	// appMarketToken -> { wallet, linkToken }   The separate pool described at the top of the file.
	const appTokens = new Map();
	// wallet -> { requested_at, completes_at, device_id }
	let deletions = Object.create(null);

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
	]).then(() => { ready = true; });

	async function save() {
		if (!ready) await restored;
		if (!ready) {
			log.error("realm-link: NOT persisting — restore incomplete; refusing to overwrite every paired device");
			return;
		}
		try {
			await Promise.all([store.kvSet(KV_TOKENS, tokens), store.kvSet(KV_DELETIONS, deletions)]);
		} catch (e) { log.warn("realm-link persist failed:", String(e?.message || e)); }
	}

	function sweepCodes() {
		const now = Date.now();
		for (const [c, r] of codes) if (r.exp <= now || r.used) codes.delete(c);
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

		sweepCodes();
		const typed = clean(code, 32).toUpperCase().replace(/[^A-Z0-9]/g, "");
		if (typed.length !== CODE_LEN) return { error: "that code is not valid", status: 400, code: "BAD_CODE" };

		// Scanned rather than looked up, so a wrong code costs the same time as a right one.
		let found = null;
		for (const [c, r] of codes) if (sameSecret(c, typed) && !r.used && r.exp > Date.now()) { found = [c, r]; break; }
		if (!found) return { error: "that code is not valid any more", status: 400, code: "BAD_CODE" };

		const [c, rec] = found;
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

	// ---- tokens ------------------------------------------------------------------------------

	/** The record for a token, if it is real and bound to this device. Touches last_seen. */
	function resolve(token, device_id) {
		const t = String(token || "");
		if (t.length !== 64) return null;
		const rec = tokens[t];
		if (!rec) return null;
		// device_id is checked when the caller sends one. A token that leaked without the device id
		// is still a token, so this is defence in depth rather than the lock itself.
		const id = clean(device_id, 64);
		if (id && rec.device_id && id !== rec.device_id) return null;
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
		deletions[wallet] = { requested_at: now, completes_at: now + DELETE_GRACE_MS, device_id: clean(device_id, 64) };
		save().catch(() => {});
		return { accepted: true, completes_at: new Date(deletions[wallet].completes_at).toISOString() };
	}

	/** Called when a wallet proves ownership by SIGNATURE — the owner is alive, so stand down. */
	function cancelDeletion(wallet) {
		if (!deletions[wallet]) return { cancelled: false };
		delete deletions[wallet];
		save().catch(() => {});
		return { cancelled: true };
	}

	function deletionStatus(wallet) { return deletions[wallet] || null; }

	function due(now = Date.now()) {
		return Object.entries(deletions)
			.filter(([, v]) => v.completes_at <= now)
			.map(([wallet, v]) => ({ wallet, ...v }));
	}

	function stats() {
		return { codes: codes.size, tokens: Object.keys(tokens).length, appTokens: appTokens.size, deletions: Object.keys(deletions).length, ready };
	}

	return {
		newCode, redeem, resolve, revoke, devices,
		mintAppToken, appTokenWallet,
		requestDeletion, cancelDeletion, deletionStatus, due,
		stats, restored,
		// exported for tests
		_constants: { CODE_LEN, CODE_TTL_MS, DELETE_GRACE_MS, DEVICES_MAX_PER_WALLET },
	};
}
