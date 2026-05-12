import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync } from "fs";

const CONN = new Connection("https://api.devnet.solana.com", "confirmed");
const ADMIN = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/home/fahrul/.config/solana/id.json","utf8"))));
const PROG = new PublicKey("H5yv1n2BMwPXgVGYA9Rewz4PQFx7p3RDpbZgBajoiULY");
const PF = new PublicKey("8dWPze7WPkkMjvbypWhfapP6y3kLCstLMskA2zGsRiry");

async function sha256(s) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
async function disc(n) { return Buffer.from((await sha256(`global:${n}`)).slice(0,8)); }

const d = await disc("update_price");
const data = Buffer.alloc(d.length + 8 + 4);
Buffer.from(d).copy(data, 0);
data.writeBigInt64LE(1_625_000n, d.length);
data.writeInt32LE(-2, d.length + 8);

const tx = new Transaction().add(new TransactionInstruction({
  programId: PROG,
  keys: [
    {pubkey: ADMIN.publicKey, isSigner: true, isWritable: false},
    {pubkey: PF, isSigner: false, isWritable: true},
  ],
  data,
}));
tx.feePayer = ADMIN.publicKey;
tx.recentBlockhash = (await CONN.getLatestBlockhash()).blockhash;
const sig = await sendAndConfirmTransaction(CONN, tx, [ADMIN]);
console.log("Price updated:", sig);
