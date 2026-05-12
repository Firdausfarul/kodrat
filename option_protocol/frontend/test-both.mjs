// test-both.mjs — test PUT and CALL end-to-end
import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readFileSync } from "fs";
import bs58 from "bs58";

const CONN = new Connection("http://localhost:8899", "confirmed");
const ADMIN = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/home/fahrul/.config/solana/id.json","utf8"))));
const PROG = new PublicKey("H5yv1n2BMwPXgVGYA9Rewz4PQFx7p3RDpbZgBajoiULY");
const ED25519 = new PublicKey("Ed25519SigVerify111111111111111111111111111");
const USDC = new PublicKey("ETXJSj32H2QZnJUUyoDMVWHcMM5ZTedx2gE8rBhJyt3");
const BUYER = ADMIN;
const SymBuf = Buffer.alloc(8); Buffer.from("USD/IDR").copy(SymBuf);
const [PF] = PublicKey.findProgramAddressSync([Buffer.from("price_feed"), SymBuf], PROG);
const INSTRUCTIONS_ID = new PublicKey(new Uint8Array([
  6, 167, 213, 23, 24, 123, 209, 102, 53, 218, 212, 4, 85, 253, 194, 192,
  193, 36, 198, 143, 33, 86, 117, 165, 219, 186, 203, 95, 8, 0, 0, 0
]));

async function sha256(s) { return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
async function disc(n) { return (await sha256(`global:${n}`)).subarray(0, 8); }

function serializeQuote(q) {
  const arr = Buffer.alloc(32 + 32 + 32 + 8 + 4 + 8 + 8 + 8 + 8 + 8);
  let o = 0;
  Buffer.from(bs58.decode(q.buyer)).copy(arr, o); o += 32;
  Buffer.from(bs58.decode(q.mm_quote_signer)).copy(arr, o); o += 32;
  Buffer.from(bs58.decode(q.market)).copy(arr, o); o += 32;
  arr.writeBigInt64LE(BigInt(q.strike), o); o += 8;
  arr.writeInt32LE(q.strike_exponent, o); o += 4;
  arr.writeBigUint64LE(BigInt(q.notional), o); o += 8;
  arr.writeBigUint64LE(BigInt(q.premium), o); o += 8;
  arr.writeBigInt64LE(BigInt(q.expiry), o); o += 8;
  arr.writeBigUint64LE(BigInt(q.quote_nonce), o); o += 8;
  arr.writeBigInt64LE(BigInt(q.valid_until), o);
  return arr;
}

async function testBuy(kind, label) {
  console.log(`\n=== Testing ${label} ===`);

  const sym = Buffer.alloc(8); Buffer.from("USD/IDR").copy(sym);
  const t30 = 60 * 60 * 24 * 30;
  const tBuf = Buffer.alloc(4); tBuf.writeUInt32LE(t30);
  const [MKT] = PublicKey.findProgramAddressSync([Buffer.from("market"), sym, tBuf, Buffer.from([kind])], PROG);

  const [REGISTRY] = PublicKey.findProgramAddressSync([Buffer.from("mm_registry")], PROG);
  const mmAccs = await CONN.getProgramAccounts(PROG, { filters: [{ dataSize: 122 }] });
  const mmAuth = new PublicKey(mmAccs[0].account.data.slice(8, 40));
  const mmQuoteSigner = new PublicKey(mmAccs[0].account.data.slice(40, 72));
  const [MM] = PublicKey.findProgramAddressSync([Buffer.from("mm"), mmAuth.toBuffer()], PROG);

  // Get quote from bot
  const resp = await fetch("http://localhost:8787/quote", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ buyer: BUYER.publicKey.toBase58(), pair: "usd_idr", tenor_seconds: t30, notional_usdc: 5000, option_kind: kind }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  const data = await resp.json();

  const payload = Uint8Array.from(atob(data.quote.payload_b64), c => c.charCodeAt(0));
  const sigBytes = bs58.decode(data.signature_b58);
  const edIx = new TransactionInstruction({ programId: ED25519, keys: [], data: buildEd25519Data(new PublicKey(data.quote.mm_quote_signer), sigBytes, payload) });

  const buyerAta = await getAssociatedTokenAddress(USDC, BUYER.publicKey, false);
  const mmVault = await getAssociatedTokenAddress(USDC, MM, true);
  const dv = new DataView(payload.buffer);
  const nonce = dv.getBigUint64(32 + 32 + 32 + 8 + 4 + 8 + 8 + 8, true);
  const nonceBuf = Buffer.alloc(8); nonceBuf.writeBigUInt64LE(nonce);
  const [pos] = PublicKey.findProgramAddressSync([Buffer.from("position"), BUYER.publicKey.toBuffer(), nonceBuf], PROG);

  const d = await disc("buy_option");
  const buyIx = new TransactionInstruction({ programId: PROG, data: Buffer.concat([Buffer.from(d), Buffer.from(payload)]),
    keys: [
      { pubkey: BUYER.publicKey, isSigner: true, isWritable: true },
      { pubkey: INSTRUCTIONS_ID, isSigner: false, isWritable: false },
      { pubkey: REGISTRY, isSigner: false, isWritable: false },
      { pubkey: MKT, isSigner: false, isWritable: false },
      { pubkey: PF, isSigner: false, isWritable: false },
      { pubkey: MM, isSigner: false, isWritable: true },
      { pubkey: buyerAta, isSigner: false, isWritable: true },
      { pubkey: mmVault, isSigner: false, isWritable: true },
      { pubkey: pos, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]});

  const tx = new Transaction().add(edIx).add(buyIx);
  tx.feePayer = BUYER.publicKey;
  tx.recentBlockhash = (await CONN.getLatestBlockhash()).blockhash;
  const sig = await sendAndConfirmTransaction(CONN, tx, [BUYER]);
  console.log(`  ✅ ${label} bought: ${sig.slice(0, 20)}...`);

  // Verify position exists
  const acc = await CONN.getAccountInfo(pos);
  const status = acc.data[8 + 32 + 32 + 32 + 8 + 4 + 8 + 8 + 8 + 8];
  console.log(`  Status: ${status === 0 ? "OPEN ✅" : status}`);
}

function buildEd25519Data(signer, sig, msg) {
  const H = 16, oPk = H, oSig = H + 32, oMsg = H + 32 + 64;
  const buf = Buffer.alloc(oMsg + msg.length);
  let o = 0;
  buf.writeUInt8(1, o++); buf.writeUInt8(0, o++);
  buf.writeUInt16LE(oSig, o); o += 2; buf.writeUInt16LE(0xFFFF, o); o += 2;
  buf.writeUInt16LE(oPk, o); o += 2; buf.writeUInt16LE(0xFFFF, o); o += 2;
  buf.writeUInt16LE(oMsg, o); o += 2; buf.writeUInt16LE(msg.length, o); o += 2;
  buf.writeUInt16LE(0xFFFF, o); o += 2;
  Buffer.from(signer.toBytes()).copy(buf, o); o += 32;
  Buffer.from(sig).copy(buf, o); o += 64;
  Buffer.from(msg).copy(buf, o);
  return buf;
}

await testBuy(0, "PUT");
await testBuy(1, "CALL");
console.log("\n✅ Both PUT and CALL work!");
