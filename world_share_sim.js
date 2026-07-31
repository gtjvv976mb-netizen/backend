// ONE WORLD checks: (1) the peer cap picks the NEAREST trainers, not the oldest sessions;
// (2) a tree's loads live on the server, so two players share one trunk instead of each getting
// a private forest. Throwaway wallets, memory store, dummy RPC — never touches the live backend.
import nacl from "tweetnacl";
import bs58 from "bs58";

const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = "39133";
delete process.env.DATABASE_URL;

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const chk = (c, w) => { if (c) { pass++; console.log("  ok:", w); } else { fail++; console.log("  FAIL:", w); } };
const wallet = () => bs58.encode(nacl.sign.keyPair().publicKey);
const post = async (p, b) => (await fetch(BASE + p, { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).json();
const get = async (p) => (await fetch(BASE + p)).json();
const move = (w, x, z) => post("/world/move", { wallet: w, x, z, dir: 0, handle: "T" });

await import("./server.js");
await new Promise(r => setTimeout(r, 1400));

console.log("— the peer cap keeps the NEAREST trainers, not the oldest sessions —");
{
  // 62 trainers farther out — but INSIDE the interest radius (enter 260; interest_radius_sim owns
  // the outside-the-bubble behaviour) — registered FIRST (so they are oldest in Map insertion order)
  for (let i = 0; i < 62; i++) { const a = i * 0.101; const r = 100 + i * 2; await move(wallet(), r * Math.cos(a), r * Math.sin(a)); }
  // then 3 who walk right up to me — newest, and the ones I must be able to see
  const near = [wallet(), wallet(), wallet()];
  await move(near[0], 5, 0);
  await move(near[1], 0, 6);
  await move(near[2], 7, 7);

  const me = wallet();
  const snap = await move(me, 0, 0);
  const got = new Set((snap.players || []).map(p => p.wallet));
  chk(snap.players.length === 60, `snapshot is capped at 60 (got ${snap.players.length} of 65 in range)`);
  const seen = near.filter(w => got.has(w)).length;
  chk(seen === 3, `all 3 trainers standing next to me are visible (${seen}/3) — insertion order would have dropped every one`);

  // and the cap really is nearest-first: EVERY trainer that got dropped must be further away than
  // every trainer that was kept — assert the property, not a hand-computed number.
  const ds = (snap.players || []).map(p => Math.hypot(p.x, p.z)).sort((a, b) => a - b);
  const keptMax = ds[ds.length - 1];
  const allD = [...near.map((_, i) => Math.hypot([5, 0, 7][i], [0, 6, 7][i])),
                ...Array.from({ length: 62 }, (_, i) => 100 + i * 2)].sort((a, b) => a - b);
  const droppedMin = allD[60];      // the nearest trainer that did NOT make the cut
  chk(ds[0] < 10, `closest returned peer is ${ds[0].toFixed(1)} away`);
  chk(keptMax <= droppedMin,
      `every dropped trainer is further than every kept one (kept max ${keptMax.toFixed(0)} <= dropped min ${droppedMin.toFixed(0)})`);
}

console.log("— a tree's loads belong to the world, not to each client —");
{
  const A = wallet(), B = wallet();
  const id = "wood:300:-200";
  await move(A, 300, -200);
  await move(B, 302, -198);

  const c1 = await post("/world/node/claim", { wallet: A, id, cd: 60, uses: 3 });
  chk(c1.ok === true && c1.left === 2 && c1.felled === false, `A chops once -> 2 loads left (got ${c1.left})`);

  // B is a different trainer at the same trunk: he must inherit the remaining count, not a fresh 3
  const c2 = await post("/world/node/claim", { wallet: B, id, cd: 60, uses: 3 });
  chk(c2.ok === true && c2.left === 1 && c2.felled === false, `B chops the SAME trunk -> 1 load left, not a private 3 (got ${c2.left})`);

  const mid = await get("/world/nodes");
  chk(mid.uses && mid.uses[id] === 1, `the world reports the trunk part-worked (uses=${mid.uses && mid.uses[id]}), so a third client sees it too`);
  chk(!mid.nodes[id], "and it is NOT yet marked spent — it is still standing");

  await new Promise(r => setTimeout(r, 1900));   // respect the per-wallet claim floor
  const c3 = await post("/world/node/claim", { wallet: A, id, cd: 60, uses: 3 });
  chk(c3.ok === true && c3.left === 0 && c3.felled === true, "the third chop FELLS it (felled=true)");

  const after = await get("/world/nodes");
  chk(after.nodes[id] > 0, `the felled trunk is now spent world-wide for ${Math.round(after.nodes[id] / 1000)}s — it falls for everyone`);
  chk(!after.uses || after.uses[id] === undefined, "and its load counter is cleared");

  await new Promise(r => setTimeout(r, 1900));
  const c4 = await post("/world/node/claim", { wallet: B, id, cd: 60, uses: 3 });
  chk(c4.ok === false && c4.taken === true, "nobody can chop a trunk that has already fallen");
}

console.log("— single-load nodes are completely unchanged —");
{
  const C = wallet();
  const id = "stone:400:400";
  await move(C, 400, 400);
  const r1 = await post("/world/node/claim", { wallet: C, id, cd: 60 });
  chk(r1.ok === true && r1.taken === false && r1.left === undefined, "a rock claims in one hit, with no load counter");
  const D = wallet();
  await move(D, 401, 401);
  const r2 = await post("/world/node/claim", { wallet: D, id, cd: 60 });
  chk(r2.ok === false && r2.taken === true, "and is then gone for everyone else");
}

console.log("— the multi-load path keeps every existing guard —");
{
  const E = wallet();
  await move(E, 0, 0);
  // 300,-500 is a real place on the island; 900,-900 is open ocean and is now refused earlier, by the
  // island-extent bound added 2026-07-31 ("no such node"), so the REACH gate is tested where a node
  // could actually stand.
  const far = await post("/world/node/claim", { wallet: E, id: "wood:300:-500", cd: 60, uses: 3 });
  chk(far.ok === false && far.error === "out of reach", `a trunk across the island is still out of reach (${far.error})`);
  const ocean = await post("/world/node/claim", { wallet: E, id: "wood:900:-900", cd: 60, uses: 3 });
  chk(ocean.ok === false && ocean.error === "no such node", `and a trunk in the open sea is not a node at all (${ocean.error})`);
  const ghost = await post("/world/node/claim", { wallet: wallet(), id: "wood:0:0", cd: 60, uses: 3 });
  chk(ghost.ok === false, "a client with no presence is still refused");
  const bad = await post("/world/node/claim", { wallet: E, id: "../../etc/passwd", cd: 60, uses: 3 });
  chk(bad.ok !== true, "a hostile id is still refused, not fatal");
  await new Promise(r => setTimeout(r, 1900));
  const huge = await post("/world/node/claim", { wallet: E, id: "wood:1:1", cd: 60, uses: 9999 });
  chk(huge.ok === true && huge.left <= 16, `an absurd load count is clamped (left=${huge.left})`);
}

console.log("— the egg caravan rides the snapshot: full row, delta reuse, change re-sends —");
{
  // far corner of the island so the 65-trainer crowd from block 1 is outside WORLD_RADIUS here
  const P = wallet(), O = wallet();
  const movE = (w, eggs, dl) => post("/world/move", { wallet: w, x: 3000 + (w === O ? 4 : 0), z: 3000, dir: 0, handle: "T", eggs, dl });

  // NOTE the server order is CAP-then-WHITELIST (slice(0,4) first): a junk kind inside the first
  // four costs its slot. The real client only ever sends real kinds (Profile holds one egg per
  // kind), so this only shapes hostile input — assert what actually ships.
  await movE(P, "normal,dragon,mount,meme,legendary");   // 5 kinds incl. a fake one
  const s1 = await movE(O, "", 1);
  const r1 = (s1.players || []).find(p => p.wallet === P);
  chk(!!r1 && r1.eggs === "normal,mount,meme",
      `observer's FIRST row carries the caravan, capped-then-whitelisted (eggs="${r1 && r1.eggs}" — "dragon" dropped, 5th kind lost to the cap)`);
  chk(Number.isFinite(r1 && r1.sq), `and it is a FULL row with a static seq (sq=${r1 && r1.sq})`);

  // steady state: dl:1 omits the static half — eggs rides `known` on the client, not the wire
  await movE(P, "normal,mount,meme");                    // exactly what the server stored: unchanged
  const s2 = await movE(O, "", 1);
  const r2 = (s2.players || []).find(p => p.wallet === P);
  chk(!!r2 && r2.dl === 1 && r2.eggs === undefined,
      `unchanged caravan is omitted from the delta row (dl=${r2 && r2.dl}, eggs=${r2 && r2.eggs}) — receiver merges from known`);

  // the peer HATCHES/starts an egg -> eggs string changes -> sq bumps -> full row again
  await movE(P, "legendary");
  const s3 = await movE(O, "", 1);
  const r3 = (s3.players || []).find(p => p.wallet === P);
  chk(!!r3 && r3.eggs === "legendary" && Number(r3.sq) === Number(r1.sq) + 1,
      `a CHANGED caravan re-ships the full row (eggs="${r3 && r3.eggs}", sq ${r1 && r1.sq}->${r3 && r3.sq})`);

  // and towing nothing is itself a change: the empty string must arrive (client frees the carts)
  await movE(P, "");
  const s4 = await movE(O, "", 1);
  const r4 = (s4.players || []).find(p => p.wallet === P);
  chk(!!r4 && r4.eggs === "" && Number(r4.sq) === Number(r3.sq) + 1,
      `an EMPTIED caravan ships eggs="" on a fresh full row (sq ${r3 && r3.sq}->${r4 && r4.sq})`);
}

console.log(`WORLDSHARE_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
