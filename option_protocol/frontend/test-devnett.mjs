// test-devnett.mjs — End-to-end PUT + CALL buy on devnet with ed25519 verification
import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { readFileSync } from "fs";
import bs58 from "bs58";

const CONN = new Connection("https://api.devnet.solana.com", "confirmed");
const ADMIN = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/home/fahrul/.config/solana/id.json","utf8"))));
const BUYER = ADMIN;

const PROG = new PublicKey("H5yv1n2BMwPXgVGYA9Rewz4PQFx7p3RDpbZgBajoiULY");
const ED25519 = new PublicKey("Ed25519SigVerify111111111111111111111111111");
const USDC = new PublicKey("HaeZjxpic6AWcd6aS2TfLzHXq1c4qFegR6WMd5aH5CRv");
const BOT_URL = "http://localhost:8787";

const SymBuf = Buffer.alloc(8); Buffer.from("USD/IDR").copy(SymBuf);
const [PF] = PublicKey.findProgramAddressSync([Buffer.from("price_feed"), SymBuf], PROG);
const INSTRUCTIONS_ID = new PublicKey(new Uint8Array([6,167,213,23,24,123,209,102,53,218,212,4,85,253,194,192,193,36,198,143,33,86,117,165,219,186,203,95,8,0,0,0]));

let buyerAta, mmAccounts, REGISTRY;

async function sha256(s) { return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
async function disc(n) { return (await sha256(`global:${n}`)).subarray(0, 8); }

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

function fmtUSDC(lamports) {
  return (Number(lamports) / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2 });
}

function parsePosition(data) {
  if (data.length < 100) return { status: -1, notional: 0, premium: 0, payout: 0, expiry: 0 };
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const sz = data.length;
  const readBig = (off) => (off + 8 <= sz) ? dv.getBigUint64(off, true) : 0n;
  const off = 8 + 32 + 32 + 32;
  const notional = readBig(off + 8 + 4);
  const premium  = readBig(off + 8 + 4 + 8);
  const expiry   = off + 8 + 4 + 8 + 8 + 8 <= sz ? Number(dv.getBigInt64(off + 8 + 4 + 8 + 8, true)) : 0;
  const status   = data[off + 8 + 4 + 8 + 8 + 8 + 8];
  const payout   = readBig(off + 8 + 4 + 8 + 8 + 8 + 8 + 1 + 8);
  return { status, notional: Number(notional), premium: Number(premium), payout: Number(payout), expiry };
}

async function setup() {
  console.log("=== Devnet E2E Test ===\n");
  console.log("RPC:    https://api.devnet.solana.com");
  console.log("Buyer: ", BUYER.publicKey.toBase58());
  console.log("USDC:  ", USDC.toBase58());

  // Fund buyer with USDC if needed
  console.log("\n→ Ensuring buyer has USDC...");
  buyerAta = await getOrCreateAssociatedTokenAccount(CONN, BUYER, USDC, BUYER.publicKey);
  const bal = await CONN.getTokenAccountBalance(buyerAta.address);
  console.log(`  ATA: ${buyerAta.address.toBase58()}  balance: ${bal.value.uiAmount} USDC`);
  if ((bal.value.amount || 0) < 100_000_000) { // < $100
    console.log("  Minting $100K USDC to buyer...");
    const sig = await mintTo(CONN, ADMIN, USDC, buyerAta.address, ADMIN.publicKey, 100_000_000_000n);
    console.log(`  OK: ${sig.slice(0, 44)}`);
  }

  // Find MMs
  console.log("\n→ Finding MMs...");
  [REGISTRY] = PublicKey.findProgramAddressSync([Buffer.from("mm_registry")], PROG);
  const mmAccs = await CONN.getProgramAccounts(PROG, { filters: [{ dataSize: 122 }] });
  if (!mmAccs.length) { console.log("  NO MM FOUND — run setup-devnet.mjs first"); process.exit(1); }
  mmAccounts = mmAccs.map(({ account }) => {
    const data = account.data;
    const authority = new PublicKey(data.slice(8, 40));
    const quoteSigner = new PublicKey(data.slice(40, 72));
    const [mm] = PublicKey.findProgramAddressSync([Buffer.from("mm"), authority.toBuffer()], PROG);
    return { authority, quoteSigner, mm };
  });
  console.log(`  Found ${mmAccounts.length} registered MM(s)`);
}

async function buy(kind, label) {
  console.log(`\n=== ${label} ===`);
  const t30 = 60 * 60 * 24 * 30;
  const tBuf = Buffer.alloc(4); tBuf.writeUInt32LE(t30);
  const [MKT] = PublicKey.findProgramAddressSync([Buffer.from("market"), SymBuf, tBuf, Buffer.from([kind])], PROG);
  console.log(`  Market: ${MKT.toBase58()}`);

  // Get signed quote from bot
  const resp = await fetch(`${BOT_URL}/quote`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ buyer: BUYER.publicKey.toBase58(), pair: "usd_idr", tenor_seconds: t30, notional_usdc: 5000, option_kind: kind }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  const qr = await resp.json();
  console.log(`  Quote: premium=${fmtUSDC(qr.quote.premium)} USDC  strike=${qr.quote.strike / 100}`);
  const mmAccount = mmAccounts.find(m => m.quoteSigner.toBase58() === qr.quote.mm_quote_signer);
  if (!mmAccount) throw new Error(`No MM registered for quote signer ${qr.quote.mm_quote_signer}`);
  const MM = mmAccount.mm;
  const mmVault = await getAssociatedTokenAddress(USDC, MM, true);
  const vaultBal = await CONN.getTokenAccountBalance(mmVault);
  console.log(`  MM: ${MM.toBase58()}  vault=${vaultBal.value.uiAmount} USDC`);

  // Build ed25519 verify instruction at [0]
  const payload = Uint8Array.from(atob(qr.quote.payload_b64), c => c.charCodeAt(0));
  const sigBytes = bs58.decode(qr.signature_b58);
  const edIx = new TransactionInstruction({ programId: ED25519, keys: [], data: buildEd25519Data(new PublicKey(qr.quote.mm_quote_signer), sigBytes, payload) });

  // Build buy_option instruction at [1]
  const nonce = new DataView(payload.buffer).getBigUint64(32 + 32 + 32 + 8 + 4 + 8 + 8 + 8, true);
  const nonceBuf = Buffer.alloc(8); nonceBuf.writeBigUInt64LE(nonce);
  const [pos] = PublicKey.findProgramAddressSync([Buffer.from("position"), BUYER.publicKey.toBuffer(), nonceBuf], PROG);

  const d = await disc("buy_option");
  const buyIx = new TransactionInstruction({
    programId: PROG,
    data: Buffer.concat([Buffer.from(d), Buffer.from(payload)]),
    keys: [
      { pubkey: BUYER.publicKey, isSigner: true, isWritable: true },
      { pubkey: INSTRUCTIONS_ID, isSigner: false, isWritable: false },
      { pubkey: REGISTRY, isSigner: false, isWritable: false },
      { pubkey: MKT, isSigner: false, isWritable: false },
      { pubkey: PF, isSigner: false, isWritable: false },
      { pubkey: MM, isSigner: false, isWritable: true },
      { pubkey: buyerAta.address, isSigner: false, isWritable: true },
      { pubkey: mmVault, isSigner: false, isWritable: true },
      { pubkey: pos, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PublicKey.default, isSigner: false, isWritable: false }, // SystemProgram
    ],
  });

  // Send tx
  const tx = new Transaction().add(edIx).add(buyIx);
  tx.feePayer = BUYER.publicKey;
  tx.recentBlockhash = (await CONN.getLatestBlockhash()).blockhash;
  const txSig = await sendAndConfirmTransaction(CONN, tx, [BUYER], { commitment: "confirmed" });
  console.log(`  ✅ TX: ${txSig}`);

  // Read position
  const acc = await CONN.getAccountInfo(pos);
  if (!acc) throw new Error("Position not created!");
  const p = parsePosition(acc.data);
  console.log(`  Position: ${pos.toBase58().slice(0, 16)}...  status=${p.status === 0 ? "OPEN" : p.status}  premium=${fmtUSDC(p.premium)} USDC`);
  return { posPubkey: pos, posData: p };
}

async function settle(posPubkey, posData) {
  console.log(`\n--- Settling ${posPubkey.toBase58().slice(0, 16)}... ---`);
  if (posData.expiry > Math.floor(Date.now() / 1000)) {
    console.log("  SKIP: not expired yet (expires in " + Math.floor((posData.expiry - Date.now() / 1000) / 86400) + " days)");
    return;
  }

  // Read position to get market + mm
  const acc = await CONN.getAccountInfo(posPubkey);
  if (!acc) throw new Error("Position not found");
  const data = acc.data;
  const marketKey = new PublicKey(data.slice(8 + 32 + 32, 8 + 32 + 32 + 32));
  const mmKey = new PublicKey(data.slice(8 + 32, 8 + 32 + 32));

  // Read market to get price_feed
  const mktAcc = await CONN.getAccountInfo(marketKey);
  if (!mktAcc) throw new Error("Market not found");
  const priceFeedKey = new PublicKey(mktAcc.data.slice(8, 8 + 32));

  // Read mm to get vault
  const mmAcc = await CONN.getAccountInfo(mmKey);
  if (!mmAcc) throw new Error("MM not found");
  const mmVaultKey = new PublicKey(mmAcc.data.slice(8 + 32, 8 + 32 + 32));

  const d = await disc("settle_option");
  const ix = new TransactionInstruction({
    programId: PROG,
    keys: [
      { pubkey: BUYER.publicKey, isSigner: true, isWritable: false },
      { pubkey: posPubkey, isSigner: false, isWritable: true },
      { pubkey: marketKey, isSigner: false, isWritable: false },
      { pubkey: priceFeedKey, isSigner: false, isWritable: false },
      { pubkey: mmKey, isSigner: false, isWritable: false },
      { pubkey: mmVaultKey, isSigner: false, isWritable: true },
      { pubkey: buyerAta.address, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(d),
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = BUYER.publicKey;
  tx.recentBlockhash = (await CONN.getLatestBlockhash()).blockhash;
  const txSig = await sendAndConfirmTransaction(CONN, tx, [BUYER], { commitment: "confirmed" });
  console.log(`  ✅ Settled: ${txSig}`);

  const updated = await CONN.getAccountInfo(posPubkey);
  const p2 = parsePosition(updated.data);
  console.log(`  Status: ${p2.status === 1 ? "EXERCISED" : p2.status === 2 ? "EXPIRED OTM" : p2.status}  payout=${fmtUSDC(p2.payout)} USDC`);
}

// ── Main ──
await setup();

const putResult = await buy(0, "BUY PUT (hedge rupiah strengthening)");
console.log("\n" + "=".repeat(50));
const callResult = await buy(1, "BUY CALL (hedge rupiah weakening)");

// Try settling — note: newly created positions expire 30 days from now, so settlement will SKIP
// To test settlement, set expiry in the bot's quote or warp time
await settle(putResult.posPubkey, putResult.posData);
await settle(callResult.posPubkey, callResult.posData);

console.log("\n✅ Devnet E2E test complete!");
console.log(`\nExplorer: https://explorer.solana.com/address/${PROG.toBase58()}?cluster=devnet`);
