// setup-localnet.js — run with: node setup-localnet.js
// Initializes all protocol state on localnet
import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, Keypair, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";

const CONNECTION = new Connection("http://localhost:8899", "confirmed");
const ADMIN = loadKeypair("/home/fahrul/.config/solana/id.json");
const PROGRAM_ID = new PublicKey("H5yv1n2BMwPXgVGYA9Rewz4PQFx7p3RDpbZgBajoiULY");
const USDC_MINT = new PublicKey("Db4jLHMDxu5jGuTxZRDcmszcxB7fUrU1TdqmccwM4isD");

function loadKeypair(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(require("fs").readFileSync(path, "utf8"))));
}

async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data)));
}

async function discriminator(name) {
  return Buffer.from((await sha256(`global:${name}`)).slice(0, 8));
}

async function sendIx(ixs, signers = []) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = ADMIN.publicKey;
  tx.recentBlockhash = (await CONNECTION.getLatestBlockhash()).blockhash;
  const allSigners = [ADMIN, ...signers];
  const sig = await sendAndConfirmTransaction(CONNECTION, tx, allSigners);
  console.log(`  ✓ ${sig.slice(0, 44)}...`);
}

async function main() {
  console.log("=== Kodrat Localnet Setup ===\n");

  // 1. Fund admin with SOL (just in case)
  const airdropSig = await CONNECTION.requestAirdrop(ADMIN.publicKey, 10_000_000_000);
  await CONNECTION.confirmTransaction(airdropSig);
  console.log("✓ SOL airdropped to admin");

  // 2. Create admin ATA + mint USDC
  const adminAta = await getAssociatedTokenAddress(USDC_MINT, ADMIN.publicKey, false);
  try {
    await sendIx([createAssociatedTokenAccountInstruction(ADMIN.publicKey, adminAta, ADMIN.publicKey, USDC_MINT)]);
    console.log("✓ Admin ATA created");
  } catch {}

  // Mint USDC to admin
  const { mintTo } = await import("./node_modules/@solana/spl-token/lib/esm/index.js");
  try {
    await sendIx([mintTo(USDC_MINT, adminAta, ADMIN.publicKey, 1_000_000_000_000n)]); // 1M USDC
    console.log("✓ 1M USDC minted to admin");
  } catch (e) { console.log("  skip mint:", e.message); }

  // 3. Init Registry
  console.log("\n→ init_registry");
  const [registry] = PublicKey.findProgramAddressSync([Buffer.from("mm_registry")], PROGRAM_ID);
  const initRegDisc = await discriminator("init_registry");
  const regData = Buffer.alloc(initRegDisc.length + 32);
  Buffer.from(initRegDisc).copy(regData, 0);
  USDC_MINT.toBuffer().copy(regData, initRegDisc.length);
  await sendIx([new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: ADMIN.publicKey, isSigner: true, isWritable: true },
      { pubkey: registry, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: regData,
  })]);

  // 4. Generate MM signer keypair and Register MM
  console.log("→ register_mm");
  const mmAuthority = Keypair.generate();
  const mmQuoteSigner = Keypair.generate();
  const [mm] = PublicKey.findProgramAddressSync([Buffer.from("mm"), mmAuthority.pubKey.toBuffer()], PROGRAM_ID);
  const mmVault = await getAssociatedTokenAddress(USDC_MINT, mm, true);

  // Fund mmAuthority with SOL
  await CONNECTION.requestAirdrop(mmAuthority.publicKey, 10_000_000_000);
  await new Promise(r => setTimeout(r, 1000));

  const regMmDisc = await discriminator("register_mm");
  const regMmIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: mmAuthority.publicKey, isSigner: true, isWritable: true },
      { pubkey: registry, isSigner: false, isWritable: true },
      { pubkey: mm, isSigner: false, isWritable: true },
      { pubkey: mmVault, isSigner: false, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from(regMmDisc), mmQuoteSigner.publicKey.toBuffer()]),
  });
  await sendIx([regMmIx], [mmAuthority]);

  // Save MM keys
  const mmKeys = {
    mm_authority: bs58.encode(mmAuthority.secretKey),
    mm_quote_signer: bs58.encode(mmQuoteSigner.secretKey),
  };
  const fs = await import("fs");
  fs.writeFileSync("mm_keys.json", JSON.stringify(mmKeys, null, 2));
  console.log(`  MM keys saved to mm_keys.json`);
  console.log(`  MM authority: ${mmAuthority.publicKey.toBase58()}`);
  console.log(`  MM quote signer: ${mmQuoteSigner.publicKey.toBase58()}`);

  // Fund MM vault with USDC
  try {
    const mintToFn = (await import("./node_modules/@solana/spl-token/lib/esm/index.js")).mintTo;
    await sendIx([mintToFn(USDC_MINT, mmVault, ADMIN.publicKey, 500_000_000_000n)]);
    console.log("✓ 500K USDC minted to MM vault");
  } catch (e) { console.log("  skip MM mint:", e.message); }

  // 5. Init Price Feed (USD/IDR)
  console.log("→ init_price_feed");
  const usdIdrSym = Buffer.from("USD/IDR");
  const symPadded = Buffer.alloc(8);
  usdIdrSym.copy(symPadded);
  const [priceFeed] = PublicKey.findProgramAddressSync([Buffer.from("price_feed"), symPadded], PROGRAM_ID);
  const initPfDisc = await discriminator("init_price_feed");
  await sendIx([new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: ADMIN.publicKey, isSigner: true, isWritable: true },
      { pubkey: registry, isSigner: false, isWritable: false },
      { pubkey: priceFeed, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from(initPfDisc), symPadded]),
  })]);

  // 6. Init Markets (USD/IDR 30d) — PUT and CALL
  console.log("→ init_market");
  const ten30d = 60 * 60 * 24 * 30;
  const tenorBuf = Buffer.alloc(4);
  tenorBuf.writeUInt32LE(ten30d);
  for (const kind of [0, 1]) {
    const kindBuf = Buffer.from([kind]);
    const [market] = PublicKey.findProgramAddressSync([Buffer.from("market"), symPadded, tenorBuf, kindBuf], PROGRAM_ID);
    const initMkDisc = await discriminator("init_market");
    const mkArgs = Buffer.alloc(8 + 4 + 1 + 8 + 8);
    symPadded.copy(mkArgs, 0);
    mkArgs.writeUInt32LE(ten30d, 8);
    mkArgs.writeUInt8(kind, 12);
    mkArgs.writeBigUInt64LE(BigInt(10_000_000), 13);
    mkArgs.writeBigUInt64LE(BigInt(500_000_000_000), 21);
    await sendIx([new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: ADMIN.publicKey, isSigner: true, isWritable: true },
        { pubkey: registry, isSigner: false, isWritable: false },
        { pubkey: priceFeed, isSigner: false, isWritable: false },
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from(initMkDisc), mkArgs]),
    })]);
    console.log(`  init_market kind=${kind === 0 ? "PUT" : "CALL"} => ${market.toBase58()}`);
  }

  // 7. Update Price (16,000 IDR/USD)
  console.log("→ update_price");
  const upDisc = await discriminator("update_price");
  const priceArgs = Buffer.alloc(8 + 4);
  priceArgs.writeBigInt64LE(BigInt(1_600_000), 0);
  priceArgs.writeInt32LE(-2, 8);
  await sendIx([new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: ADMIN.publicKey, isSigner: true, isWritable: false },
      { pubkey: priceFeed, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([Buffer.from(upDisc), priceArgs]),
  })]);

  console.log("\n=== Setup Complete ===");
  console.log(`USDC_MINT=${USDC_MINT.toBase58()}`);
  console.log(`REGISTRY=${registry.toBase58()}`);
  console.log(`MM=${mm.toBase58()}`);
  console.log(`PRICE_FEED=${priceFeed.toBase58()}`);
  console.log(`MARKET (PUT)=${market.toBase58()}`);
  console.log(`PROGRAM_ID=${PROGRAM_ID.toBase58()}`);
  console.log("\nRun the bot:");
  console.log(`  cd bot && MM_SIGNER_PRIVATE_KEY_HEX=${bs58.encode(mmQuoteSigner.secretKey).slice(0, 64)} SOLANA_RPC_URL=http://localhost:8899 cargo run`);
  console.log("\nRun the frontend:");
  console.log("  cd frontend && npm run dev");
}

main().catch(e => { console.error(e); process.exit(1); });
