// Can a stranger puppeteer your avatar, send whispers as you, or READ your whispers?
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL="http://127.0.0.1:59999"; process.env.TREASURY_SECRET=JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS="false"; process.env.NETWORK="devnet"; process.env.PORT="39251";
delete process.env.DATABASE_URL;
const B=`http://127.0.0.1:${process.env.PORT}`;
const post=async(p,b)=>(await fetch(B+p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)})).json();
const get=async(p)=>(await fetch(B+p)).json();
await import("./server.js"); await new Promise(r=>setTimeout(r,1400));
let pass=0,fail=0; const chk=(c,m)=>{c?(pass++,console.log("  ok:",m)):(fail++,console.log("  FAIL:",m))};
async function proven(){
  const kp=nacl.sign.keyPair(), w=bs58.encode(kp.publicKey), nid="n"+Math.random().toString(36).slice(2);
  const msg=`Chikoria sign-in\nwallet:${w}\nts:${Date.now()}`;
  const sg=Buffer.from(nacl.sign.detached(Buffer.from(msg,"utf8"),kp.secretKey)).toString("base64");
  const v=await post("/verify",{wallet:w,netId:nid,authMsg:msg,authSig:sg});
  return {w,tok:v.mktToken};
}
const V=await proven(), F=await proven();     // victim, friend

console.log("— a PROVEN wallet player works exactly as before —");
const mv=await post("/world/move",{wallet:V.w,mktToken:V.tok,x:5,z:5,dir:0,handle:"Victim"});
chk(!mv.error, `the owner can move (${mv.error||"ok"})`);
await post("/world/move",{wallet:F.w,mktToken:F.tok,x:6,z:6,dir:0,handle:"Friend"});
const dm=await post("/world/dm",{wallet:F.w,mktToken:F.tok,to:V.w,handle:"Friend",text:"meet me at the docks"});
chk(!dm.error, "a friend can whisper them");
const inbox=await get(`/world/dm?wallet=${V.w}&since=0&mktToken=${encodeURIComponent(V.tok)}`);
chk((inbox.messages||[]).length===1, `the owner reads their own inbox (${(inbox.messages||[]).length} msg)`);

console.log("— a stranger knowing only the PUBLIC wallet is refused —");
const pup=await post("/world/move",{wallet:V.w,x:9999,z:9999,dir:0,handle:"Puppet"});
chk(!!pup.error, `cannot puppeteer their avatar (${pup.error})`);
const imp=await post("/world/dm",{wallet:V.w,to:F.w,handle:"Victim",text:"send me your gold"});
chk(!!imp.error, `cannot whisper AS them (${imp.error})`);
const peek=await get(`/world/dm?wallet=${V.w}&since=0`);
chk(!!peek.error && !peek.messages, `cannot READ their whispers (${peek.error})`);
const peek2=await get(`/world/dm?wallet=${V.w}&since=0&mktToken=garbagegarbagegarbage`);
chk(!!peek2.error, "a forged token is refused too");

console.log("— a private net_id player still works with no token —");
const nid="godot-"+Math.random().toString(36).slice(2,10);
const nm=await post("/world/move",{wallet:nid,x:1,z:1,dir:0,handle:"Demo"});
chk(!nm.error, `net_id presence still accepted (${nm.error||"ok"}) — demo players unaffected`);
console.log(`PRESAUTH_DONE pass=${pass} fail=${fail}`); process.exit(fail?1:0);
