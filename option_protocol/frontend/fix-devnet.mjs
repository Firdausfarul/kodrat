// fix-devnet.mjs — Create CALL market, update price (idempotent on existing setup)
import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync } from "fs";

const RPC = "https://api.devnet.solana.com";
const CONN = new Connection(RPC, "confirmed");
const ADMIN = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/home/fahrul/.config/solana/id.json","utf8"))));
const PROG = new PublicKey("H5yv1n2BMwPXgVGYA9Rewz4PQFx7p3RDpbZgBajoiULY");

async function sha256(s) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
async function disc(n) { return Buffer.from((await sha256(`global:${n}`)).slice(0,8)); }

async function send(ixs) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = ADMIN.publicKey;
  tx.recentBlockhash = (await CONN.getLatestBlockhash()).blockhash;
  const sig = await sendAndConfirmTransaction(CONN, tx, [ADMIN], { commitment: "confirmed" });
  console.log(`  ok: ${sig}`);
  return sig;
}

// Known PDAs from previous run
const REGISTRY = new PublicKey("JATKKyshL1dmsgyBdgKbnt8iDctnQkUfBTxX46SnRXot");
const PF = new PublicKey("8dWPze7WPkkMjvbypWhfapP6y3kLCstLMskA2zGsRiry");
const PUT_MARKET = new PublicKey("4xVyhBanB7Pp5pUQKPd1BFkATjFQgWo6bJ9rEnCpHKTW");
const sym = Buffer.alloc(8); Buffer.from("USD/IDR").copy(sym);
const t30 = 60 * 60 * 24 * 30;
const tBuf = Buffer.alloc(4); tBuf.writeUInt32LE(t30);

console.log("ADMIN:", ADMIN.publicKey.toBase58());
console.log("BALANCE:", (await CONN.getBalance(ADMIN.publicKey)) / 1e9, "SOL");

// Create CALL market (kind=1)
console.log("\n1. Create CALL market...");
const kindBuf = Buffer.from([1]);
const [CALL_MKT] = PublicKey.findProgramAddressSync([Buffer.from("market"), sym, tBuf, kindBuf], PROG);
console.log(`  Expected CALL PDA: ${CALL_MKT.toBase58()}`);

const mkDisc = await disc("init_market");
// Anchor param order: base_symbol(8) + tenor(4) + min(8) + max(8) + option_kind(1)
const mkData = Buffer.alloc(mkDisc.length + 8 + 4 + 8 + 8 + 1);
Buffer.from(mkDisc).copy(mkData, 0);
sym.copy(mkData, mkDisc.length);
mkData.writeUInt32LE(t30, mkDisc.length + 8);
mkData.writeBigUInt64LE(10_000_000n, mkDisc.length + 12);    // min $10
mkData.writeBigUInt64LE(500_000_000_000n, mkDisc.length + 20); // max $500K
mkData.writeUInt8(1, mkDisc.length + 28); // option_kind = CALL
try {
  await send([new TransactionInstruction({ programId: PROG, data: mkData,
    keys: [
      {pubkey: ADMIN.publicKey, isSigner: true, isWritable: true},
      {pubkey: REGISTRY, isSigner: false, isWritable: false},
      {pubkey: PF, isSigner: false, isWritable: false},
      {pubkey: CALL_MKT, isSigner: false, isWritable: true},
      {pubkey: SystemProgram.programId, isSigner: false, isWritable: false},
    ]})]);
  console.log(`  CALL market created: ${CALL_MKT.toBase58()}`);
} catch(e) {
  console.log(`  SKIP: ${e.message?.slice(0,80)}`);
  const info = await CONN.getAccountInfo(CALL_MKT);
  console.log(`  Account exists: ${!!info}`);
}

// Update price to 16,250 (spot rate)
console.log("\n2. Update price...");
const upDisc = await disc("update_price");
const upData = Buffer.alloc(upDisc.length + 8 + 4);
Buffer.from(upDisc).copy(upData, 0);
upData.writeBigInt64LE(1_625_000n, upDisc.length);
upData.writeInt32LE(-2, upDisc.length + 8);
try {
  await send([new TransactionInstruction({ programId: PROG, data: upData,
    keys: [
      {pubkey: ADMIN.publicKey, isSigner: true, isWritable: false},
      {pubkey: PF, isSigner: false, isWritable: true},
    ]})]);
  console.log("  Price updated to 16,250");
} catch(e) {
  console.log(`  SKIP: ${e.message?.slice(0,80)}`);
}

// Verify markets
console.log("\n3. Verifying markets...");
const mktAccs = await CONN.getProgramAccounts(PROG, { filters: [{ dataSize: 50 }] });
for (const { pubkey, account } of mktAccs) {
  const data = account.data;
  const feed = new PublicKey(data.slice(8, 40));
  const symStr = String.fromCharCode(...data.slice(40, 48)).replace(/\0/g, '');
  const tenor = data.readUInt32LE(48);
  const kind = data[52];
  const active = data[69]; // after min(8) + max(8)
  console.log(`  ${pubkey.toBase58()}  symbol=${symStr}  tenor=${tenor}s  kind=${kind===0?'PUT':'CALL'}  active=${!!active}`);
}

console.log("\n=== DONE ===");
console.log("Next: start bot with env from /tmp/kodrat-devnet.env");
