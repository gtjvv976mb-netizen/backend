import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL="http://127.0.0.1:59999"; process.env.TREASURY_SECRET=JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS="false"; process.env.NETWORK="devnet"; process.env.PORT="39301";
process.env.ADMIN_KEY="test-admin-key"; delete process.env.DATABASE_URL;
const B=`http://127.0.0.1:${process.env.PORT}`;
const post=async(p,b)=>{const r=await fetch(B+p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});return{status:r.status,body:await r.json()};};
await import("./server.js"); await new Promise(r=>setTimeout(r,1400));
let pass=0,fail=0; const chk=(c,m)=>{c?(pass++,console.log("  ok:",m)):(fail++,console.log("  FAIL:",m));};
const kp=nacl.sign.keyPair(), W=bs58.encode(kp.publicKey);
const authMsg=`Chikoria sign-in\nwallet:${W}\nts:${Date.now()}`;
const authSig=Buffer.from(nacl.sign.detached(Buffer.from(authMsg,"utf8"),kp.secretKey)).toString("base64");
const sid="n"+Date.now();
const v=await post("/verify",{wallet:W,netId:sid,authMsg,authSig});
const tok=v.body.mktToken;
const aid="A"+Date.now();
// post an auction for a level 7 firix
const up=await post("/market/op",{sid,op:"auction_post",wallet:W,mktToken:tok,
  listing:{id:aid,species:"firix",lvl:7,xp:40,minBid:100,seller:"S"}});
chk(up.status===200, `auction posted (${up.status})`);
// cancel it — the server must NAME the creature coming back
const c=await post("/market/op",{sid,op:"auction_cancel",wallet:W,mktToken:tok,listing:{id:aid}});
chk(c.body.cancelled===true, `cancel accepted (cancelled=${c.body.cancelled})`);
chk(!!c.body.returned, `the response CARRIES the server's record (${JSON.stringify(c.body.returned)})`);
chk(c.body.returned && c.body.returned.species==="firix", `species is the server's: ${c.body.returned?.species}`);
chk(c.body.returned && c.body.returned.lvl===7, `LEVEL is the server's 7, not a forged 50 (${c.body.returned?.lvl})`);
chk(c.body.returned && c.body.returned.xp===40, `xp is the server's (${c.body.returned?.xp})`);
console.log(`\nAUC_AUTH pass=${pass} fail=${fail}`);
process.exit(fail?1:0);
