// Does the ledger actually give a legitimate record of every egg, chikimon and mount?
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL="http://127.0.0.1:59999"; process.env.TREASURY_SECRET=JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS="false"; process.env.NETWORK="devnet"; process.env.PORT="39281";
process.env.ADMIN_KEY="test-admin-key"; delete process.env.DATABASE_URL;
const B=`http://127.0.0.1:${process.env.PORT}`;
const post=async(p,b)=>(await fetch(B+p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)})).json();
const get=async(p)=>(await fetch(B+p)).json();
await import("./server.js"); await new Promise(r=>setTimeout(r,1400));
let pass=0,fail=0; const chk=(c,m)=>{c?(pass++,console.log("  ok:",m)):(fail++,console.log("  FAIL:",m))};

const kp=nacl.sign.keyPair(), W=bs58.encode(kp.publicKey);
const authMsg=`Chikoria sign-in\nwallet:${W}\nts:${Date.now()}`;
const authSig=Buffer.from(nacl.sign.detached(Buffer.from(authMsg,"utf8"),kp.secretKey)).toString("base64");
const v=await post("/verify",{wallet:W,netId:"n"+Date.now(),authMsg,authSig});
// /profile throttles writes inside 600ms and silently returns {throttled:true} — a real client
// never saves that fast, but this sim does, so wait it out or the ledger never sees the save.
const save=async(mmo)=>{ await new Promise(r=>setTimeout(r,700)); return post("/profile",{wallet:W,authMsg,authSig,profile:{mmo}}); };
const audit=()=>get(`/assets/audit?wallet=${W}&mktToken=${encodeURIComponent(v.mktToken)}`);

console.log("— an existing player's roster is grandfathered, not condemned —");
await save({onboarded:true, units:{u1:{species:"dragonos",kind:"legendary",level:20}}, mounts:["horse"], eggs:[]});
let a=await audit();
chk(a.known===true, "the wallet now has an asset record");
chk(a.units.u1 && a.units.u1.origin==="legacy", `their existing chikimon is 'legacy' (${a.units.u1&&a.units.u1.origin})`);
chk(a.mounts.horse && a.mounts.horse.origin==="legacy", "and their existing mount too");
chk(a.unverified===0, `nothing is condemned on day one (unverified=${a.unverified})`);

console.log("— hatching an egg produces a VOUCHED chikimon —");
await save({onboarded:true, units:{u1:{species:"dragonos",kind:"legendary",level:20}}, mounts:["horse"], eggs:[{kind:"legendary"}]});
await save({onboarded:true, units:{u1:{species:"dragonos",kind:"legendary",level:20}, u2:{species:"galador",kind:"legendary",level:1}}, mounts:["horse"], eggs:[]});
a=await audit();
chk(a.units.u2 && a.units.u2.origin==="hatched", `the new chikimon is recorded as hatched (${a.units.u2&&a.units.u2.origin})`);
chk(a.unverified===0, "and it is not flagged");

console.log("— a chikimon conjured from nothing is flagged forever —");
await save({onboarded:true, units:{u1:{species:"dragonos",kind:"legendary",level:20}, u2:{species:"galador",kind:"legendary",level:1}, uX:{species:"tyrannos",kind:"legendary",level:50}}, mounts:["horse"], eggs:[]});
a=await audit();
chk(a.units.uX && a.units.uX.origin==="unverified", `the conjured legendary is 'unverified' (${a.units.uX&&a.units.uX.origin})`);
chk(a.unverified>=1, `and counted against the wallet (unverified=${a.unverified})`);
chk(a.units.u1.origin==="legacy" && a.units.u2.origin==="hatched", "while the honest ones keep their standing");

console.log("— mounts appearing from nowhere are flagged too —");
await save({onboarded:true, units:{u1:{species:"dragonos",kind:"legendary",level:20}}, mounts:["horse","griffin","wolf"], eggs:[]});
a=await audit();
chk(a.mounts.griffin && a.mounts.griffin.origin==="unverified", "a mount that appeared from nowhere is flagged");

console.log("— the record survives the asset being hidden again —");
await save({onboarded:true, units:{u1:{species:"dragonos",kind:"legendary",level:20}}, mounts:["horse"], eggs:[]});
a=await audit();
chk(!!a.units.uX, "deleting the forged chikimon does NOT erase its record");
chk(a.unverified>=2, `the flags stand (unverified=${a.unverified})`);

console.log("— the record is private, and there is a game-wide view for you —");
const peek=await get(`/assets/audit?wallet=${W}`);
chk(!!peek.error, `a stranger cannot read someone's asset record (${peek.error})`);
const sum=await get(`/assets/summary?key=test-admin-key`);
chk(sum.wallets>=1 && sum.unverified>=2, `admin summary works (wallets=${sum.wallets}, unverified=${sum.unverified}, byOrigin=${JSON.stringify(sum.byOrigin)})`);
const nosum=await get(`/assets/summary`);
chk(!!nosum.error, "and the summary is admin-only");
console.log(`ASSETAUDIT_DONE pass=${pass} fail=${fail}`);
process.exit(fail?1:0);
