import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, Keypair, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync } from "fs";

const CONN = new Connection("http://localhost:8899", "confirmed");
const ADMIN = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/home/fahrul/.config/solana/id.json","utf8"))));
const PROG = new PublicKey("H5yv1n2BMwPXgVGYA9Rewz4PQFx7p3RDpbZgBajoiULY");
const REGISTRY = new PublicKey("JATKKyshL1dmsgyBdgKbnt8iDctnQkUfBTxX46SnRXot");
const sym = Buffer.alloc(8); Buffer.from("USD/IDR").copy(sym);
const t30 = 60 * 60 * 24 * 30;
const tBuf = Buffer.alloc(4); tBuf.writeUInt32LE(t30);
const [PF] = PublicKey.findProgramAddressSync([Buffer.from("price_feed"), sym], PROG);

async function initMarket(kind) {
  const [MKT] = PublicKey.findProgramAddressSync([Buffer.from("market"), sym, tBuf, Buffer.from([kind])], PROG);
  const name = "init_market";
  const disc = Buffer.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("global:" + name))).slice(0, 8));
  const data = Buffer.alloc(8 + 8 + 4 + 8 + 8 + 1);
  disc.copy(data); sym.copy(data, 8);
  data.writeUInt32LE(t30, 16);
  data.writeBigUInt64LE(10_000_000n, 20);
  data.writeBigUInt64LE(500_000_000_000n, 28);
  data.writeUInt8(kind, 36);
  const tx = new Transaction().add(new TransactionInstruction({ programId: PROG, data, keys: [
    { pubkey: ADMIN.publicKey, isSigner: true, isWritable: true },
    { pubkey: REGISTRY, isSigner: false, isWritable: false },
    { pubkey: PF, isSigner: false, isWritable: false },
    { pubkey: MKT, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]}));
  tx.feePayer = ADMIN.publicKey;
  tx.recentBlockhash = (await CONN.getLatestBlockhash()).blockhash;
  try {
    const sig = await sendAndConfirmTransaction(CONN, tx, [ADMIN]);
    console.log(`  ${kind === 0 ? "PUT" : "CALL"} ${sig.slice(0, 20)}... MKT=${MKT.toBase58()}`);
  } catch (e) { console.log(`  ${kind === 0 ? "PUT" : "CALL"} skip: ${e.message?.slice(0, 60)}`); }
}

await initMarket(0);
await initMarket(1);
console.log("Done");
