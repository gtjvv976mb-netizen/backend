// Can a Cup entrant claim a deck they have not unlocked? Real SOL rides on this bracket.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL="http://127.0.0.1:59999"; process.env.TREASURY_SECRET=JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS="false"; process.env.NETWORK="devnet"; process.env.PORT="39263";
process.env.CUP_ADMIN_KEY="testkey"; delete process.env.DATABASE_URL;
const B=`http://127.0.0.1:${process.env.PORT}`;
const post=async(p,b,h={})=>(await fetch(B+p,{method:"POST",headers:{"Content-Type":"application/json",...h},body:JSON.stringify(b)})).json();
const srv=await import("./server.js"); await new Promise(r=>setTimeout(r,1400));
let pass=0,fail=0; const chk=(c,m)=>{c?(pass++,console.log("  ok:",m)):(fail++,console.log("  FAIL:",m))};

// a player whose champion legitimately knows only 3 cards, all tier 1
const kp=nacl.sign.keyPair(), W=bs58.encode(kp.publicKey), nid="n"+Math.random().toString(36).slice(2);
const msg=`Chikoria sign-in\nwallet:${W}\nts:${Date.now()}`;
const sig=Buffer.from(nacl.sign.detached(Buffer.from(msg,"utf8"),kp.secretKey)).toString("base64");
await post("/verify",{wallet:W,netId:nid,authMsg:msg,authSig:sig});
await post("/profile",{wallet:W,netId:nid,authMsg:msg,authSig:sig,profile:{
  handle:"Honest", glory:100000,
  chikis:[{sp:"dragonos", isLegend:true, br:40, arenaSkills:[0,1,2], cardTier:{0:1,1:1,2:1}}]}});

// the greedy registration: every card, all at tier 5
const greedy={element:"Fire", br:999, arenaSkills:[0,1,2,3,4,5,6,7,8,9,10,11],
              cardTier:Object.fromEntries([...Array(12)].map((_,i)=>[i,5]))};
const built=await srv.cupSnapFromBody(W, greedy);
const s=built.snap||{};
console.log("  claimed 12 cards @T5 ->", JSON.stringify({skills:s.arenaSkills, ct:s.cardTier, br:s.br}));
chk(!built.error, "the entry is accepted (an honest player is not locked out)");
chk((s.arenaSkills||[]).every(n=>[0,1,2].includes(n)), `only the 3 cards actually owned are entered (${JSON.stringify(s.arenaSkills)})`);
chk((s.arenaSkills||[]).length===3, "the claimed 12 were cut to 3");
chk(Object.values(s.cardTier||{}).every(v=>v<=1), `tiers cannot exceed what is owned (${JSON.stringify(s.cardTier)})`);
chk((s.br||0)<=40, `br is still clamped to the best legendary (${s.br})`);

// a legitimate subset choice is still respected
const pick=await srv.cupSnapFromBody(W,{element:"Fire",arenaSkills:[2,0],cardTier:{0:1,2:1}});
chk(JSON.stringify((pick.snap.arenaSkills||[]).slice().sort())==="[0,2]", "a player may still CHOOSE among cards they own");
console.log(`CUPDECK_DONE pass=${pass} fail=${fail}`); process.exit(fail?1:0);
