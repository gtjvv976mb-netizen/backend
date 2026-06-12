{
  "name": "chiki-backend",
  "version": "0.2.0",
  "type": "module",
  "description": "Chiki Monsters backend \u2014 holder verification + SOL reward payouts (Solana).",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js",
    "treasury": "node scripts/new-wallet.js"
  },
  "dependencies": {
    "@solana/web3.js": "^1.95.3",
    "bs58": "^6.0.0",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "pg": "^8.12.0"
  }
}
