import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { readFileSync } from "fs";

const CONN = new Connection("https://api.devnet.solana.com", "confirmed");
const ADMIN = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/home/fahrul/.config/solana/id.json","utf8"))));
const USDC = new PublicKey("HaeZjxpic6AWcd6aS2TfLzHXq1c4qFegR6WMd5aH5CRv");
const TO = new PublicKey("9U21GjxByD6RAHb5uoD7z56LwgH223TJ65Pk1wUS7Xc6");

const ata = await getOrCreateAssociatedTokenAccount(CONN, ADMIN, USDC, TO);
console.log("ATA:", ata.address.toBase58());
const amt = 50_000_000_000n; // $50K USDC
const sig = await mintTo(CONN, ADMIN, USDC, ata.address, ADMIN.publicKey, amt);
console.log("Sent 50,000 USDC:", sig);
