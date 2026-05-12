// price-feeder.mjs — auto-update price feed every 30s on devnet
import { Connection, PublicKey, Transaction, TransactionInstruction, Keypair, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync } from "fs";

const CONN = new Connection("https://api.devnet.solana.com", "confirmed");
const ADMIN = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/home/fahrul/.config/solana/id.json","utf8"))));
const PROG = new PublicKey("H5yv1n2BMwPXgVGYA9Rewz4PQFx7p3RDpbZgBajoiULY");

const sym = Buffer.alloc(8); Buffer.from("USD/IDR").copy(sym);
const [PF] = PublicKey.findProgramAddressSync([Buffer.from("price_feed"), sym], PROG);

async function sha256(s) { return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
async function disc(n) { return (await sha256(`global:${n}`)).subarray(0, 8); }

let basePrice = 1_625_000n;
const noise = () => BigInt(Math.floor((Math.random() - 0.5) * 400)); // ±200 IDR

async function updatePrice() {
  try {
    const d = await disc("update_price");
    const data = Buffer.alloc(d.length + 8 + 4);
    Buffer.from(d).copy(data, 0);
    data.writeBigInt64LE(basePrice + noise(), d.length);
    data.writeInt32LE(-2, d.length + 8);

    const tx = new Transaction().add(new TransactionInstruction({
      programId: PROG, data,
      keys: [
        { pubkey: ADMIN.publicKey, isSigner: true, isWritable: false },
        { pubkey: PF, isSigner: false, isWritable: true },
      ],
    }));
    tx.feePayer = ADMIN.publicKey;
    tx.recentBlockhash = (await CONN.getLatestBlockhash()).blockhash;
    const sig = await sendAndConfirmTransaction(CONN, tx, [ADMIN], { commitment: "confirmed" });
    const ts = new Date().toLocaleTimeString();
    console.log(`[${ts}] ✅ updated  sig=${sig.slice(0, 20)}...`);
  } catch (e) {
    const ts = new Date().toLocaleTimeString();
    console.error(`[${ts}] ❌ ${e.message?.slice(0, 80)}`);
  }
}

console.log("🔄 Price feeder (devnet) — updating every 60s");
updatePrice();
setInterval(updatePrice, 60_000);
