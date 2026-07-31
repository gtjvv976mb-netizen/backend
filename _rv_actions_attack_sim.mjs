// _rv_actions_attack_sim.mjs — ADVERSARIAL re-verification of STAGE 3 (CHIK_ACTIONS).
// Phase A attacks the flag ON: out of reach, mid-teleport, a FORGED tool, racing one node, replay,
// claiming for another wallet, and the new water bound as a CPU amplifier.
// Phase B is the honest side, and it is the half that decides the recommendation: a normal gathering
// session, a full fishing session and a mob fight are driven end to end with the flag ON, and every
// refusal of an honest action is counted and named.
// Phase C is an EXHAUSTIVE island sweep of the water bound: every stance from which an honest angler
// could reach a school (water within FISH_SPOT_RANGE 24) must pass waterNear.
// Boots the real server in-process: throwaway keypair, memory store, dead RPC, unique port.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();                                    // THROWAWAY, never a real key
process.env.RPC_URL = "http://127.0.0.1:59999";                    // dummy, never called
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet";
process.env.PORT = "44411"; process.env.ADMIN_KEY = "local-sim-admin";
process.env.CHIK_ACTIONS = "1";                                    // <— the flag under attack
delete process.env.DATABASE_URL; delete process.env.CHIK_PHYS;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); let j = null; try { j = JSON.parse(await r.text()); } catch (e) {} return { status: r.status, body: j }; };
const get = async (p) => { const r = await fetch(B + p); let j = null; try { j = JSON.parse(await r.text()); } catch (e) {} return { status: r.status, body: j }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SRV = await import("/Users/michaelkennethbrillantes/Downloads/chiki-backend/server.js");
await sleep(1500);
const T = await import("/Users/michaelkennethbrillantes/Downloads/chiki-backend/world_terrain.js");

let pass = 0, fail = 0; const findings = [];
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const note = (m) => { findings.push(m); console.log("  FINDING:", m); };
const sec = (s) => console.log(`\n== ${s} ==`);
let _n = 0;
async function mkWallet() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const netId = "n" + Date.now() + "_" + (++_n);
  const v = await post("/verify", { wallet, netId, authMsg, authSig });
  return { wallet, netId, mktToken: v.body.mktToken };
}
const nid = () => `godot-rv${String(_n++).padStart(6, "0")}`;
const move = (w, x, z, extra = {}) => post("/world/move", { wallet: w.wallet ?? w, mktToken: w.mktToken, x, z, dir: 0, ...extra });
const claim = (w, id, extra = {}) => post("/world/node/claim", { wallet: w.wallet ?? w, mktToken: w.mktToken, id, cd: 60, ...extra });

// a standable stone stance and its node, taken from the server's own heightfield ring
const NODE_X = 120, NODE_Z = -260, NODE = `stone:${NODE_X}:${NODE_Z}`;

// ============================================================= A. THE FLAG ON, ATTACKED
sec("A1. claim from out of reach — where exactly is the edge?");
{
  const W = nid(); await move(W, NODE_X + 13.9, NODE_Z);      // just INSIDE CLAIM_RADIUS 14
  let r = await claim(W, NODE);
  chk(r.status === 200 && r.body.ok === true, `13.9 u from the rock: granted (status=${r.status} drop=${JSON.stringify(r.body.drop)})`);
  const W2 = nid(); await move(W2, NODE_X + 14.6, NODE_Z);    // just OUTSIDE CLAIM_RADIUS 14
  r = await claim(W2, NODE);
  chk(r.status === 403 && r.body.error === "out of reach", `14.6 u from a fresh rock: refused (status=${r.status} error="${r.body.error}" dist=${r.body.dist})`);
  const W3 = nid(); await move(W3, 0, 0);
  r = await claim(W3, NODE);
  chk(r.status === 403 && r.body.error === "out of reach", `island-wide claim from (0,0): refused at dist=${r.body.dist}`);
  // a claim with NO presence at all
  r = await claim(nid(), NODE);
  chk(r.status === 403 && r.body.error === "no live presence", `no presence at all: refused (status=${r.status} error="${r.body.error}")`);
  // malformed / off-island ids
  for (const bad of ["stone:abc:-260", "../../etc/passwd", "stone:9000:-260", "unicorn:120:-260", ""]) {
    const wb = nid(); await move(wb, NODE_X, NODE_Z);        // a LIVE presence, so only the id is on trial
    const rr = await claim(wb, bad);
    chk(rr.status === 400, `malformed id ${JSON.stringify(bad)} -> ${rr.status} "${rr.body && rr.body.error}"`);
  }
}

sec("A2. claim mid-teleport");
{
  const W = nid();
  await move(W, NODE_X, NODE_Z);
  await move(W, NODE_X + 900, NODE_Z + 900);          // the warp
  await move(W, NODE_X + 1, NODE_Z + 1);              // ...and back onto the rock
  let r = await claim(W, `stone:${NODE_X + 4}:${NODE_Z + 4}`);
  chk(r.status === 403 && r.body.error === "catch your breath", `claim during the hold refused (status=${r.status} retryInMs=${r.body.retryInMs})`);
  await sleep(3100);
  await move(W, NODE_X + 1, NODE_Z + 1);
  r = await claim(W, `stone:${NODE_X + 4}:${NODE_Z + 4}`);
  chk(r.status === 200 && r.body.ok === true, `the SAME claim lands after the hold — the refusal consumed nothing (drop=${JSON.stringify(r.body.drop)})`);
}

sec("A3. FORGED TOOL — what does the tool gate actually bind?");
{
  const W = nid(); await move(W, NODE_X, NODE_Z);
  let r = await claim(W, `stone:${NODE_X + 6}:${NODE_Z}`, { tool: "axe" });
  chk(r.status === 403 && r.body.error === "wrong tool", `an axe on a rock: refused (needs="${r.body.needs}")`);
  // ...but the SAME claim with the field simply OMITTED is granted, immediately.
  r = await claim(W, `stone:${NODE_X + 6}:${NODE_Z}`);
  chk(r.status === 200 && r.body.ok === true, `the identical claim with NO tool field: GRANTED (drop=${JSON.stringify(r.body.drop)})`);
  note("THE TOOL GATE HAS NO ADVERSARIAL VALUE AS WRITTEN. `if (_tool && _tool !== _needs)` — an empty or absent field always passes, and it must (every shipped client sends none). So a cheater deletes one key; the gate only ever catches an HONEST client that names the wrong implement. It is a consistency check for a future client, not an authorisation.");
  // and it binds KIND only, never tier or ownership
  await sleep(1900);
  const W2 = nid(); await move(W2, NODE_X, NODE_Z);
  r = await claim(W2, `stone:${NODE_X + 8}:${NODE_Z + 2}`, { tool: "pickaxe", toolLvl: 10, gear: { pickaxe: 10 } });
  chk(r.status === 200 && r.body.ok === true, `a wallet that has never crafted anything claims tool:"pickaxe" toolLvl:10 and is GRANTED (drop=${JSON.stringify(r.body.drop)})`);
  note("TOOL TIER IS NOT BOUND AT ALL: NODE_TOOL maps kind -> implement NAME. Nothing reads a level, and nothing checks the wallet OWNS that implement (gear lives in the client-authored save). A forged tool TIER is therefore indistinguishable from an honest one — the gate never claimed otherwise, but the flag's name invites the assumption.");
}

sec("A4. racing two claims on one node — exactly one item");
{
  const racers = Array.from({ length: 8 }, () => nid());
  for (const w of racers) await move(w, 200, -300);
  const rs = await Promise.all(racers.map((w) => claim(w, "crystal:200:-300")));
  const wins = rs.filter((r) => r.status === 200 && r.body.ok === true);
  const taken = rs.filter((r) => r.body && r.body.taken === true);
  const items = wins.reduce((n, r) => n + (r.body.drop ? r.body.drop.length : 0), 0);
  chk(wins.length === 1 && taken.length === 7 && items === 1,
    `8-way race on one crystal: wins=${wins.length} taken=${taken.length} TOTAL items dropped=${items} (drop=${JSON.stringify(wins[0] && wins[0].body.drop)})`);
  // the multi-load tree: each claim spends exactly ONE load and yields exactly ONE item
  const treeRacers = Array.from({ length: 8 }, () => nid());
  for (const w of treeRacers) await move(w, 210, -300);
  const ts = await Promise.all(treeRacers.map((w) => claim(w, "wood:210:-300")));
  const gotWood = ts.filter((r) => r.status === 200 && r.body.ok === true);
  const woodItems = gotWood.reduce((n, r) => n + (r.body.drop ? r.body.drop.length : 0), 0);
  chk(gotWood.length === 3 && woodItems === 3,
    `8-way race on a 3-load TREE: ${gotWood.length} claims granted, ${woodItems} items total — one per claim, never a bonus (lefts=${JSON.stringify(gotWood.map((r) => r.body.left))})`);
}

sec("A5. replaying a claim");
{
  const W = nid(); await move(W, 220, -300);
  const first = await claim(W, "iron:220:-300");
  await sleep(1900); await move(W, 220, -300);
  const second = await claim(W, "iron:220:-300");
  chk(first.body.ok === true && second.body.taken === true && second.body.drop === undefined,
    `replay pays nothing: first drop=${JSON.stringify(first.body.drop)} replay taken=${second.body.taken} drop=${JSON.stringify(second.body.drop)}`);
  // non-canonical spellings of the same rock must not each get their own cooldown
  await sleep(1900); await move(W, 220, -300);
  const alias = await claim(W, "iron:0220:-0300");
  chk(alias.body.taken === true, `a non-canonical spelling of the SAME rock is still taken (body=${JSON.stringify(alias.body)})`);
  await sleep(1900); await move(W, 220, -300);
  const dotted = await claim(W, "iron:220:-300.0");
  chk(dotted.status === 400, `nodeId STRIPS the dot, so "iron:220:-300.0" becomes z=-3000 and falls off the island: ${dotted.status} "${dotted.body && dotted.body.error}" (a decimal id is refused, never re-keyed)`);
}

sec("A6. claiming for another wallet");
{
  const victim = await mkWallet();
  await move(victim, 240, -300);
  // an attacker who read the victim's wallet off /world/roster, with NO token
  const a1 = await post("/world/node/claim", { wallet: victim.wallet, id: "gold:240:-300", cd: 60 });
  chk(a1.status === 200 && a1.body.ok === true,
    `a tokenless stranger claims IN THE VICTIM'S NAME and is granted (status=${a1.status} drop=${JSON.stringify(a1.body.drop)})`);
  const v1 = await claim(victim, "gold:242:-300");
  chk(v1.status === 429, `...and the victim's very next honest claim is refused ${v1.status} "${v1.body && v1.body.error}" (their 1800 ms window was spent by the attacker)`);
  note("CLAIM-FOR-ANOTHER-WALLET IS STILL OPEN AND CHIK_ACTIONS DOES NOT TOUCH IT (pre-existing, gated behind CHIK_CLAIM_TOKEN which is OFF because Gather.gd sends no token). The attacker gains nothing — recordGather credits the VICTIM — so it is denial-of-gathering, not theft. Measured: attacker 200, victim 429 on the next claim.");
  // the fishing and kill routes DO demand the token for a pubkey wallet
  const f = await post("/world/fish/report", { wallet: victim.wallet, tier: 3, rod: 10 });
  chk(f.status === 403, `/world/fish/report for a wallet you cannot prove: ${f.status} "${f.body && f.body.error}"`);
  const k = await post("/world/kill/report", { wallet: victim.wallet });
  chk(k.status === 403, `/world/kill/report for a wallet you cannot prove: ${k.status} "${k.body && k.body.error}"`);
  const fForged = await post("/world/fish/report", { wallet: victim.wallet, mktToken: "x".repeat(48), tier: 3, rod: 10 });
  chk(fForged.status === 403, `...and a FORGED market token is refused too (${fForged.status})`);
}

sec("A7. the new water bound as a CPU amplifier");
{
  // waterNear samples a 13x13 lattice of surfaceHeight and returns on the FIRST hit — so the most
  // expensive call is a stance with NO water anywhere, which is exactly what an attacker picks.
  // The check runs BEFORE the 800 ms count floor and /world/fish/report has no inbound rate cap.
  let dry = null;
  for (let x = -600; x <= 600 && !dry; x += 8) for (let z = -700; z <= 400 && !dry; z += 8) {
    if (T.surfaceHeight(x, z) > T.SEA + 4) {
      let wet = false;
      for (let dx = -48; dx <= 48 && !wet; dx += 8) for (let dz = -48; dz <= 48 && !wet; dz += 8) if (T.surfaceHeight(x + dx, z + dz) < T.SEA) wet = true;
      if (!wet) dry = { x, z };
    }
  }
  chk(!!dry, `found a bone-dry inland stance for the worst case (${dry ? `${dry.x},${dry.z}` : "none"})`);
  const W = nid(); await move(W, dry.x, dry.z);
  const N = 600;
  let t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) T.surfaceHeight(dry.x, dry.z);
  const perSample = Number(process.hrtime.bigint() - t0) / N;
  t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: 300 }, () => post("/world/fish/report", { wallet: W, tier: 3, rod: 10 })));
  const dtOn = Date.now() - t0;
  const dry403 = rs.filter((r) => r.status === 403 && r.body && r.body.error === "no water here").length;
  chk(dry403 === 300, `300 dry casts all refused "no water here" in ${dtOn} ms (${(dtOn / 300).toFixed(2)} ms/req; one surfaceHeight = ${perSample.toFixed(0)} ns, 169 per refused cast = ${(perSample * 169 / 1e6).toFixed(3)} ms of heightfield work)`);
  const st = SRV._actionsStatsForTest();
  chk(st.castDry >= 300, `counter agrees (castDry=${st.castDry})`);
  note(`WATER BOUND COST, MEASURED: a refused cast costs 169 surfaceHeight lookups = ${(perSample * 169 / 1e6).toFixed(3)} ms, and the check sits BEFORE the 800 ms count floor on a route with no inbound rate cap. 300 concurrent dry casts took ${dtOn} ms wall clock. It is a real amplifier but a small one (${(perSample * 169 / 1e6 * 1000).toFixed(1)} ms per 1000 requests); JSON parsing of the same request costs the same order. Stated, not fixed.`);
}

// ============================================================= B. THE HONEST SIDE
sec("B. HONEST PLAY WITH THE FLAG ON — every refusal is counted");
let honestRefusals = 0; const honestLog = [];
const honest = (r, what) => { const bad = !(r.status === 200 && r.body && r.body.ok !== false); if (bad && !(r.body && r.body.taken)) { honestRefusals++; honestLog.push(`${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 90)}`); } return r; };
{
  // ---- B1: a normal gathering session. A trainer walks the ring and gathers 20 nodes at the
  //          client's own 2 s cadence, sending the tool field an honest client WOULD send.
  const KIND_TOOL = { wood: "axe", stone: "pickaxe", iron: "pickaxe", gold: "pickaxe", crystal: "drill", seashell: "shovel", berries: "", honey: "", flower: "" };
  const kinds = Object.keys(KIND_TOOL);
  const G = await mkWallet();
  let gx = 260, gz = -300, gathered = 0;
  for (let i = 0; i < 20; i++) {
    const k = kinds[i % kinds.length];
    gx += 6; gz += (i % 2 ? 4 : -4);                       // 7.2 u/s — a walking trainer
    await move(G, gx, gz);
    const r = honest(await claim(G, `${k}:${Math.round(gx)}:${Math.round(gz)}`, { tool: KIND_TOOL[k] }), `gather ${k}`);
    if (r.status === 200 && r.body.ok) gathered++;
    await sleep(1900);
  }
  chk(gathered === 20, `20-node gathering session with an honest tool field: ${gathered}/20 granted`);

  // ---- B2: a full fishing session. Cast from a real shore stance at the real client cadence.
  let shore = null;
  for (let x = -700; x <= 700 && !shore; x += 8) for (let z = -900; z <= 480 && !shore; z += 8) {
    const h = T.surfaceHeight(x, z);
    if (h < T.SEA + 0.5 || h > T.SEA + 40) continue;
    let near = false;
    for (let dx = -24; dx <= 24 && !near; dx += 4) for (let dz = -24; dz <= 24 && !near; dz += 4) if (T.surfaceHeight(x + dx, z + dz) < T.SEA) near = true;
    if (near) shore = { x, z };
  }
  chk(!!shore, `found a real shore stance from the server's own heightfield (${shore.x},${shore.z}, h=${T.surfaceHeight(shore.x, shore.z).toFixed(2)}, SEA=${T.SEA})`);
  const F = await mkWallet();
  let casts = 0, castRefusals = 0;
  for (let i = 0; i < 14; i++) {
    // an angler drifts a little along the shore between casts
    await move(F, shore.x + (i % 3) - 1, shore.z + (i % 2));
    const r = await post("/world/fish/report", { wallet: F.wallet, mktToken: F.mktToken, tier: 2, rod: 6, lvl: 20 });
    if (r.status === 200 && r.body.counted) casts++; else if (r.status !== 200) { castRefusals++; honestRefusals++; honestLog.push(`cast: ${r.status} ${JSON.stringify(r.body)}`); }
    await sleep(2600);                                     // a real cast+bite+duel is far slower
  }
  chk(casts === 14 && castRefusals === 0, `14-cast fishing session from the shore: counted=${casts}, refusals=${castRefusals}`);

  // ---- B3: a mob fight. Stand on the monster and chip it down, then finish it.
  const spec = SRV._mobSpawnAt(3);
  const M = await mkWallet();
  let strikes = 0, strikeRefusals = 0, killed = false;
  for (let i = 0; i < 12 && !killed; i++) {
    const ip = SRV._mobIdlePos(3, Date.now() / 1000);
    await move(M, ip.x, ip.z);
    const r = await post("/world/mob/hit", { wallet: M.wallet, mktToken: M.mktToken, idx: 3, dmg: 30 });
    if (r.status === 200) { strikes++; if (r.body.killed) killed = true; } else { strikeRefusals++; honestRefusals++; honestLog.push(`strike: ${r.status} ${JSON.stringify(r.body)}`); }
    await sleep(600);
  }
  chk(strikes > 0 && strikeRefusals === 0, `mob fight: ${strikes} strikes accepted, ${strikeRefusals} refused, killed=${killed}`);
}
chk(honestRefusals === 0, `HONEST REFUSALS WITH CHIK_ACTIONS=1: ${honestRefusals}${honestRefusals ? "\n    " + honestLog.join("\n    ") : " — ZERO"}`);

// ============================================================= C. EXHAUSTIVE WATER-BOUND SWEEP
sec("C. can the water bound EVER refuse an honest angler? (whole-island sweep)");
{
  // An honest angler stands within Player.gd FISH_SPOT_RANGE (24) of a school, and Fish.gd places
  // every school where the surface is water. So: for EVERY point on the island with water within
  // 24 units, waterNear (the server's +/-48 lattice at step 8) must answer true.
  const waterNear = (x, z) => {
    for (let dx = -48; dx <= 48; dx += 8) for (let dz = -48; dz <= 48; dz += 8) if (T.surfaceHeight(x + dx, z + dz) < T.SEA) return true;
    return false;
  };
  const nearWater24 = (x, z) => {
    for (let dx = -24; dx <= 24; dx += 2) for (let dz = -24; dz <= 24; dz += 2) if (T.surfaceHeight(x + dx, z + dz) < T.SEA) return true;
    return false;
  };
  let stances = 0, refused = 0; const bad = [];
  for (let x = -760; x <= 760; x += 4) {
    for (let z = -960; z <= 560; z += 4) {
      if (!nearWater24(x, z)) continue;
      stances++;
      if (!waterNear(x, z)) { refused++; if (bad.length < 6) bad.push(`${x},${z}`); }
    }
  }
  chk(refused === 0, `${stances} island stances have water within FISH_SPOT_RANGE 24; waterNear refused ${refused} of them${bad.length ? " (" + bad.join(" ") + ")" : ""}`);
  // ...and the bound really does refuse the middle of the island
  let inlandRefused = 0, inland = 0;
  for (let x = -300; x <= 300; x += 20) for (let z = -500; z <= 100; z += 20) {
    if (T.surfaceHeight(x, z) < T.SEA + 6) continue;
    inland++; if (!waterNear(x, z)) inlandRefused++;
  }
  chk(inlandRefused > 0, `the bound is not vacuous: ${inlandRefused} of ${inland} deep-inland stances are refused`);
}

console.log(`\nRV_ACTIONS_ATTACK_DONE pass=${pass} fail=${fail} honestRefusals=${honestRefusals} findings=${findings.length}`);
findings.forEach((f, i) => console.log(`  F${i + 1}. ${f}`));
process.exit(fail ? 1 : 0);
