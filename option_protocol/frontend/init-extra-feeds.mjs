// init-extra-feeds.mjs — Create price feeds for jpy_idr, cny_idr, cny_usd, usd_jpy on devnet
import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync } from "fs";

const CONN = new Connection("https://api.devnet.solana.com", "confirmed");
const ADMIN = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/home/fahrul/.config/solana/id.json","utf8"))));
const PROG = new PublicKey("H5yv1n2BMwPXgVGYA9Rewz4PQFx7p3RDpbZgBajoiULY");
const REGISTRY = new PublicKey("JATKKyshL1dmsgyBdgKbnt8iDctnQkUfBTxX46SnRXot");

async function sha256(s) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
async function disc(n) { return Buffer.from((await sha256(`global:${n}`)).slice(0,8)); }

async function send(ixs) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = ADMIN.publicKey;
  tx.recentBlockhash = (await CONN.getLatestBlockhash()).blockhash;
  const sig = await sendAndConfirmTransaction(CONN, tx, [ADMIN], { commitment: "confirmed" });
  return sig;
}

const PAIRS = ["USD/JPY", "JPY/IDR", "CNY/IDR", "CNY/USD"];
const SYMS = PAIRS.map(s => { const b = Buffer.alloc(8); Buffer.from(s).copy(b); return b; });

for (let i = 0; i < PAIRS.length; i++) {
  const sym = SYMS[i];
  const pair = PAIRS[i];
  const [PF] = PublicKey.findProgramAddressSync([Buffer.from("price_feed"), sym], PROG);

  // Check if already exists
  const acc = await CONN.getAccountInfo(PF);
  if (acc) {
    console.log(`${pair} already exists: ${PF.toBase58()}`);
  } else {
    console.log(`Creating ${pair}...`);
    const pfDisc = await disc("init_price_feed");
    const pfData = Buffer.alloc(pfDisc.length + 8);
    Buffer.from(pfDisc).copy(pfData, 0); sym.copy(pfData, pfDisc.length);
    const sig = await send([new TransactionInstruction({ programId: PROG, data: pfData,
      keys: [
        {pubkey: ADMIN.publicKey, isSigner: true, isWritable: true},
        {pubkey: REGISTRY, isSigner: false, isWritable: false},
        {pubkey: PF, isSigner: false, isWritable: true},
        {pubkey: SystemProgram.programId, isSigner: false, isWritable: false},
      ]})]);
    console.log(`  OK ${PF.toBase58()}  sig=${sig.slice(0,30)}`);
  }

  // Update price
  const spotMap = {
    "USD/JPY": { price: 14520, exp: -2 },
    "JPY/IDR": { price: 11180, exp: -2 },
    "CNY/IDR": { price: 226000, exp: -2 },
    "CNY/USD": { price: 1390, exp: -4 },
  };
  const s = spotMap[pair];
  const upDisc = await disc("update_price");
  const upData = Buffer.alloc(upDisc.length + 8 + 4);
  Buffer.from(upDisc).copy(upData, 0);
  upData.writeBigInt64LE(BigInt(s.price), upDisc.length);
  upData.writeInt32LE(s.exp, upDisc.length + 8);
  const sig2 = await send([new TransactionInstruction({ programId: PROG, data: upData,
    keys: [
      {pubkey: ADMIN.publicKey, isSigner: true, isWritable: false},
      {pubkey: PF, isSigner: false, isWritable: true},
    ]})]);
  console.log(`  Price: ${s.price}x10^${s.exp}  sig=${sig2.slice(0,30)}`);
}

console.log("\nDone.");
