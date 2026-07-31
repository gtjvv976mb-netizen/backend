// Can a stranger forfeit or burn a turn in someone else's duel?
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL="http://127.0.0.1:59999"; process.env.TREASURY_SECRET=JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS="false"; process.env.NETWORK="devnet"; process.env.PORT="39203";
delete process.env.DATABASE_URL;
const BASE=`http://127.0.0.1:${process.env.PORT}`;
let pass=0,fail=0;
const chk=(c,w)=>{ if(c){pass++;console.log("  ok:",w);} else {fail++;console.log("  FAIL:",w);} };
const post=async(p,b)=>(await fetch(BASE+p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)})).json();
const get=async(p)=>(await fetch(BASE+p)).json();
const wallet=()=>bs58.encode(nacl.sign.keyPair().publicKey);
await import("./server.js"); await new Promise(r=>setTimeout(r,1400));

// proven identities: /verify issues a wallet-bound market token, which is what now gates the secret
async function proven() {
  const kp=nacl.sign.keyPair(), w=bs58.encode(kp.publicKey), nid="n"+Math.random().toString(36).slice(2);
  const msg=`Chikoria sign-in\nwallet:${w}\nts:${Date.now()}`;
  const sg=Buffer.from(nacl.sign.detached(Buffer.from(msg,"utf8"),kp.secretKey)).toString("base64");
  const v=await post("/verify",{wallet:w,netId:nid,authMsg:msg,authSig:sg});
  return {w, tok:v.mktToken};
}
const PA=await proven(), PB=await proven();
const A=PA.w, B=PB.w, ATTACKER=wallet();
const snapA={element:"Fire",name:"Alice",br:8,cardTier:1,arenaSkills:[]};
const snapB={element:"Water",name:"Bob",br:8,cardTier:1,arenaSkills:[]};
// PROVE `from` (2026-07-31): /pvp/challenge trusted the caller's `from` outright, so a duel
// could be forged between a stranger and yourself and it occupied their match slot. It is now a
// claimed-slot rule — an id nobody has proven may still challenge, one that IS proven must show
// its /verify token, which the client already holds.
await post("/pvp/challenge",{from:A,fromName:"Alice",to:B,snap:snapA,mktToken:PA.tok});
const inbox=await post("/pvp/available",{wallet:B,name:"Bob",snap:snapB,mktToken:PB.tok});
const ch=(inbox.challenges||[]).find(c=>c.from===A);
const acc=await post("/pvp/challenge/accept",{wallet:B,challengeId:ch&&ch.id,snap:snapB,mktToken:PB.tok});
chk(acc.ok===true&&!!acc.matchId,`a match starts (${acc.matchId})`);
chk(typeof acc.sec==="string"&&acc.sec.length>=16,"the accepter is handed a per-match secret");
const av=await post("/pvp/available",{wallet:A,name:"Alice",snap:snapA,mktToken:PA.tok});
chk(!!(av.matched&&av.matched.sec),"the challenger gets theirs when they discover the match");
chk(av.matched.sec!==acc.sec,"the two sides get DIFFERENT secrets");
const mid=acc.matchId;

console.log("— a stranger CANNOT obtain the victim's secret by asking for it —");
const leak=await post("/pvp/available",{wallet:A,name:"NotAlice",snap:snapA});   // no token
chk(!(leak.matched&&leak.matched.sec), "/pvp/available refuses the secret to an unproven caller");
const leak2=await post("/pvp/challenge/accept",{wallet:A,challengeId:"x",snap:snapA});
chk(!leak2.sec, "/pvp/challenge/accept refuses it too");

console.log("— a stranger who knows the match id AND the victim's public wallet —");
const ff=await post("/pvp/forfeit",{matchId:mid,wallet:B});
chk(!!ff.error,`cannot forfeit it without the secret (${ff.error})`);
const mv=await post("/pvp/move",{matchId:mid,wallet:B,cards:[0]});
chk(!!mv.error,`cannot burn their turn either (${mv.error})`);
const guess=await post("/pvp/forfeit",{matchId:mid,wallet:B,sec:"deadbeefdeadbeefdeadbeef"});
chk(!!guess.error,"a guessed secret is refused");
const st=await get(`/pvp/state?matchId=${mid}&wallet=${B}`);
chk(st.status==="active","the duel is still running — nobody was knocked out of it");

console.log("— the real players are unaffected —");
const real=await post("/pvp/move",{matchId:mid,wallet:B,cards:[0],sec:acc.sec});
chk(!real.error,`the true owner can still play their turn (${real.error||"ok"})`);
const realFF=await post("/pvp/forfeit",{matchId:mid,wallet:A,sec:av.matched.sec});
chk(realFF.ok===true,"and the true owner can still forfeit");
console.log(`PVPAUTH_DONE pass=${pass} fail=${fail}`);
process.exit(fail?1:0);
