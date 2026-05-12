// setup-devnet.mjs — Full protocol initialization on Solana devnet
// Usage: node setup-devnet.mjs

import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, mintTo, createMint } from "@solana/spl-token";
import bs58 from "bs58";
import { readFileSync, writeFileSync } from "fs";

const RPC = "https://api.devnet.solana.com";
const CONN = new Connection(RPC, "confirmed");
const ADMIN = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/home/fahrul/.config/solana/id.json","utf8"))));
const PROG = new PublicKey("H5yv1n2BMwPXgVGYA9Rewz4PQFx7p3RDpbZgBajoiULY");

console.log("ADMIN:", ADMIN.publicKey.toBase58());
console.log("BALANCE:", (await CONN.getBalance(ADMIN.publicKey)) / 1e9, "SOL");

async function sha256(s) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
async function disc(n) { return Buffer.from((await sha256(`global:${n}`)).slice(0,8)); }

async function send(ixs, signers=[]) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = ADMIN.publicKey;
  tx.recentBlockhash = (await CONN.getLatestBlockhash()).blockhash;
  const sig = await sendAndConfirmTransaction(CONN, tx, [ADMIN, ...signers], { commitment: "confirmed" });
  console.log(`  ok: ${sig}`);
  return sig;
}

// ── 1. Create USDC mint (6 decimals, admin as mint authority) ──
console.log("\n1. Create USDC mint...");
const USDC = await createMint(CONN, ADMIN, ADMIN.publicKey, null, 6, undefined, { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
console.log(`  USDC_MINT=${USDC.toBase58()}`);

// ── 2. init_registry (with quote_mint = USDC) ──
console.log("\n2. init_registry...");
const [REGISTRY] = PublicKey.findProgramAddressSync([Buffer.from("mm_registry")], PROG);
const regDisc = await disc("init_registry");
const regData = Buffer.alloc(regDisc.length + 32);
Buffer.from(regDisc).copy(regData, 0);
USDC.toBuffer().copy(regData, regDisc.length);
await send([new TransactionInstruction({ programId: PROG, data: regData,
  keys: [
    {pubkey: ADMIN.publicKey, isSigner: true, isWritable: true},
    {pubkey: REGISTRY, isSigner: false, isWritable: true},
    {pubkey: SystemProgram.programId, isSigner: false, isWritable: false},
  ]})]);
console.log(`  REGISTRY=${REGISTRY.toBase58()}`);

// ── 3. register_mm ──
console.log("\n3. register_mm...");
const mmAuth = Keypair.generate();
const mmSigner = Keypair.generate();
const [MM] = PublicKey.findProgramAddressSync([Buffer.from("mm"), mmAuth.publicKey.toBuffer()], PROG);
const mmVault = await getAssociatedTokenAddress(USDC, MM, true);

// Fund mmAuth with rent SOL
await send([SystemProgram.transfer({ fromPubkey: ADMIN.publicKey, toPubkey: mmAuth.publicKey, lamports: 50_000_000 })]);

const regMmDisc = await disc("register_mm");
const regMmData = Buffer.alloc(regMmDisc.length + 32);
Buffer.from(regMmDisc).copy(regMmData, 0);
mmSigner.publicKey.toBuffer().copy(regMmData, regMmDisc.length);
await send([new TransactionInstruction({ programId: PROG, data: regMmData,
  keys: [
    {pubkey: mmAuth.publicKey, isSigner: true, isWritable: true},
    {pubkey: REGISTRY, isSigner: false, isWritable: true},
    {pubkey: MM, isSigner: false, isWritable: true},
    {pubkey: mmVault, isSigner: false, isWritable: true},
    {pubkey: USDC, isSigner: false, isWritable: false},
    {pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false},
    {pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false},
    {pubkey: SystemProgram.programId, isSigner: false, isWritable: false},
  ]})], [mmAuth]);

// Save MM keys for bot
const quoteHex = Buffer.from(mmSigner.secretKey).toString("hex");
const authB58 = bs58.encode(mmAuth.secretKey);
console.log(`  MM=${MM.toBase58()}`);
console.log(`  MM auth=${mmAuth.publicKey.toBase58()}`);
console.log(`  Vault=${mmVault.toBase58()}`);
console.log(`  Quote signer hex = ${quoteHex}`);

// Fund MM vault with 500K USDC (mint directly to vault ATA)
console.log("\n4. Fund MM vault...");
await mintTo(CONN, ADMIN, USDC, mmVault, ADMIN.publicKey, 500_000_000_000n, [], { commitment: "confirmed" });
console.log("  Funded MM vault with 500K USDC");

// ── 5. init_price_feed USD/IDR ──
console.log("\n5. init_price_feed...");
const sym = Buffer.alloc(8); Buffer.from("USD/IDR").copy(sym);
const [PF] = PublicKey.findProgramAddressSync([Buffer.from("price_feed"), sym], PROG);
const pfDisc = await disc("init_price_feed");
const pfData = Buffer.alloc(pfDisc.length + 8);
Buffer.from(pfDisc).copy(pfData, 0); sym.copy(pfData, pfDisc.length);
await send([new TransactionInstruction({ programId: PROG, data: pfData,
  keys: [
    {pubkey: ADMIN.publicKey, isSigner: true, isWritable: true},
    {pubkey: REGISTRY, isSigner: false, isWritable: false},
    {pubkey: PF, isSigner: false, isWritable: true},
    {pubkey: SystemProgram.programId, isSigner: false, isWritable: false},
  ]})]);
console.log(`  PRICE_FEED=${PF.toBase58()}`);

// ── 6. init_market PUT + CALL (USD/IDR 30d) ──
console.log("\n6. init_markets...");
const t30 = 60 * 60 * 24 * 30;
const tBuf = Buffer.alloc(4); tBuf.writeUInt32LE(t30);
for (const kind of [0, 1]) {
  const kindBuf = Buffer.from([kind]);
  const [MKT] = PublicKey.findProgramAddressSync([Buffer.from("market"), sym, tBuf, kindBuf], PROG);
  const mkDisc = await disc("init_market");
  const mkData = Buffer.alloc(mkDisc.length + 8 + 4 + 8 + 8 + 1);
  Buffer.from(mkDisc).copy(mkData, 0); sym.copy(mkData, mkDisc.length);
  mkData.writeUInt32LE(t30, mkDisc.length + 8);
  const MIN = 10_000_000n;
  const MAX = 500_000_000_000n;
  mkData.writeBigUInt64LE(MIN, mkDisc.length + 12);
  mkData.writeBigUInt64LE(MAX, mkDisc.length + 20);
  mkData.writeUInt8(kind, mkDisc.length + 28);
  await send([new TransactionInstruction({ programId: PROG, data: mkData,
    keys: [
      {pubkey: ADMIN.publicKey, isSigner: true, isWritable: true},
      {pubkey: REGISTRY, isSigner: false, isWritable: false},
      {pubkey: PF, isSigner: false, isWritable: false},
      {pubkey: MKT, isSigner: false, isWritable: true},
      {pubkey: SystemProgram.programId, isSigner: false, isWritable: false},
    ]})]);
  console.log(`  ${kind === 0 ? "PUT" : "CALL"} market=${MKT.toBase58()}`);
}

// ── 7. update_price (16,000 IDR/USD, exponent -2) ──
console.log("\n7. update_price...");
const upDisc = await disc("update_price");
const upData = Buffer.alloc(upDisc.length + 8 + 4);
Buffer.from(upDisc).copy(upData, 0);
upData.writeBigInt64LE(1_600_000n, upDisc.length);
upData.writeInt32LE(-2, upDisc.length + 8);
await send([new TransactionInstruction({ programId: PROG, data: upData,
  keys: [
    {pubkey: ADMIN.publicKey, isSigner: true, isWritable: false},
    {pubkey: PF, isSigner: false, isWritable: true},
  ]})]);

// Write env file for bot
writeFileSync("/tmp/kodrat-devnet.env", [
  `MM_SIGNER_PRIVATE_KEY_HEX=${quoteHex}`,
  `MM_AUTH_B58=${authB58}`,
  `SOLANA_RPC_URL=${RPC}`,
  `PROGRAM_ID=${PROG.toBase58()}`,
  `USDC_MINT=${USDC.toBase58()}`,
].join("\n"));

console.log("\n=== DEVNET SETUP COMPLETE ===");
console.log(`PROGRAM_ID  = ${PROG.toBase58()}`);
console.log(`USDC_MINT   = ${USDC.toBase58()}`);
console.log(`REGISTRY    = ${REGISTRY.toBase58()}`);
console.log(`MM          = ${MM.toBase58()}`);
console.log(`PRICE_FEED  = ${PF.toBase58()}`);
console.log(`\nEnv saved to /tmp/kodrat-devnet.env`);
