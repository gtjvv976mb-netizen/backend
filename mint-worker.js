// Chikoria — Meme Dynasty DEVNET mint worker.
// Polls the backend for HATCHED eggs awaiting a mint, mints each as a Metaplex Core NFT
// (in the Meme Dynasty collection) directly into the player's wallet, then marks it minted.
//
// Runs on YOUR machine (needs internet + the mint-authority keypair). NOT in the game/sandbox.
//
//   BACKEND=https://backend-wffd.onrender.com ADMIN_KEY=xxxx node mint-worker.js
//
// First run creates ./mint-authority-devnet.json (airdrops devnet SOL) and ./collection-devnet.json.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createSignerFromKeypair, signerIdentity, generateSigner, publicKey, sol } from "@metaplex-foundation/umi";
import { irysUploader } from "@metaplex-foundation/umi-uploader-irys";
import { create, createCollection, mplCore } from "@metaplex-foundation/mpl-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json")));
// NETWORK=mainnet (real money, permanent storage) or devnet (free, default). Set RPC to a paid endpoint (e.g. Helius) on mainnet.
const NETWORK = String(process.env.NETWORK || CFG.network || "devnet").toLowerCase().includes("main") ? "mainnet" : "devnet";
const IS_MAIN = NETWORK === "mainnet";
const RPC = process.env.RPC || (IS_MAIN ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
const IRYS = process.env.IRYS || (IS_MAIN ? "https://node1.irys.xyz" : "https://devnet.irys.xyz");   // mainnet Irys = permanent Arweave storage
const BACKEND = (process.env.BACKEND || "https://backend-wffd.onrender.com").replace(/\/$/, "");
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const KEYFILE = path.join(__dirname, `mint-authority-${NETWORK}.json`);   // keep mainnet & devnet authorities separate
const COLLFILE = path.join(__dirname, `collection-${NETWORK}.json`);
const ARTCACHE = path.join(__dirname, `art-uris-${NETWORK}.json`);        // devnet/mainnet uploads have different URIs
const POLL_MS = Number(process.env.POLL_MS || 8000);
// 💰 SALES TAX / ROYALTY — enforced on every secondary sale by Tensor / Magic Eden (Metaplex Core Royalties plugin).
const ROYALTY_BP = Number(process.env.MEME_ROYALTY_BP || CFG.royaltyBasisPoints || 2000);   // 2000 bps = 20%
const ROYALTY_WALLET = process.env.MEME_ROYALTY_WALLET || CFG.royaltyWallet || "";           // empty → defaults to the mint authority
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!ADMIN_KEY) { console.error("Set ADMIN_KEY (same as the backend's ADMIN_KEY) so the worker can fetch pending mints."); process.exit(1); }

const charByKey = Object.fromEntries(CFG.characters.map(c => [c.key, c]));
const artUris = fs.existsSync(ARTCACHE) ? JSON.parse(fs.readFileSync(ARTCACHE)) : {};
const saveArt = () => fs.writeFileSync(ARTCACHE, JSON.stringify(artUris, null, 2));

async function setup() {
  const umi = createUmi(RPC).use(mplCore()).use(irysUploader({ address: IRYS }));
  let kp;
  if (fs.existsSync(KEYFILE)) kp = umi.eddsa.createKeypairFromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYFILE))));
  else {
    kp = umi.eddsa.generateKeypair(); fs.writeFileSync(KEYFILE, JSON.stringify(Array.from(kp.secretKey)));
    log("created mint authority", kp.publicKey);
    if (IS_MAIN) log("⚠️  MAINNET: fund this authority with real SOL (~0.5–1) before it can mint →", String(kp.publicKey));
  }
  umi.use(signerIdentity(createSignerFromKeypair(umi, kp)));
  // 20% royalty paid to the treasury (or the authority if none configured) — honored by Tensor / Magic Eden on every resale.
  const royaltyAddr = ROYALTY_WALLET || String(umi.identity.publicKey);
  const royaltyPlugin = { type: "Royalties", basisPoints: ROYALTY_BP, creators: [{ address: publicKey(royaltyAddr), percentage: 100 }], ruleSet: { type: "None" } };
  log(`royalty: ${(ROYALTY_BP / 100).toFixed(1)}% → ${royaltyAddr}`);
  let bal = Number((await umi.rpc.getBalance(umi.identity.publicKey)).basisPoints) / 1e9;
  log(`[${NETWORK}] mint authority`, umi.identity.publicKey, "·", bal.toFixed(3), "SOL");
  if (bal < 0.3) {
    if (IS_MAIN) { console.error(`✖ MAINNET authority underfunded (${bal.toFixed(3)} SOL). Send ~0.5–1 SOL to ${umi.identity.publicKey} and restart. No airdrops on mainnet.`); process.exit(1); }
    log("airdropping devnet SOL…"); for (let i = 0; i < 3; i++) { try { await umi.rpc.airdrop(umi.identity.publicKey, sol(1)); break; } catch (e) { await new Promise(r => setTimeout(r, 2500)); } } await new Promise(r => setTimeout(r, 4000)); }
  // create the collection once (reused for every member)
  let collection;
  if (fs.existsSync(COLLFILE)) { collection = JSON.parse(fs.readFileSync(COLLFILE)).address; log("collection", collection); }
  else {
    const coll = generateSigner(umi);
    // upload the collection cover image so the collection shows a proper avatar on Tensor / Magic Eden
    let collImageUri = "";
    const collImg = path.join(__dirname, CFG.collectionImage || "collection-cover.png");
    if (fs.existsSync(collImg)) {
      const buf = fs.readFileSync(collImg);
      [collImageUri] = await umi.uploader.upload([{ buffer: buf, fileName: "collection.png", displayName: CFG.collectionName, uniqueName: "chikimeme-collection", contentType: "image/png", extension: "png", tags: [{ name: "Content-Type", value: "image/png" }] }]);
      log("uploaded collection image →", collImageUri);
    } else { log("⚠️ no collection-cover.png found — collection will have no image"); }
    const collMeta = { name: CFG.collectionName, symbol: CFG.symbol, description: "The Meme Dynasty generation of Chiki Monsters — hatched from Meme Legendary Eggs. 6 legends, 10 editions each.", image: collImageUri, external_url: CFG.externalUrl, properties: { files: collImageUri ? [{ uri: collImageUri, type: "image/png" }] : [], category: "image" } };
    const uri = await umi.uploader.uploadJson(collMeta);
    await createCollection(umi, { collection: coll, name: CFG.collectionName, uri, plugins: [royaltyPlugin] }).sendAndConfirm(umi);
    collection = coll.publicKey; fs.writeFileSync(COLLFILE, JSON.stringify({ address: collection }, null, 2));
    log("created collection", collection, `· ${(ROYALTY_BP / 100).toFixed(1)}% royalty`);
  }
  return { umi, collection, royaltyPlugin };
}

async function artUriFor(umi, key) {
  if (artUris[key]) return artUris[key];
  const file = path.join(__dirname, CFG.artDir, key + "_art.png");
  const buf = fs.readFileSync(file);
  const up = { buffer: buf, fileName: key + ".png", displayName: charByKey[key].name, uniqueName: "chikimeme-" + key, contentType: "image/png", extension: "png", tags: [{ name: "Content-Type", value: "image/png" }] };
  const [uri] = await umi.uploader.upload([up]);
  artUris[key] = uri; saveArt(); log("uploaded art", key, "→", uri);
  return uri;
}

async function mintOne(ctx, h) {
  const { umi, collection, royaltyPlugin } = ctx;
  const c = charByKey[h.char]; if (!c) throw new Error("unknown char " + h.char);
  const image = await artUriFor(umi, h.char);
  const cap = c.cap || CFG.editionCap;                 // per-character supply
  const rarity = c.rarity || "Meme Legendary";         // Alon = "Founder's Edition"
  const name = `${c.name} #${String(h.edition).padStart(3, "0")}`;
  const metadata = {
    name, symbol: CFG.symbol, description: `${c.name} — "${c.tag}". A Meme Dynasty Chiki (${rarity}), edition ${h.edition}/${cap}.`,
    image, external_url: CFG.externalUrl, seller_fee_basis_points: ROYALTY_BP,
    attributes: [
      { trait_type: "Generation", value: CFG.generation },
      { trait_type: "Character", value: c.name },
      { trait_type: "Edition", value: String(h.edition) },
      { trait_type: "Edition Of", value: String(cap) },
      { trait_type: "Rarity", value: rarity },
    ],
    properties: { files: [{ uri: image, type: "image/png" }], category: "image" },
  };
  const uri = await umi.uploader.uploadJson(metadata);
  const asset = generateSigner(umi);
  await create(umi, {
    asset, name, uri, owner: publicKey(h.wallet), collection: publicKey(collection),
    plugins: [
      { type: "Attributes", attributeList: [
        { key: "generation", value: CFG.generation }, { key: "character", value: c.name },
        { key: "rarity", value: rarity }, { key: "edition", value: String(h.edition) },
        { key: "editionOf", value: String(cap) }, { key: "hatchId", value: String(h.id) },
      ] },
      royaltyPlugin,   // 20% royalty enforced on every resale (Tensor / Magic Eden)
    ],
  }).sendAndConfirm(umi);
  return asset.publicKey;
}

async function api(p, opts) { const r = await fetch(BACKEND + p, opts); if (!r.ok) throw new Error(p + " → " + r.status); return r.json(); }

async function loop(ctx) {
  let pend = [];
  try { const j = await api(`/meme/pending?key=${encodeURIComponent(ADMIN_KEY)}`); pend = j.pending || []; }
  catch (e) { log("poll error", e.message); return; }
  if (!pend.length) return;
  log(`${pend.length} egg(s) to mint…`);
  for (const h of pend) {
    try {
      const addr = await mintOne(ctx, h);
      await api("/meme/minted", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: ADMIN_KEY, hatchId: h.id, mintAddr: addr }) });
      log(`✅ ${charByKey[h.char].name} #${h.edition} → ${h.wallet.slice(0, 6)}…  ${addr}`);
    } catch (e) { log("mint failed for", h.id, e.message); }
  }
}

(async () => {
  const ctx = await setup();
  log(`worker ready · ${NETWORK.toUpperCase()} · RPC ${RPC.replace(/\?.*$/, "")} · polling`, BACKEND, "every", POLL_MS / 1000, "s");
  await loop(ctx);
  setInterval(() => loop(ctx).catch(e => log("loop error", e.message)), POLL_MS);
})().catch(e => { console.error("WORKER FAILED:", e); process.exit(1); });
