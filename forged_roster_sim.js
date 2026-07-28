// Does a FORGED roster survive a cloud-save round-trip? The client's tamper seal is signed with a
// salt that must ship in the client, so a determined player can recover it and sign anything.
// The question this answers is narrower and factual: once such a save is produced, does the SERVER
// accept it, store it and hand it back? Real server, in-process, throwaway keypairs, memory store.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL="http://127.0.0.1:59999"; process.env.TREASURY_SECRET=JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS="false"; process.env.NETWORK="devnet"; process.env.PORT="39277";
delete process.env.DATABASE_URL;
const B=`http://127.0.0.1:${process.env.PORT}`;
const post=async(p,b)=>(await fetch(B+p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)})).json();
const get=async(p)=>(await fetch(B+p)).json();
await import("./server.js"); await new Promise(r=>setTimeout(r,1400));
let pass=0,fail=0; const chk=(c,m)=>{c?(pass++,console.log("  ok:",m)):(fail++,console.log("  FAIL:",m))};

const kp=nacl.sign.keyPair(), W=bs58.encode(kp.publicKey);
const sign=(msg)=>Buffer.from(nacl.sign.detached(Buffer.from(msg,"utf8"),kp.secretKey)).toString("base64");
const authMsg=`Chikoria sign-in\nwallet:${W}\nts:${Date.now()}`, authSig=sign(authMsg);
await post("/verify",{wallet:W,netId:"n"+Date.now(),authMsg,authSig});

console.log("— a roster the player could never have earned —");
const forged = {
  onboarded:true, level:50, chiki:0,
  units:{}, party:[], bench:[], owned:[],
  eggs:[{kind:"legendary",tended:9,fed_at:1}],
  mounts:["griffin","wolf","gator","horse","boar","chicken"],
  avatars:["classic","Knight","Mystic","Navigator","Star"],
  _sig:"forged-but-well-formed", _sigv:13,
};
for (let i=0;i<12;i++) forged.units["u"+i]={uid:"u"+i,species:"dragonos",kind:"legendary",level:50,xp:0};
const save=await post("/profile",{wallet:W,authMsg,authSig,profile:{mmo:forged}});
chk(!save.error, `the server ACCEPTED the forged cloud-save (${save.error||"no error"})`);

const back=await get(`/profile?wallet=${W}&authMsg=${encodeURIComponent(authMsg)}&authSig=${encodeURIComponent(authSig)}`);
const mmo=(back&&back.profile&&back.profile.mmo)||null;
chk(!!mmo, "and hands it straight back");
if (mmo) {
  chk(Object.keys(mmo.units||{}).length===12, `all 12 fabricated legendaries survived (${Object.keys(mmo.units||{}).length})`);
  chk((mmo.mounts||[]).length===6, `all 6 mounts survived (${(mmo.mounts||[]).length})`);
  chk((mmo.eggs||[]).length===1, "the conjured egg survived");
  chk(mmo._sig==="forged-but-well-formed", `the nonsense signature was stored VERBATIM (${mmo._sig})`);
}

console.log("— so: does the server know what this wallet SHOULD own? —");
const stats=await get("/stats");
chk(!("rosterOf" in stats), "there is no server-side ownership record to check against");
console.log(`FORGED_DONE pass=${pass} fail=${fail}`);
process.exit(0);
