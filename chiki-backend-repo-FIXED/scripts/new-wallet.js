// Generate a fresh devnet wallet (for a test treasury). Prints the secret key array + public key.
import { Keypair } from "@solana/web3.js";
const kp = Keypair.generate();
console.log("PUBLIC KEY :", kp.publicKey.toBase58());
console.log("SECRET (put in .env TREASURY_SECRET):");
console.log(JSON.stringify(Array.from(kp.secretKey)));
console.log("\nFund it with devnet SOL:  solana airdrop 2", kp.publicKey.toBase58(), "--url devnet");
console.log("…or the faucet: https://faucet.solana.com");
