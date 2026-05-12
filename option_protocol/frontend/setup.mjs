import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, Keypair, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import { readFileSync } from "fs";

const CONN = new Connection("http://localhost:8899", "confirmed");
const ADMIN = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/home/fahrul/.config/solana/id.json","utf8"))));
const PROG = new PublicKey("H5yv1n2BMwPXgVGYA9Rewz4PQFx7p3RDpbZgBajoiULY");
const USDC = new PublicKey("ETXJSj32H2QZnJUUyoDMVWHcMM5ZTedx2gE8rBhJyt3");

async function sha256(s) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
async function disc(n) { return Buffer.from((await sha256(`global:${n}`)).slice(0,8)); }

async function send(ixs, signers=[]) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = ADMIN.publicKey; tx.recentBlockhash = (await CONN.getLatestBlockhash()).blockhash;
  const sig = await sendAndConfirmTransaction(CONN, tx, [ADMIN, ...signers]);
  console.log(`  ok ${sig.slice(0,44)}`);
}

const [REGISTRY] = PublicKey.findProgramAddressSync([Buffer.from("mm_registry")], PROG);

// 1. init_registry
console.log("init_registry");
const regDisc = await disc("init_registry");
const regData = Buffer.alloc(regDisc.length + 32);
Buffer.from(regDisc).copy(regData, 0);
USDC.toBuffer().copy(regData, regDisc.length);
await send([new TransactionInstruction({ programId: PROG, data: regData,
  keys: [
    {pubkey:ADMIN.publicKey, isSigner:true, isWritable:true},
    {pubkey:REGISTRY, isSigner:false, isWritable:true},
    {pubkey:SystemProgram.programId, isSigner:false, isWritable:false},
  ]})]);

// 2. register_mm
console.log("register_mm");
const mmAuth = Keypair.generate();
const mmSigner = Keypair.generate();
const [MM] = PublicKey.findProgramAddressSync([Buffer.from("mm"), mmAuth.publicKey.toBuffer()], PROG);
const mmVault = await getAssociatedTokenAddress(USDC, MM, true);
await CONN.requestAirdrop(mmAuth.publicKey, 5_000_000_000);
await new Promise(r=>setTimeout(r,800));

const regDisc = await disc("register_mm");
const regData = Buffer.alloc(regDisc.length + 32);
regDisc.copy(regData);
mmSigner.publicKey.toBuffer().copy(regData, regDisc.length);
await send([new TransactionInstruction({ programId: PROG, data: regData,
  keys: [
    {pubkey:mmAuth.publicKey, isSigner:true, isWritable:true},
    {pubkey:REGISTRY, isSigner:false, isWritable:true},
    {pubkey:MM, isSigner:false, isWritable:true},
    {pubkey:mmVault, isSigner:false, isWritable:true},
    {pubkey:USDC, isSigner:false, isWritable:false},
    {pubkey:TOKEN_PROGRAM_ID, isSigner:false, isWritable:false},
    {pubkey:ASSOCIATED_TOKEN_PROGRAM_ID, isSigner:false, isWritable:false},
    {pubkey:SystemProgram.programId, isSigner:false, isWritable:false},
  ]})], [mmAuth]);

// Save MM keys
const quoteHex = Buffer.from(mmSigner.secretKey).toString("hex");
const authB58 = bs58.encode(mmAuth.secretKey);
console.log(`  MM pubkey: ${MM.toBase58()}`);
console.log(`  Vault: ${mmVault.toBase58()}`);
console.log(`  Quote signer hex: ${quoteHex}`);
console.log(`  MM auth b58: ${authB58}`);

// Fund vault
const adminAta = await getAssociatedTokenAddress(USDC, ADMIN.publicKey, false);

// 3. init_price_feed USD/IDR
console.log("init_price_feed");
const sym = Buffer.alloc(8);
Buffer.from("USD/IDR").copy(sym);
const [PF] = PublicKey.findProgramAddressSync([Buffer.from("price_feed"), sym], PROG);
const pfDisc = await disc("init_price_feed");
const pfData = Buffer.alloc(pfDisc.length + 8);
pfDisc.copy(pfData); sym.copy(pfData, pfDisc.length);
await send([new TransactionInstruction({ programId: PROG, data: pfData,
  keys: [
    {pubkey:ADMIN.publicKey, isSigner:true, isWritable:true},
    {pubkey:REGISTRY, isSigner:false, isWritable:false},
    {pubkey:PF, isSigner:false, isWritable:true},
    {pubkey:SystemProgram.programId, isSigner:false, isWritable:false},
  ]})]);

// 4. init_market USD/IDR 30d
console.log("init_market");
const t30 = 60*60*24*30;
const tBuf = Buffer.alloc(4); tBuf.writeUInt32LE(t30);
const MKS = [];
for (const kind of [0, 1]) {
  const kindBuf = Buffer.from([kind]);
  const [MKT] = PublicKey.findProgramAddressSync([Buffer.from("market"), sym, tBuf, kindBuf], PROG);
  const mkDisc = await disc("init_market");
  const mkData = Buffer.alloc(mkDisc.length + 8 + 4 + 1 + 8 + 8);
  mkDisc.copy(mkData); sym.copy(mkData, mkDisc.length);
  mkData.writeUInt32LE(t30, mkDisc.length + 8);
  mkData.writeUInt8(kind, mkDisc.length + 12);
  mkData.writeBigUInt64LE(10_000_000n, mkDisc.length + 13);
  mkData.writeBigUInt64LE(500_000_000_000n, mkDisc.length + 21);
  await send([new TransactionInstruction({ programId: PROG, data: mkData,
    keys: [
      {pubkey:ADMIN.publicKey, isSigner:true, isWritable:true},
      {pubkey:REGISTRY, isSigner:false, isWritable:false},
      {pubkey:PF, isSigner:false, isWritable:false},
      {pubkey:MKT, isSigner:false, isWritable:true},
      {pubkey:SystemProgram.programId, isSigner:false, isWritable:false},
    ]})]);
  MKS.push(MKT);
  console.log(`  init_market kind=${kind} => ${MKT.toBase58()}`);
}
await send([new TransactionInstruction({ programId: PROG, data: mkData,
  keys: [
    {pubkey:ADMIN.publicKey, isSigner:true, isWritable:true},
    {pubkey:REGISTRY, isSigner:false, isWritable:false},
    {pubkey:PF, isSigner:false, isWritable:false},
    {pubkey:MKT, isSigner:false, isWritable:true},
    {pubkey:SystemProgram.programId, isSigner:false, isWritable:false},
  ]})]);

// 5. update_price 16000
console.log("update_price");
const upDisc = await disc("update_price");
const upData = Buffer.alloc(upDisc.length + 8 + 4);
upDisc.copy(upData);
upData.writeBigInt64LE(1_600_000n, upDisc.length);
upData.writeInt32LE(-2, upDisc.length + 8);
await send([new TransactionInstruction({ programId: PROG, data: upData,
  keys: [
    {pubkey:ADMIN.publicKey, isSigner:true, isWritable:false},
    {pubkey:PF, isSigner:false, isWritable:true},
  ]})]);

console.log("\n=== Done ===");
console.log(`PROGRAM_ID=${PROG.toBase58()}`);
console.log(`USDC_MINT=${USDC.toBase58()}`);
console.log(`REGISTRY=${REGISTRY.toBase58()}`);
console.log(`MM=${MM.toBase58()}`);
console.log(`PRICE_FEED=${PF.toBase58()}`);
console.log(`MARKET_PUT=${MKS[0].toBase58()}`);
console.log(`MARKET_CALL=${MKS[1].toBase58()}`);
