// the new caravan + sprint fields must survive the round trip through the real server
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t=nacl.sign.keyPair();
process.env.RPC_URL="http://127.0.0.1:59999"; process.env.TREASURY_SECRET=JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS="false"; process.env.NETWORK="devnet"; process.env.PORT="39311"; delete process.env.DATABASE_URL;
const B=`http://127.0.0.1:${process.env.PORT}`;
const post=async(p,b)=>(await fetch(B+p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)})).json();
await import("./server.js"); await new Promise(r=>setTimeout(r,1400));
let pass=0,fail=0; const chk=(c,m)=>{c?(pass++,console.log("  ok:",m)):(fail++,console.log("  FAIL:",m));};
const A="godot-aaa11122", Bn="godot-bbb22233";
await post("/world/move",{wallet:A,x:5,z:5,dir:0,handle:"A",eggs:"normal,mount",spr:true});
const snap=await post("/world/move",{wallet:Bn,x:6,z:6,dir:0,handle:"B"});
const seen=(snap.players||[]).find(p=>p.wallet===A||p.d===A)||{};
chk(seen.eggs==="normal,mount",`the caravan reaches other players ('${seen.eggs}')`);
chk(seen.spr===true,`the real sprint state reaches them too (${seen.spr})`);
// junk kinds must never reach a model lookup on someone else's client
await post("/world/move",{wallet:A,x:5,z:5,dir:0,handle:"A",eggs:"normal,../../etc,notakind,meme,x,y,z"});
const s2=await post("/world/move",{wallet:Bn,x:6,z:6,dir:0,handle:"B"});
const seen2=(s2.players||[]).find(p=>p.wallet===A||p.d===A)||{};
chk(seen2.eggs==="normal,meme",`junk and traversal kinds are stripped ('${seen2.eggs}')`);
chk(seen2.eggs.split(",").length<=4,"and it is capped at four carts");
await post("/world/move",{wallet:A,x:5,z:5,dir:0,handle:"A"});
const s3=await post("/world/move",{wallet:Bn,x:6,z:6,dir:0,handle:"B"});
const seen3=(s3.players||[]).find(p=>p.wallet===A||p.d===A)||{};
chk(seen3.eggs===""&&seen3.spr===false,`an older client omitting them is fine ('${seen3.eggs}', ${seen3.spr})`);
console.log(`\nWIRE_SIM pass=${pass} fail=${fail}`); process.exit(fail?1:0);
