import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { readFileSync } from "fs";

const CONN = new Connection("https://api.devnet.solana.com", "confirmed");
const ADMIN = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/home/fahrul/.config/solana/id.json","utf8"))));
const USDC = new PublicKey("HaeZjxpic6AWcd6aS2TfLzHXq1c4qFegR6WMd5aH5CRv");

const ata = await getOrCreateAssociatedTokenAccount(CONN, ADMIN, USDC, ADMIN.publicKey);
console.log("Buyer ATA:", ata.address.toBase58());
const sig = await mintTo(CONN, ADMIN, USDC, ata.address, ADMIN.publicKey, 50_000_000_000n);
console.log("Funded 50K USDC:", sig);
