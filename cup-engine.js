// Chikoria Cup — Phase 1 bracket engine.
// Seeds 16 players, runs a full DOUBLE-ELIMINATION bracket through the deterministic resolver,
// drops losers correctly, and returns the champion + final placements + per-player SOL payouts.
//
// runCup(players, seedBase) -> { champion, results:[{name, place, sol}], log:[...] , totalPaid }
//   players: 16 snapshots { name, element, br, arenaSkills:[...], cardTier:{} }

import { resolveBattle } from "./cup-resolver.js";

// Standard 16-seed bracket order (so seeds #1 and #2 can only meet in the Grand Final).
const SEED16 = [1,16,8,9,5,12,4,13,3,14,6,11,7,10,2,15];

// Payout by finishing place — Champion 1 SOL + scaled consolation for everyone else (4 SOL total).
function cupPayout(place){
  if(place===1) return 1.00;     // 🏆 champion
  if(place===2) return 0.60;     // grand finalist
  if(place===3) return 0.42;
  if(place===4) return 0.32;
  if(place<=6) return 0.24;      // 5–6th
  if(place<=8) return 0.18;      // 7–8th
  if(place<=12) return 0.13;     // 9–12th
  return 0.075;                  // 13–16th (totals exactly 4.00 SOL)
}

function runCup(players, seedBase="cup"){
  if(!Array.isArray(players) || players.length!==16) throw new Error("runCup needs exactly 16 players");
  const seeded = players.slice().sort((a,b)=>(b.br||1)-(a.br||1));   // seed by Battle Rank, #1 = highest
  const slot = SEED16.map(s=>seeded[s-1]);                            // bracket positions

  const log=[]; let mid=0;
  const place={};
  // resolve a match -> [winner, loser]
  const M=(a,b,tag)=>{
    const r=resolveBattle(a,b,seedBase+"|"+tag+"|"+(mid++));
    const w=r.winner==="a"?a:b, l=r.winner==="a"?b:a;
    log.push({tag, a:a.name, b:b.name, winner:w.name, rounds:r.rounds});
    return [w,l];
  };

  // ---- Winners bracket ----
  const wb1w=[], wb1l=[];
  for(let i=0;i<16;i+=2){ const [w,l]=M(slot[i],slot[i+1],"WB1"); wb1w.push(w); wb1l.push(l); }
  const wb2w=[], wb2l=[];
  for(let i=0;i<8;i+=2){ const [w,l]=M(wb1w[i],wb1w[i+1],"WB2"); wb2w.push(w); wb2l.push(l); }
  const wb3w=[], wb3l=[];
  for(let i=0;i<4;i+=2){ const [w,l]=M(wb2w[i],wb2w[i+1],"WB3"); wb3w.push(w); wb3l.push(l); }
  const [wbChamp, wfLoser]=M(wb3w[0],wb3w[1],"WF");

  // ---- Losers bracket (minor/major alternation) ----
  const lb1=[];                                   // LB R1: 8 WB1-losers -> 4 (losers place 13–16)
  for(let i=0;i<8;i+=2){ const [w,l]=M(wb1l[i],wb1l[i+1],"LB1"); lb1.push(w); place[l.name]=13; }
  const lb2=[];                                   // LB R2: 4 vs 4 WB2-losers -> 4 (losers 9–12)
  for(let i=0;i<4;i++){ const [w,l]=M(lb1[i],wb2l[i],"LB2"); lb2.push(w); place[l.name]=9; }
  const lb3=[];                                   // LB R3: 4 -> 2 (losers 7–8)
  for(let i=0;i<4;i+=2){ const [w,l]=M(lb2[i],lb2[i+1],"LB3"); lb3.push(w); place[l.name]=7; }
  const lb4=[];                                   // LB R4: 2 vs 2 WB3-losers -> 2 (losers 5–6)
  for(let i=0;i<2;i++){ const [w,l]=M(lb3[i],wb3l[i],"LB4"); lb4.push(w); place[l.name]=5; }
  const [lb5w, lb5l]=M(lb4[0],lb4[1],"LB5"); place[lb5l.name]=4;        // LB R5: 2 -> 1 (loser 4th)
  const [lbChamp, lfLoser]=M(lb5w, wfLoser, "LF"); place[lfLoser.name]=3; // Losers Final (loser 3rd)

  // ---- Grand Final ----
  const [champ, gfLoser]=M(wbChamp, lbChamp, "GF");
  place[gfLoser.name]=2; place[champ.name]=1;

  // tally results + payouts
  let totalPaid=0;
  const results = players.map(p=>{ const pl=place[p.name]; const sol=cupPayout(pl); totalPaid+=sol; return {name:p.name, place:pl, sol:+sol.toFixed(4)}; })
                         .sort((a,b)=>a.place-b.place);
  return { champion:champ.name, results, log, totalPaid:+totalPaid.toFixed(4) };
}

export { runCup, cupPayout, SEED16 };

/* ---------- self-test: run a full 16-player Cup ---------- */
if (import.meta.url === `file://${process.argv[1]}`) {
  const ELEMS=["Water","Fire","Beast","Storm","Light"];
  const players=[]; for(let i=0;i<16;i++){
    const br=4+((i*5+3)%24);                                  // spread of Battle Ranks 4..27
    const el=ELEMS[i%5], skills=[i%12,(i+4)%12,(i+8)%12];
    const ct={}; skills.forEach(s=>ct[s]=Math.min(5,1+(br/6|0)));
    players.push({name:`Legend${String(i+1).padStart(2,"0")}(${el[0]}·BR${br})`, element:el, br, arenaSkills:skills, cardTier:ct});
  }
  const cup=runCup(players,"cup-test-1");
  const cup2=runCup(players,"cup-test-1");
  console.log("🏆 Champion:", cup.champion);
  console.log("Determinism:", cup.champion===cup2.champion && cup.log.length===cup2.log.length ? "PASS ✅" : "FAIL ❌");
  console.log("Matches played:", cup.log.length, "(expect 30)");
  console.log("\nFinal standings + payouts:");
  for(const r of cup.results) console.log(`  ${String(r.place).padStart(2)}. ${r.name.padEnd(26)} ${r.sol.toFixed(3)} ◎`);
  console.log("\nTotal SOL paid:", cup.totalPaid, "(pool 2.0 → buffer", (2-cup.totalPaid).toFixed(3)+")");
  const everyone = cup.results.every(r=>r.place>=1&&r.place<=16);
  console.log("Everyone placed + paid:", everyone ? "PASS ✅" : "FAIL ❌");
}
