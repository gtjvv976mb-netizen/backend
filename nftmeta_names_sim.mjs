// 2026-08-15 — NFT NAMES + TRAITS.
// Drives the REAL server's nftAssetName / nftDisplayName / nftRarityTier / nftAttributes across the
// WHOLE roster (41 chikimon + 6 mounts + 10 avatars + 4 egg kinds) and asserts the collection is
// actually browsable: every asset has a readable name, a rarity, a type and a supply, creatures have
// an element, and nothing carries a blank trait.
//
// NEVER touches the live backend: imports the module, calls pure helpers, opens no socket and
// writes nothing. Prints the ACTUAL value in every failure.
// Throwaway keypair, dead RPC, memory store — the standard sim harness. Nothing here can reach the
// live backend, the chain, or a real key.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59422";                   // dead
process.env.ME_API_BASE = "http://127.0.0.1:59423";               // dead
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.TEAM_WALLET = bs58.encode(nacl.sign.keyPair().publicKey);
process.env.ADMIN_KEY = "test-admin-key";
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet";
process.env.PORT = "39824"; process.env.STORE = "memory";
process.env.CHIK_NFT = process.env.CHIK_NFT || "0";
process.env.NODE_ENV = "test";

const SRV = await import("./server.js");
const A = SRV._nftAttributesForTest, N = SRV._nftNamesForTest;

let pass = 0, fail = 0;
const chk = (c, m) => { if (c) { pass++; } else { fail++; console.log(`  FAIL  ${m}`); } };

const LEGEND = ["galador","adalor","tyrannos","grovador","dragonos","astraya","bamboran","borealon",
  "horoxyn","rivaros","solvarex","astragor","crysalune","vesperos"];
const MEME = ["popcat","moodeng","doge","pepe","chillguy","alon","ansem","successkid","chloe",
  "grumpycat","peanut","cryingcat","thisisfine","babygoat","triplet","stonks","nervousmonkey"];
const NORMAL = ["drolax","electrox","firix","forestle","healix","jellox","mushrow","owzard","scorplex","solarix"];
const MOUNTS = ["chicken","boar","gator","horse","wolf","griffin"];
const AVATARS = ["classic","Knight","Mystic","Navigator","Star","chemist","electro","fire","night","sailor"];
const EGGS = ["normal","legendary","meme","mount"];

const row = (o) => Object.assign({ id: "reg_test_1", edition: 3, origin: "hatch",
  born: "2026-08-15T00:00:00.000Z", hatcher: "TESTWALLET", gameStatus: "good" }, o);
const traits = (r) => { const m = {}; for (const a of A(r)) m[a.key] = a.value; return m; };

// ---- 1. THE BUG THE OWNER REPORTED: squashed meme names ----------------------------------------
console.log("== names ==");
const EXPECT = { thisisfine: "This Is Fine Dog", nervousmonkey: "Nervous Monkey", triplet: "Triple T",
  babygoat: "Proud Baby Goat", cryingcat: "Crying Cat", grumpycat: "Grumpy Cat",
  successkid: "Success Kid", moodeng: "Moo Deng", chillguy: "Chill Guy",
  chloe: "Side-eye Chloe", ansem: "Ansem Blackbull" };
for (const [sp, want] of Object.entries(EXPECT)) {
  const got = N(row({ type: "chikimon", sp, kind: "meme" })).display;
  chk(got === want, `${sp}: display name is "${want}", got "${got}"`);
}
// legendaries and normals were ALREADY right — prove the fix did not disturb them
for (const sp of [...LEGEND, ...NORMAL]) {
  const want = sp[0].toUpperCase() + sp.slice(1);
  const got = N(row({ type: "chikimon", sp, kind: sp === "galador" ? "legendary" : "normal" })).display;
  chk(got === want, `${sp}: unchanged capitalised name "${want}", got "${got}"`);
}
// an avatar reads as its TITLE, not its id
chk(N(row({ type: "avatar", sp: "classic" })).display === "The Wanderer",
  `avatar classic reads "The Wanderer", got "${N(row({ type: "avatar", sp: "classic" })).display}"`);
chk(N(row({ type: "egg", sp: "legendary", kind: "legendary" })).name === "Legendary Egg #3",
  `egg name unchanged: got "${N(row({ type: "egg", sp: "legendary", kind: "legendary" })).name}"`);

// ---- 2. every asset is browsable: rarity, type, supply, and element on creatures ----------------
console.log("== traits ==");
const ALL = [
  ...LEGEND.map(sp => [{ type: "chikimon", sp, kind: "legendary" }, "Legendary"]),
  ...MEME.map(sp => [{ type: "chikimon", sp, kind: "meme" }, sp === "alon" ? "Founder's Edition" : "Meme Legendary"]),
  ...NORMAL.map(sp => [{ type: "chikimon", sp, kind: "normal" }, "Normal"]),
  ...MOUNTS.map(sp => [{ type: "mount", sp, kind: "mount" }, null]),
  ...AVATARS.map(sp => [{ type: "avatar", sp, kind: "avatar" }, null]),
  ...EGGS.map(k => [{ type: "egg", sp: k, kind: k }, `${k[0].toUpperCase() + k.slice(1)} Egg`]),
];
for (const [r0, wantRarity] of ALL) {
  const r = row(r0), t = traits(r);
  chk(!!t.name, `${r.type}/${r.sp}: has a name trait (got ${JSON.stringify(t.name)})`);
  chk(!!t.assetType, `${r.type}/${r.sp}: has assetType (got ${JSON.stringify(t.assetType)})`);
  chk(!!t.rarity, `${r.type}/${r.sp}: has a rarity (got ${JSON.stringify(t.rarity)})`);
  chk(!!t.supply, `${r.type}/${r.sp}: has a supply (got ${JSON.stringify(t.supply)})`);
  if (wantRarity) chk(t.rarity === wantRarity, `${r.sp}: rarity is "${wantRarity}", got "${t.rarity}"`);
  if (r.type === "chikimon") {
    chk(!!t.element, `${r.sp}: creature carries an element (got ${JSON.stringify(t.element)})`);
    chk(["Fire","Water","Beast","Storm","Light"].includes(t.element), `${r.sp}: element is a real one, got "${t.element}"`);
  } else {
    chk(t.element === undefined, `${r.type}/${r.sp}: NON-creature invents no element (got ${JSON.stringify(t.element)})`);
  }
  for (const [k, v] of Object.entries(t)) chk(typeof v === "string", `${r.sp}: trait ${k} is a string`);
}

// ---- 3. the provenance half is untouched — old keys still present and unmoved -------------------
console.log("== provenance keys preserved ==");
const t0 = traits(row({ type: "chikimon", sp: "doge", kind: "meme" }));
for (const k of ["registryId","species","kind","origin","edition","born","hatcher"])
  chk(Object.hasOwn(t0, k), `legacy key "${k}" still emitted`);
chk(t0.species === "doge", `species stays the raw ID for machines (got "${t0.species}")`);
chk(A(row({ type: "chikimon", sp: "doge", kind: "meme" }))[0].key === "registryId",
  `registryId is still the FIRST attribute (order preserved for already-minted assets)`);

// ---- 4. supply states the LAW, never the minted count -------------------------------------------
console.log("== supply ==");
chk(traits(row({ type: "chikimon", sp: "doge", kind: "meme" })).supply === "15", `doge supply 15`);
chk(traits(row({ type: "chikimon", sp: "alon", kind: "meme" })).supply === "10", `alon supply 10`);
chk(traits(row({ type: "mount", sp: "griffin", kind: "mount" })).supply === "5", `griffin supply 5`);
chk(traits(row({ type: "chikimon", sp: "galador", kind: "legendary" })).supply === "Open",
  `an uncapped legendary says "Open", not a fake cap`);
chk(N(row({ type: "mount", sp: "griffin", kind: "mount" })).rarity === "Immortal",
  `griffin (cap 5) is Immortal, got "${N(row({ type: "mount", sp: "griffin", kind: "mount" })).rarity}"`);

console.log(`\nNFTMETA_NAMES_SIM  pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
