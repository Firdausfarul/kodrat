// test-buy-direct.mjs — bypass Backpack, send buy tx directly with admin keypair
import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readFileSync } from "fs";
import { webcrypto } from "crypto";
import bs58 from "bs58";

const CONN = new Connection("http://localhost:8899", "confirmed");
const ADMIN = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/home/fahrul/.config/solana/id.json","utf8"))));
const PROG = new PublicKey("H5yv1n2BMwPXgVGYA9Rewz4PQFx7p3RDpbZgBajoiULY");
const ED25519 = new PublicKey("Ed25519SigVerify111111111111111111111111111");
const USDC = new PublicKey("ETXJSj32H2QZnJUUyoDMVWHcMM5ZTedx2gE8rBhJyt3");
const BUYER = ADMIN; // use admin as buyer for test

async function sha256(s) { return Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
async function disc(n) { return (await sha256(`global:${n}`)).subarray(0, 8); }

// Borsh serialize SignedQuote
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

// Ed25519 verify ix
function buildEd25519Ix(signer, signature, message) {
  const H = 16, offPk = H, offSig = H + 32, offMsg = H + 32 + 64;
  const buf = Buffer.alloc(offMsg + message.length);
  let o = 0;
  buf.writeUInt8(1, o++); buf.writeUInt8(0, o++);
  buf.writeUInt16LE(offSig, o); o += 2; buf.writeUInt16LE(0xFFFF, o); o += 2;
  buf.writeUInt16LE(offPk, o); o += 2; buf.writeUInt16LE(0xFFFF, o); o += 2;
  buf.writeUInt16LE(offMsg, o); o += 2; buf.writeUInt16LE(message.length, o); o += 2;
  buf.writeUInt16LE(0xFFFF, o); o += 2;
  Buffer.from(signer.toBytes()).copy(buf, o); o += 32;
  Buffer.from(signature).copy(buf, o); o += 64;
  Buffer.from(message).copy(buf, o);
  return new TransactionInstruction({ programId: ED25519, keys: [], data: buf });
}

async function main() {
  console.log("=== Direct Buy Test (admin keypair, no wallet) ===\n");

  // Get PDAs
  const sym = Buffer.alloc(8); Buffer.from("USD/IDR").copy(sym);
  const t30 = 60 * 60 * 24 * 30;
  const tenorBuf = Buffer.alloc(4); tenorBuf.writeUInt32LE(t30);
  const [REGISTRY] = PublicKey.findProgramAddressSync([Buffer.from("mm_registry")], PROG);
  const [MKT] = PublicKey.findProgramAddressSync([Buffer.from("market"), sym, tenorBuf, Buffer.from([0])], PROG);

  // Get MM — first MM account
  const mmAccs = await CONN.getProgramAccounts(PROG, { filters: [{ dataSize: 122 }] });
  if (!mmAccs.length) throw new Error("No MM found");
  const mmAuthRaw = mmAccs[0].account.data.slice(8, 8 + 32);
  const mmAuth = new PublicKey(mmAuthRaw);
  const [MM] = PublicKey.findProgramAddressSync([Buffer.from("mm"), mmAuth.toBuffer()], PROG);
  const mmQuoteSignerRaw = mmAccs[0].account.data.slice(8 + 32, 8 + 32 + 32);
  const mmQuoteSigner = new PublicKey(mmQuoteSignerRaw);
  console.log("MM:", MM.toBase58());
  console.log("MM Quote Signer:", mmQuoteSigner.toBase58());

  // Generate fake quote
  const now = Math.floor(Date.now() / 1000);
  const nonce = BigInt(Date.now()) % 1_000_000_000n;
  const quote = {
    buyer: BUYER.publicKey.toBase58(),
    mm_quote_signer: mmQuoteSigner.toBase58(),
    market: MKT.toBase58(),
    strike: 1_600_000,
    strike_exponent: -2,
    notional: 5_000_000_000n, // $5,000
    premium: 90_000_000n, // $90
    expiry: now + t30,
    quote_nonce: Number(nonce),
    valid_until: now + 300,
  };

  // Get quote from bot (uses ed25519-dalek, compatible with Solana precompile)
  console.log("Fetching quote from bot...");
  const resp = await fetch("http://localhost:8787/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      buyer: BUYER.publicKey.toBase58(),
      pair: "usd_idr",
      tenor_seconds: t30,
      notional_usdc: 5000,
    }),
  });
  if (!resp.ok) throw new Error("Bot error: " + await resp.text());
  const data = await resp.json();
  // Use bot's payload_b64 directly — already the bytes the bot signed
  const payload = Uint8Array.from(atob(data.quote.payload_b64), (c) => c.charCodeAt(0));
  const sigBytes = bs58.decode(data.signature_b58);
  const signerPubkey = new PublicKey(data.quote.mm_quote_signer);
  const edIx = buildEd25519Ix(signerPubkey, sigBytes, payload);

  // Debug: verify the pubkey bytes in the instruction match
  const edData = edIx.data;
  const pkOffset = edData.readUInt16LE(6);
  const pkInData = edData.subarray(pkOffset, pkOffset + 32);
  console.log("PK in ix data:", bs58.encode(pkInData));
  console.log("Expected PK:   ", signerPubkey.toBase58());
  console.log("PK matches:", Buffer.from(pkInData).equals(Buffer.from(signerPubkey.toBytes())));

  // For buy instruction, we need the SAME payload bytes to go on-chain
  // The on-chain program does quote.serialize() which should match bot's borsh output
  // Use payload_b64 for instruction data too (skip re-serialization)

  const buyerAta = await getAssociatedTokenAddress(USDC, BUYER.publicKey, false);
  const mmVault = await getAssociatedTokenAddress(USDC, MM, true);
  // Read nonce from payload binary (JSON loses u64 precision for > 2^53)
  const dv = new DataView(payload.buffer);
  const quoteNonce = dv.getBigUint64(32 + 32 + 32 + 8 + 4 + 8 + 8 + 8, true);
  console.log("Nonce (JSON):", data.quote.quote_nonce, "| Nonce (binary):", quoteNonce.toString());
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(quoteNonce);
  const [pos] = PublicKey.findProgramAddressSync([Buffer.from("position"), BUYER.publicKey.toBuffer(), nonceBuf], PROG);

  // Get price feed PDA (using sym defined above)
  const [PF] = PublicKey.findProgramAddressSync([Buffer.from("price_feed"), sym], PROG);
  const INSTRUCTIONS_ID = new PublicKey(new Uint8Array([
    6, 167, 213, 23, 24, 123, 209, 102, 53, 218, 212, 4, 85, 253, 194, 192,
    193, 36, 198, 143, 33, 86, 117, 165, 219, 186, 203, 95, 8, 0, 0, 0
  ]));

  const d = await disc("buy_option");
  const buyIx = new TransactionInstruction({
    programId: PROG,
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
    ],
    data: Buffer.concat([Buffer.from(d), Buffer.from(payload)]),
  });

  // Include ed25519 verify at instruction[0] (required by contract)
  const tx = new Transaction().add(edIx).add(buyIx);
  tx.feePayer = BUYER.publicKey;
  tx.recentBlockhash = (await CONN.getLatestBlockhash()).blockhash;
  const msg = tx.compileMessage();

  // DEBUG: Check compiled message account keys
  console.log("\nCompiled message accounts:");
  msg.accountKeys.forEach((k, i) => console.log(`  [${i}] ${k.toBase58()}`));
  // Also check the compiled instruction's account indices
  console.log("\nBuy ix compiled accounts (indices):");
  const ci = msg.instructions[0];
  ci.accounts.forEach((idx, i) => console.log(`  pos[${i}] → msg[${idx}] = ${msg.accountKeys[idx].toBase58()}`));

  try {
    const result = await CONN.simulateTransaction(tx);
    console.log("\nSimulation:", result.value.err ? "FAILED" : "OK");
    if (result.value.err) {
      console.log("Error:", JSON.stringify(result.value.err));
      console.log("Logs:", result.value.logs?.join("\n"));
    } else {
      console.log("✅ Simulation passed! Sending...");
      const sig = await sendAndConfirmTransaction(CONN, tx, [BUYER]);
      console.log("TX:", sig);
    }
  } catch (e) {
    console.error("Error:", e);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
