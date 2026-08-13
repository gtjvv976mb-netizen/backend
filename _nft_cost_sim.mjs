// _nft_cost_sim.mjs — PROOF of the 2026-08-13 mint-cost fix in POST /assets/nft/mint.
//
//   THE CHANGE (player-paid branch only):
//     1. NFT_MINT_COST_LAMPORTS (default 5,700,000 = 0.0057 SOL, env-overridable) is BOTH the quote
//        handed to the player AND the pre-check floor — deliberately ONE value, so the game can never
//        refuse a wallet for holding less than it told them to bring.
//     2. Before the reservation is written, `conn.getBalance(payer)`; under the floor -> 402
//        {error, code:"funds", payerLamports, needLamports, payerSol, needSol} with NO reservation,
//        NO edition burn, NO mintPending, NO chain create.
//     3. A balance read that THROWS must NOT block the mint (payerLamports stays null).
//     4. The success reply carries costLamports/costSol/payerLamports/payerSol.
//
// Isolation contract (asserted, not assumed):
//   * throwaway nacl keypairs -> TREASURY_SECRET and NFT_MINT_DELEGATE_SECRET; never a real key
//   * RPC_URL points at a LOCAL fake JSON-RPC server this file runs on 127.0.0.1. That is what makes
//     the balance controllable AND it exercises the REAL `conn.getBalance` code path over HTTP —
//     nothing is monkeypatched. Every request it receives is counted and printed.
//   * VERIFY_HOLDERS=false, NETWORK=devnet (a label), unique PORT, NO DATABASE_URL (memory store)
//   * DAS reader, the chain create and both compose seams are stubbed and COUNTED
//   * the live backend is never contacted, by any method.
// Every assertion prints the ACTUAL measured value.
//
// Roles (env is read at module-eval, so a flag change needs its own PROCESS):
//   main    — sections 0-7 on the real ./server.js
//   envov   — NFT_MINT_COST_LAMPORTS=4242424: quote AND threshold must move TOGETHER
//   envbad  — NFT_MINT_COST_LAMPORTS="not-a-number": falls back to the shipped default
//   paused  — NFT_MINT_PAUSED=1: measure whether the pause gate or the funds gate binds first
//   prefix  — the SAME file against .prefix_cost_snapshot.js. A red-team control: it MUST go red, or
//             the assertions above are not actually bound to the fix. Its tally is reported, not folded.
//
// PROVENANCE OF .prefix_cost_snapshot.js: on 2026-08-13 it was copied verbatim from
// chiki-backend-repo-FIXED/server.js (md5 3a15f50486f3ce2e92fb1c4a077fa552, git acd4d51), which at
// that moment was the TRUE pre-fix file — `diff` against the dev copy was 42 lines and every one of
// them belonged to this change. It is a FROZEN snapshot; once the fix is mirrored into the deploy
// repo, DO NOT regenerate it from there or the control stops being a control.
import nacl from "tweetnacl"; import bs58 from "bs58";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROLE = String(process.env.COST_ROLE || "main");
const PORT = String(process.env.COST_PORT || "39941");
const RPC_PORT = Number(process.env.COST_RPC_PORT || 59941);
const TARGET = process.env.COST_TARGET || "./server.js";

const _t = nacl.sign.keyPair();                                   // THROWAWAY — never a real key
const _dele = nacl.sign.keyPair();                                // THROWAWAY mint delegate
const POOL = bs58.encode(nacl.sign.keyPair().publicKey);
const COLLECTION = "2iyJEoY5mUnBXJ139R5mQSkfQtgzZXTP4BtnQaiGEgTN";  // the live Core collection — NEVER contacted

// ---- the FAKE RPC ------------------------------------------------------------------------------
// A JSON-RPC responder on loopback. `getBalance` answers from a Map I control; `mode="err"` answers a
// well-formed JSON-RPC error, which is what makes web3.js THROW (verified: SolanaJSONRPCError).
const balances = new Map();                        // pubkey -> lamports
const DEFAULT_LAMPORTS = 900_000_000;              // 0.9 SOL — comfortably above any floor tested
let rpcMode = "ok";
const rpcCalls = [];                               // {method, arg}
const rpcCount = (method, arg) => rpcCalls.filter(c => c.method === method && (arg === undefined || c.arg === arg)).length;
const rpcServer = http.createServer((req, res) => {
  let b = ""; req.on("data", d => { b += d; });
  req.on("end", () => {
    let j = {}; try { j = JSON.parse(b); } catch (e) {}
    const method = String(j.method || ""), arg = String((j.params && j.params[0]) || "");
    rpcCalls.push({ method, arg });
    res.setHeader("Content-Type", "application/json");
    if (method === "getBalance") {
      if (rpcMode === "err") return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "synthetic RPC outage" }, id: j.id }));
      const v = balances.has(arg) ? balances.get(arg) : DEFAULT_LAMPORTS;
      return res.end(JSON.stringify({ jsonrpc: "2.0", result: { context: { apiVersion: "1.18.0", slot: 1 }, value: v }, id: j.id }));
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", result: null, id: j.id }));
  });
});
await new Promise(r => rpcServer.listen(RPC_PORT, "127.0.0.1", r));

process.env.RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
delete process.env.CLIENT_RPC;
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = PORT;
process.env.ADMIN_KEY = "cost-admin-key";
process.env.TEAM_WALLET = POOL;
process.env.CHIK_NFT_MINT = "1";
process.env.NFT_COLLECTION = COLLECTION;
process.env.NFT_MINT_DELEGATE_SECRET = JSON.stringify(Array.from(_dele.secretKey));
process.env.NFT_META_BASE = `http://127.0.0.1:${PORT}`;
process.env.CHIK_MINT_AT_SALE = "1";       // the player-paid branch exists only under this flag
process.env.CHIK_ME_MARKET = "1";
process.env.CHIK_NFT_HANDOVER = "1";
process.env.CHIK_EGG_MEGUARD = "0";
delete process.env.ME_API_KEY;
delete process.env.DATABASE_URL;
if (ROLE !== "paused") process.env.NFT_MINT_PAUSED = "0";
if (ROLE !== "envov" && ROLE !== "envbad") delete process.env.NFT_MINT_COST_LAMPORTS;

const B = `http://127.0.0.1:${PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, body: j, text: t }; };
const get = async (p) => { const r = await fetch(B + p); const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, body: j, text: t }; };

const SRV = await import(TARGET);
await new Promise((r) => setTimeout(r, 1500));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
const short = (s) => String(s || "").slice(0, 10);

const DEFAULT_FLOOR = 5700000;                     // the shipped default, per the fix
const FLOOR = ROLE === "envov" ? 4242424 : DEFAULT_FLOOR;

let _n = 0;
async function mkWallet(lamports) {
  const kp = nacl.sign.keyPair(); const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const v = await post("/verify", { wallet, netId: "co" + Date.now() + "_" + (++_n), authMsg, authSig });
  if (lamports !== undefined) balances.set(wallet, lamports);
  return { wallet, mktToken: v.body.mktToken };
}

// ---- the stubbed chain --------------------------------------------------------------------------
const dasMap = new Map();
let dasTotal = 0;
SRV._setNftDasStubForTest((mint) => { dasTotal++; return dasMap.get(String(mint)) || { dasFailed: true, absent: true }; });
const coreObs = (owner) => ({ owner, burned: false, iface: "MplCoreAsset", collection: COLLECTION });
let coreCreates = 0, composeMintOnly = 0, composeMintList = 0;
// a create LANDS on the stub chain, so the route's own read-back verify (nftVerifyOnchain) can pass —
// without this the admin path 409s "still confirming" and the section measures my stub, not the code.
SRV._setNftCoreStubForTest(async (args) => { coreCreates++; dasMap.set(String(args.assetAddr), coreObs(args.owner)); return { address: args.assetAddr, signature: "sig" + coreCreates }; });
SRV._setMasComposeStubForTest(async () => { composeMintList++; return { ok: true, b64: "TXBYTES", ver: 0, bytes: 7 }; });
SRV._setMasMintComposeStubForTest(async () => { composeMintOnly++; return { ok: true, b64: "TXBYTES", ver: 0, bytes: 7 }; });

const row_ = (id) => SRV._assetRowForTest(id);
const chainOf = (id) => (row_(id)?.chain || []).map((c) => c.what);
const countEv = (id, what) => (row_(id)?.chain || []).filter((c) => c.what === what).length;
const edState = () => SRV._nftEditionState();
const mintReq = (w, id) => post("/assets/nft/mint", { wallet: w.wallet, mktToken: w.mktToken, id });
// a creature born the way the real hatch routes make one (parent link intact — the mint gate's witness)
const born_ = (w, sp) => SRV._mintHatchedForTest("chikimon", w.wallet, { sp: sp || "drolax", kind: "normal", lvl: 1 });

console.log(`\n=== _nft_cost_sim (${ROLE}) port ${PORT} rpc ${RPC_PORT} target ${TARGET} ===`);

// =================================================================================================
sec("0. ISOLATION — what this process is actually talking to");
{
  const h = await get("/health");
  const mas = SRV._masFlagsForTest();
  console.log(`  store=${h.body.store} RPC_URL=${process.env.RPC_URL} collection=${short(SRV._nftCollectionForTest())} nftOn=${SRV._nftMintOn()} mintAtSale=${mas.on} NFT_MINT_PAUSED=${process.env.NFT_MINT_PAUSED} NFT_MINT_COST_LAMPORTS=${process.env.NFT_MINT_COST_LAMPORTS ?? "(unset)"}`);
  chk(h.body.store === "memory", `memory store, no database (actual "${h.body.store}")`);
  chk(SRV._nftMintOn() === true, `CHIK_NFT_MINT on (actual ${SRV._nftMintOn()})`);
  chk(mas.on === true, `CHIK_MINT_AT_SALE on — the player-paid branch exists (actual ${mas.on})`);
  chk(/127\.0\.0\.1/.test(process.env.RPC_URL), `RPC_URL is loopback-only, no live node (actual "${process.env.RPC_URL}")`);
  chk(SRV._nftCollectionForTest() === COLLECTION, `collection configured (actual ${short(SRV._nftCollectionForTest())})`);
}

// =================================================================================================
// ROLE: envov / envbad — the env override. Both the QUOTE and the THRESHOLD must move together.
// =================================================================================================
if (ROLE === "envov" || ROLE === "envbad") {
  const EXPECT = ROLE === "envov" ? 4242424 : DEFAULT_FLOOR;   // envbad: garbage env -> shipped default
  sec(`E. ENV OVERRIDE — NFT_MINT_COST_LAMPORTS="${process.env.NFT_MINT_COST_LAMPORTS}" (expect the constant to be ${EXPECT})`);
  {
    // (a) THE QUOTE. A funded wallet mints; costLamports must be the overridden value.
    const rich = await mkWallet(900_000_000);
    const b1 = born_(rich);
    const r1 = await mintReq(rich, b1.id);
    console.log(`  quote: status=${r1.status} costLamports=${r1.body.costLamports} costSol=${r1.body.costSol} payerLamports=${r1.body.payerLamports}`);
    chk(r1.status === 200 && r1.body.costLamports === EXPECT, `the QUOTE moved to the env value (actual costLamports=${r1.body.costLamports}, status ${r1.status})`);

    // (b) THE THRESHOLD, one lamport under.
    const under = await mkWallet(EXPECT - 1);
    const b2 = born_(under);
    const r2 = await mintReq(under, b2.id);
    console.log(`  under: status=${r2.status} code=${r2.body.code} payerLamports=${r2.body.payerLamports} needLamports=${r2.body.needLamports}`);
    chk(r2.status === 402 && r2.body.code === "funds" && r2.body.needLamports === EXPECT,
      `the THRESHOLD moved too: ${EXPECT - 1} lamports refused 402/funds with needLamports=${r2.body.needLamports} (status ${r2.status}, code "${r2.body.code}")`);

    // (c) EXACTLY at the new floor is accepted.
    const at = await mkWallet(EXPECT);
    const b3 = born_(at);
    const r3 = await mintReq(at, b3.id);
    console.log(`  at floor: status=${r3.status} tx=${r3.body.tx ? "yes" : "no"} costLamports=${r3.body.costLamports} payerLamports=${r3.body.payerLamports}`);
    chk(r3.status === 200 && !!r3.body.tx && r3.body.payerLamports === EXPECT,
      `exactly ${EXPECT} lamports composes a tx (status ${r3.status}, tx=${r3.body.tx ? "present" : "absent"}, payerLamports=${r3.body.payerLamports})`);

    // (d) THEY CANNOT DIVERGE. Quote == threshold, measured on the SAME run, not asserted from source.
    chk(r1.body.costLamports === r2.body.needLamports,
      `quote and refusal floor are ONE value (quote=${r1.body.costLamports}, floor=${r2.body.needLamports})`);

    // (e) The decisive one for envov: a balance ABOVE the override but BELOW the shipped default must
    //     be ACCEPTED — proving the threshold really moved and did not stay pinned at 5,700,000.
    if (ROLE === "envov") {
      const mid = await mkWallet(5_000_000);                 // > 4,242,424 and < 5,700,000
      const b4 = born_(mid);
      const r4 = await mintReq(mid, b4.id);
      console.log(`  between: 5,000,000 lamports -> status=${r4.status} tx=${r4.body.tx ? "yes" : "no"} costLamports=${r4.body.costLamports}`);
      chk(r4.status === 200 && !!r4.body.tx,
        `5,000,000 lamports (above the override, BELOW the 5,700,000 default) is served, not refused (status ${r4.status}, tx=${r4.body.tx ? "present" : "absent"})`);
    }
  }
  console.log(`\nCOST_CHILD_TALLY pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

// =================================================================================================
// ROLE: paused — where does the funds pre-check sit relative to the NFT_MINT_PAUSED gate?
// =================================================================================================
if (ROLE === "paused") {
  sec("P. GATE ORDER vs NFT_MINT_PAUSED=1 (measured, not assumed)");
  {
    const poor = await mkWallet(1);
    const b1 = born_(poor);
    const r1 = await mintReq(poor, b1.id);
    const balReads = rpcCount("getBalance", poor.wallet);
    console.log(`  PAUSED broke payer: status=${r1.status} error="${r1.body.error}" code=${r1.body.code} getBalance(payer)=${balReads}`);
    chk(r1.status === 503 && /paused/.test(String(r1.body.error)),
      `the PAUSE gate binds BEFORE the funds pre-check — 1 lamport got 503 "${r1.body.error}", not 402 (status ${r1.status})`);
    chk(balReads === 0, `a paused mint never reads the payer's balance (actual getBalance calls for that payer = ${balReads})`);
    chk(row_(b1.id).mintPending === undefined, `PAUSED still leaves no reservation (mintPending=${JSON.stringify(row_(b1.id).mintPending)})`);

    const rich = await mkWallet(900_000_000);
    const b2 = born_(rich);
    const r2 = await mintReq(rich, b2.id);
    console.log(`  PAUSED funded payer (control): status=${r2.status} error="${r2.body.error}"`);
    chk(r2.status === 503, `a FUNDED payer is refused identically while paused (status ${r2.status}, "${r2.body.error}") — the 503 is the pause, not the money`);
  }
  console.log(`\nCOST_CHILD_TALLY pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

// =================================================================================================
// 1. THE IMPORTANT ONE — a payer under the floor is refused AND the row is untouched.
// =================================================================================================
sec("1. UNDER THE FLOOR — 402 code:\"funds\", and the row must not be stranded");
let SEC1 = null;
{
  const poor = await mkWallet(FLOOR - 1);
  const b = born_(poor);
  const r0 = row_(b.id);
  const key = `chikimon:drolax`;
  const edBefore = { ...edState() };
  const editionAtIssue = r0.edition;
  const chainBefore = chainOf(b.id).join(",");
  const composeBefore = composeMintOnly, createsBefore = coreCreates;
  console.log(`  fixture: id=${short(b.id)} sp=${r0.sp} edition-at-issue=${editionAtIssue} chain=[${chainBefore}] editionCounter[${key}]=${edBefore[key]}`);

  const r = await mintReq(poor, b.id);
  console.log(`  reply: status=${r.status} body=${JSON.stringify(r.body)}`);
  chk(r.status === 402, `an under-funded payer gets HTTP 402 (actual ${r.status})`);
  chk(r.body.code === "funds", `code is "funds" (actual "${r.body.code}")`);
  chk(r.body.payerLamports === FLOOR - 1, `payerLamports is the REAL balance ${FLOOR - 1} (actual ${r.body.payerLamports})`);
  chk(r.body.needLamports === FLOOR, `needLamports is the constant ${FLOOR} (actual ${r.body.needLamports})`);
  chk(r.body.payerSol === (FLOOR - 1) / 1e9, `payerSol is payerLamports/1e9 (actual ${r.body.payerSol}, expected ${(FLOOR - 1) / 1e9})`);
  chk(r.body.needSol === FLOOR / 1e9, `needSol is needLamports/1e9 = ${FLOOR / 1e9} SOL (actual ${r.body.needSol})`);
  chk(typeof r.body.error === "string" && r.body.error.length > 0, `carries a human error string (actual "${r.body.error}")`);

  // ---- THE ROW MUST BE EXACTLY AS IT WAS ----
  const r1 = row_(b.id);
  const edAfter = edState();
  console.log(`  row after: mintPending=${JSON.stringify(r1.mintPending)} mint=${JSON.stringify(r1.mint)} edition=${r1.edition} chain=[${chainOf(b.id).join(",")}] editionCounter[${key}]=${edAfter[key]}`);
  chk(r1.mintPending === undefined, `NO reservation was written (mintPending=${JSON.stringify(r1.mintPending)})`);
  chk(r1.mint === undefined || r1.mint === null, `NO mint recorded (mint=${JSON.stringify(r1.mint)})`);
  chk(r1.edition === editionAtIssue, `the row's edition is untouched (before ${editionAtIssue}, after ${r1.edition})`);
  chk(edAfter[key] === edBefore[key], `the edition COUNTER did not advance — no number burned (before ${edBefore[key]}, after ${edAfter[key]})`);
  chk(chainOf(b.id).join(",") === chainBefore, `no chain event appended (before [${chainBefore}], after [${chainOf(b.id).join(",")}])`);
  chk(countEv(b.id, "mint_reserved") === 0 && countEv(b.id, "mint_submitted") === 0,
    `no mint_reserved / mint_submitted (actual ${countEv(b.id, "mint_reserved")} / ${countEv(b.id, "mint_submitted")})`);
  chk(coreCreates === createsBefore, `NO on-chain create was attempted (coreCreates before ${createsBefore}, after ${coreCreates})`);
  chk(composeMintOnly === composeBefore, `NO transaction was composed (compose calls before ${composeBefore}, after ${composeMintOnly})`);
  chk(SRV._nftForgetPendingKeyForTest(b.id) === null, `no ephemeral mint keypair was generated for this id (pending key = ${SRV._nftForgetPendingKeyForTest(b.id)})`);

  // a wallet with literally nothing
  const broke = await mkWallet(0);
  const b2 = born_(broke);
  const rz = await mintReq(broke, b2.id);
  console.log(`  zero-balance: status=${rz.status} code=${rz.body.code} payerLamports=${rz.body.payerLamports} payerSol=${rz.body.payerSol}`);
  chk(rz.status === 402 && rz.body.payerLamports === 0 && rz.body.payerSol === 0,
    `a 0-lamport wallet is refused with payerLamports=${rz.body.payerLamports}, payerSol=${rz.body.payerSol} (status ${rz.status})`);
  chk(row_(b2.id).mintPending === undefined, `and its row is likewise untouched (mintPending=${JSON.stringify(row_(b2.id).mintPending)})`);
  SEC1 = { need: r.body.needLamports };
}

// =================================================================================================
// 2. AT THE FLOOR AND ABOVE — both compose a transaction, and the quote IS the floor.
// =================================================================================================
sec("2. AT THE FLOOR AND ONE ABOVE — a composed tx, costLamports == the constant");
{
  const at = await mkWallet(FLOOR);
  const bA = born_(at);
  const rA = await mintReq(at, bA.id);
  console.log(`  exactly ${FLOOR}: status=${rA.status} tx=${rA.body.tx} bytes=${rA.body.bytes} costLamports=${rA.body.costLamports} costSol=${rA.body.costSol} payerLamports=${rA.body.payerLamports} payerSol=${rA.body.payerSol} edition=${rA.body.edition} mintPending=${rA.body.mintPending}`);
  chk(rA.status === 200, `a payer at EXACTLY the floor is served (actual ${rA.status})`);
  chk(typeof rA.body.tx === "string" && rA.body.tx.length > 0, `it carries a composed transaction (tx="${rA.body.tx}")`);
  chk(rA.body.costLamports === FLOOR, `costLamports === the constant (actual ${rA.body.costLamports})`);
  chk(rA.body.costSol === FLOOR / 1e9, `costSol === ${FLOOR / 1e9} (actual ${rA.body.costSol})`);
  chk(rA.body.payerLamports === FLOOR, `payerLamports is non-null and real (actual ${rA.body.payerLamports})`);
  chk(rA.body.payerSol === FLOOR / 1e9, `payerSol is non-null (actual ${rA.body.payerSol})`);
  chk(!/0\.004/.test(String(rA.body.note)), `the note no longer promises "~0.004 SOL" (actual note: "${String(rA.body.note).slice(0, 72)}…")`);
  chk(/costSol/.test(String(rA.body.note)), `the note points at costSol instead (note contains "costSol": ${/costSol/.test(String(rA.body.note))})`);

  const above = await mkWallet(FLOOR + 1);
  const bB = born_(above);
  const rB = await mintReq(above, bB.id);
  console.log(`  ${FLOOR + 1}: status=${rB.status} tx=${rB.body.tx} costLamports=${rB.body.costLamports} payerLamports=${rB.body.payerLamports}`);
  chk(rB.status === 200 && !!rB.body.tx, `one lamport ABOVE the floor is served with a tx (status ${rB.status}, tx="${rB.body.tx}")`);
  chk(rB.body.costLamports === FLOOR && rB.body.payerLamports === FLOOR + 1,
    `costLamports=${rB.body.costLamports} (constant) and payerLamports=${rB.body.payerLamports} (the wallet's own)`);

  // THE ONE-VALUE PROPERTY: the number quoted here is the number refused in section 1.
  chk(rA.body.costLamports === SEC1.need,
    `THE QUOTE AND THE FLOOR ARE THE SAME NUMBER — quote ${rA.body.costLamports} == refusal floor ${SEC1.need}`);
  // and the reservation for the served payer DID happen
  chk(row_(bA.id).mintPending && row_(bA.id).mintPending.addr === rA.body.tokenMint,
    `the served payer got a real reservation at the address it was handed (row=${short(row_(bA.id).mintPending?.addr)}, reply=${short(rA.body.tokenMint)})`);
}

// =================================================================================================
// 3. THE RPC THROWS — an outage is not evidence of an empty wallet.
// =================================================================================================
sec("3. BALANCE READ THROWS — the mint must still work, payerLamports null");
{
  const w = await mkWallet(1);                 // 1 lamport: if the read succeeded this WOULD be a 402
  const b = born_(w);
  rpcMode = "err";
  const r = await mintReq(w, b.id);
  rpcMode = "ok";
  console.log(`  reply: status=${r.status} tx=${r.body.tx} costLamports=${r.body.costLamports} payerLamports=${JSON.stringify(r.body.payerLamports)} payerSol=${JSON.stringify(r.body.payerSol)}`);
  chk(r.status === 200, `a throwing getBalance does NOT block the mint (actual ${r.status})`);
  chk(typeof r.body.tx === "string" && r.body.tx.length > 0, `a transaction was still composed (tx="${r.body.tx}")`);
  chk(r.body.payerLamports === null, `payerLamports is null, not 0 and not a guess (actual ${JSON.stringify(r.body.payerLamports)})`);
  chk(r.body.payerSol === null, `payerSol is null too (actual ${JSON.stringify(r.body.payerSol)})`);
  chk(r.body.costLamports === FLOOR, `the quote is still served during the outage (actual ${r.body.costLamports})`);
  chk(!!row_(b.id).mintPending, `the reservation was made — the mint genuinely proceeded (mintPending.addr=${short(row_(b.id).mintPending?.addr)})`);
  chk(row_(b.id).mintPending.addr === r.body.tokenMint, `and it matches the address handed back (${short(row_(b.id).mintPending?.addr)} vs ${short(r.body.tokenMint)})`);
}

// =================================================================================================
// 4. THE RPC BILL — how many extra reads does one mint now cost?
// =================================================================================================
sec("4. RPC COST — getBalance calls per mint, counted at the wire");
let SEC4 = null;
{
  const w = await mkWallet(900_000_000);
  const b = born_(w);
  const before = rpcCalls.length;
  const r = await mintReq(w, b.id);
  const mine = rpcCalls.slice(before);
  const balMine = mine.filter(c => c.method === "getBalance" && c.arg === w.wallet).length;
  console.log(`  ONE SUCCESSFUL player-paid mint: total RPC requests=${mine.length} [${mine.map(c => c.method).join(",")}], getBalance(payer)=${balMine}, status=${r.status}`);
  chk(r.status === 200, `(control) the mint succeeded (status ${r.status})`);
  // Was 2 until the reply stopped re-reading and started quoting the pre-check's value. The player is
  // waiting on this request, so the second round-trip was pure latency; 1 is the floor (the pre-check
  // itself cannot be skipped without giving up the no-stranded-row guarantee this whole gate exists for).
  chk(balMine === 1, `a successful mint reads the payer's balance exactly ONCE — the reply quotes the pre-check (actual ${balMine})`);
  chk(mine.every(c => c.method === "getBalance"), `every RPC request the mint made is a getBalance (actual methods: [${[...new Set(mine.map(c => c.method))].join(",")}], total ${mine.length})`);

  const poor = await mkWallet(1);
  const b2 = born_(poor);
  const before2 = rpcCalls.length;
  const r2 = await mintReq(poor, b2.id);
  const mine2 = rpcCalls.slice(before2).filter(c => c.method === "getBalance" && c.arg === poor.wallet).length;
  console.log(`  ONE REFUSED mint: getBalance(payer)=${mine2}, status=${r2.status}`);
  chk(r2.status === 402 && mine2 === 1, `a refusal costs exactly ONE read and stops (actual ${mine2} read(s), status ${r2.status})`);
  SEC4 = { success: balMine, refusal: mine2 };
}

// =================================================================================================
// 5. GATE ORDER vs THE ELIGIBILITY GATE — measured with a broke payer.
// =================================================================================================
sec("5. GATE ORDER — funds pre-check vs the eligibility gate (measured)");
{
  // (a) an INELIGIBLE row (flagged) owned by a broke wallet: whichever error comes back names the
  //     gate that binds first.
  const poor = await mkWallet(0);
  const b = born_(poor);
  row_(b.id).gameStatus = "flagged";
  const elig = SRV._nftEligibilityForTest(row_(b.id), poor.wallet);
  const before = rpcCalls.length;
  const r = await mintReq(poor, b.id);
  const reads = rpcCalls.slice(before).filter(c => c.method === "getBalance" && c.arg === poor.wallet).length;
  console.log(`  flagged row + 0 lamports: eligibility says code="${elig.code}" ${elig.status}; route answered ${r.status} "${r.body.error}" code=${r.body.code}; getBalance(payer)=${reads}`);
  chk(r.status === elig.status && r.body.code !== "funds",
    `the ELIGIBILITY gate binds FIRST — answer was ${r.status} "${r.body.error}", not 402/funds`);
  chk(reads === 0, `an ineligible row never costs a balance read (actual ${reads})`);

  // (b) identity/ownership binds before the money too
  const stranger = await mkWallet(0);
  const owner = await mkWallet(900_000_000);
  const b2 = born_(owner);
  const before2 = rpcCalls.length;
  const r2 = await mintReq(stranger, b2.id);
  const reads2 = rpcCalls.slice(before2).filter(c => c.method === "getBalance").length;
  console.log(`  stranger claims someone else's row: status=${r2.status} "${r2.body.error}" getBalance=${reads2}`);
  chk(r2.status === 403 && reads2 === 0, `ownership binds before the funds check (status ${r2.status}, ${reads2} balance reads)`);

  // (c) a live reservation SURVIVES a later refusal — the funds check sits AFTER the pending branch,
  //     so it must not destroy a reservation the player is already mid-signature on.
  const flip = await mkWallet(900_000_000);
  const b3 = born_(flip);
  const ok3 = await mintReq(flip, b3.id);
  const addr3 = row_(b3.id).mintPending?.addr;
  balances.set(flip.wallet, 1);                    // the wallet drains between the two asks
  const r3 = await mintReq(flip, b3.id);
  console.log(`  reserved, then broke: first=${ok3.status} addr=${short(addr3)}; retry=${r3.status} code=${r3.body.code}; reservation now=${short(row_(b3.id).mintPending?.addr)}`);
  chk(r3.status === 402 && r3.body.code === "funds", `the retry is refused on funds (status ${r3.status}, code "${r3.body.code}")`);
  chk(row_(b3.id).mintPending?.addr === addr3,
    `and the EXISTING reservation is left intact, not destroyed (before ${short(addr3)}, after ${short(row_(b3.id).mintPending?.addr)})`);
}

// =================================================================================================
// 6. REGRESSION — the ADMIN / delegate-paid path is not gated by anyone's balance.
// =================================================================================================
sec("6. REGRESSION — the ADMIN (delegate-paid) path ignores every balance");
{
  const broke = await mkWallet(0);
  const b = born_(broke);
  const before = rpcCalls.length;
  const createsBefore = coreCreates;
  const r = await post("/assets/nft/mint", { key: process.env.ADMIN_KEY, id: b.id });
  const mine = rpcCalls.slice(before);
  const reads = mine.filter(c => c.method === "getBalance").length;
  console.log(`  admin mint of a 0-lamport owner's row: status=${r.status} mint=${short(r.body.mint)} edition=${r.body.edition} coreCreates ${createsBefore}->${coreCreates} getBalance=${reads} costLamports=${r.body.costLamports}`);
  chk(r.status === 200, `the admin path mints for a stone-broke owner (actual ${r.status}, error "${r.body.error || "none"}")`);
  chk(coreCreates === createsBefore + 1, `it really submitted a chain create (coreCreates ${createsBefore} -> ${coreCreates})`);
  chk(reads === 0, `NO getBalance gate applies to it — zero balance reads (actual ${reads})`);
  chk(!!row_(b.id).mint, `the row is minted (mint=${short(row_(b.id).mint)})`);
  chk(r.body.costLamports === undefined, `the admin reply carries no player quote (costLamports=${JSON.stringify(r.body.costLamports)}) — that shape is unchanged`);

  // and the delegate never pays a player mint: the player path composed, it never created
  const w = await mkWallet(900_000_000);
  const b2 = born_(w);
  const c0 = coreCreates;
  const r2 = await mintReq(w, b2.id);
  console.log(`  (control) player path: status=${r2.status} coreCreates ${c0}->${coreCreates} compose=${composeMintOnly}`);
  chk(r2.status === 200 && coreCreates === c0, `the player path still composes and never submits (coreCreates stayed ${coreCreates})`);
}

// =================================================================================================
// 7. REGRESSION — a retry after a 402 mints normally: ONE edition, ONE address.
// =================================================================================================
sec("7. RETRY AFTER 402 — top up and mint: no second edition, no second address");
{
  const w = await mkWallet(1_000_000);            // under the floor
  const b = born_(w);
  const key = `chikimon:drolax`;
  const edStart = edState()[key];
  const editionAtIssue = row_(b.id).edition;

  const r1 = await mintReq(w, b.id);
  console.log(`  broke: status=${r1.status} code=${r1.body.code} payerLamports=${r1.body.payerLamports}; editionCounter=${edState()[key]}`);
  chk(r1.status === 402, `(setup) refused first (actual ${r1.status})`);

  balances.set(w.wallet, 900_000_000);            // the player tops up
  const r2 = await mintReq(w, b.id);
  const addr2 = r2.body.tokenMint, ed2 = r2.body.edition;
  console.log(`  topped up: status=${r2.status} tx=${r2.body.tx} addr=${short(addr2)} edition=${ed2} payerLamports=${r2.body.payerLamports}; editionCounter=${edState()[key]}`);
  chk(r2.status === 200 && !!r2.body.tx, `the retry mints normally (status ${r2.status}, tx="${r2.body.tx}")`);
  chk(r2.body.payerLamports === 900_000_000, `and reports the topped-up balance (actual ${r2.body.payerLamports})`);

  const r3 = await mintReq(w, b.id);
  console.log(`  asked again: status=${r3.status} addr=${short(r3.body.tokenMint)} edition=${r3.body.edition}; mint_reserved events=${countEv(b.id, "mint_reserved")}; editionCounter=${edState()[key]}`);
  chk(r3.status === 200 && r3.body.tokenMint === addr2,
    `a third ask returns the SAME address, never a second one (${short(addr2)} vs ${short(r3.body.tokenMint)})`);
  chk(r3.body.edition === ed2, `and the SAME edition (${ed2} vs ${r3.body.edition})`);
  chk(countEv(b.id, "mint_reserved") === 1, `exactly ONE mint_reserved event for the whole episode (actual ${countEv(b.id, "mint_reserved")})`);
  chk(edState()[key] === edStart, `the edition counter advanced ZERO times across refusal+mint+retry — the number was already stamped at issuance (start ${edStart}, now ${edState()[key]}, row edition ${editionAtIssue})`);
  chk(row_(b.id).edition === editionAtIssue, `the row kept its issuance edition (${editionAtIssue} -> ${row_(b.id).edition})`);
  // regEvent spreads `extra` FLAT onto the event ({at, what, addr, edition, via}) — there is no `data`
  const keys = new Set((row_(b.id).chain || []).filter(c => c.what === "mint_reserved").map(c => c.addr));
  chk(keys.size === 1 && keys.has(addr2), `one reserved address in the chain log (${[...keys].map(short).join(",")})`);
}

// =================================================================================================
// CHILDREN — the flags that can only be tested in their own process.
// =================================================================================================
async function child(role, env, label) {
  const self = fileURLToPath(import.meta.url);
  const out = await new Promise((resolve) => {
    const ch = spawn(process.execPath, [self], {
      env: Object.assign({}, process.env, env, { COST_ROLE: role }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = ""; ch.stdout.on("data", d => { buf += d; }); ch.stderr.on("data", d => { buf += d; });
    ch.on("close", (code) => resolve({ buf, code }));
  });
  for (const ln of out.buf.split("\n")) if (/ok:|FAIL:|—|status=/.test(ln)) console.log("  child |", ln.replace(/\s+$/, ""));
  const m = out.buf.match(/COST_CHILD_TALLY pass=(\d+) fail=(\d+)/);
  if (!m) { fail++; console.log(`  FAIL: the ${label} child never reported a tally (exit ${out.code}); tail: ${out.buf.slice(-600)}`); return null; }
  console.log(`  ${label} child exit=${out.code}; folding in pass=${m[1]} fail=${m[2]}`);
  pass += Number(m[1]); fail += Number(m[2]);
  return { pass: Number(m[1]), fail: Number(m[2]), buf: out.buf };
}

// COST_NO_CONTROL marks the PRE-FIX control run: it stops here so it cannot spawn its own children
// (that would recurse forever) and so its tally covers exactly the same sections 0-7.
if (process.env.COST_NO_CONTROL) {
  console.log(`\nNFT_COST_DONE pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

sec("8. CHILD — env override NFT_MINT_COST_LAMPORTS=4242424");
await child("envov", { COST_PORT: "39942", COST_RPC_PORT: "59942", NFT_MINT_COST_LAMPORTS: "4242424" }, "envov");

sec("8b. CHILD — a GARBAGE NFT_MINT_COST_LAMPORTS falls back to the shipped default");
await child("envbad", { COST_PORT: "39943", COST_RPC_PORT: "59943", NFT_MINT_COST_LAMPORTS: "not-a-number" }, "envbad");

sec("9. CHILD — NFT_MINT_PAUSED=1: which gate binds first?");
await child("paused", { COST_PORT: "39944", COST_RPC_PORT: "59944", NFT_MINT_PAUSED: "1" }, "paused");

// =================================================================================================
// 10. RED-TEAM CONTROL — the same file against the PRE-FIX server (the deploy mirror).
//     If this does not go red, the assertions above are not bound to the fix.
// =================================================================================================
sec("10. RED-TEAM CONTROL — this same sim against .prefix_cost_snapshot.js (pre-fix)");
{
  const self = fileURLToPath(import.meta.url);
  const out = await new Promise((resolve) => {
    const ch = spawn(process.execPath, [self], {
      env: Object.assign({}, process.env, {
        COST_ROLE: "main", COST_PORT: "39945", COST_RPC_PORT: "59945",
        COST_TARGET: "./.prefix_cost_snapshot.js", COST_NO_CONTROL: "1",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = ""; ch.stdout.on("data", d => { buf += d; }); ch.stderr.on("data", d => { buf += d; });
    ch.on("close", (code) => resolve({ buf, code }));
  });
  const m = out.buf.match(/NFT_COST_DONE pass=(\d+) fail=(\d+)/);
  const pre = m ? { p: Number(m[1]), f: Number(m[2]) } : null;
  const fails = out.buf.split("\n").filter(l => /FAIL:/.test(l));
  console.log(`  pre-fix tally: ${m ? `pass=${pre.p} fail=${pre.f}` : "(no tally line)"} exit=${out.code}`);
  for (const f of fails.slice(0, 12)) console.log("  pre-fix |", f.trim().slice(0, 150));
  if (fails.length > 12) console.log(`  pre-fix | … and ${fails.length - 12} more`);
  chk(!!pre && pre.f > 0, `the pre-fix server FAILS this sim — the assertions are bound to the fix (pre-fix fail=${pre ? pre.f : "n/a"})`);
  const under402 = /an under-funded payer gets HTTP 402 \(actual 200\)/.test(out.buf);
  chk(under402, `pre-fix, an under-funded payer was SERVED a transaction instead of a 402 (matched the verbatim line: ${under402})`);
  const noBal = /reads the payer's balance .*\(actual 0\)/.test(out.buf);
  chk(noBal, `pre-fix, a mint made ZERO getBalance calls — so the fix adds exactly 1 on success (matched: ${noBal})`);
  console.log(`  RPC DELTA: pre-fix 0 getBalance per mint -> now ${SEC4.success} on success, ${SEC4.refusal} on refusal`);
}

console.log(`\nNFT_COST_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
