import bs58 from "bs58";

// ── DOM helpers ──
export const $ = (sel, parent = document) => parent.querySelector(sel);
export const $$ = (sel, parent = document) => [...parent.querySelectorAll(sel)];

// ── Formatters ──
export function fmtUSDC(lamports) {
  return (Number(lamports) / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtUSD(amount, opts = {}) {
  const n = Number(amount);
  const min = opts.cents ? 2 : 0;
  const max = opts.cents ? 2 : 0;
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
}

export function fmtIDR(amount, opts = {}) {
  const n = Number(amount);
  const fd = opts.decimals ?? 0;
  return "Rp " + n.toLocaleString("en-US", { minimumFractionDigits: fd, maximumFractionDigits: fd });
}

export function fmtJPY(amount, opts = {}) {
  const n = Number(amount);
  const fd = opts.decimals ?? 0;
  return "¥" + n.toLocaleString("ja-JP", { minimumFractionDigits: fd, maximumFractionDigits: fd });
}

export function fmtCNY(amount, opts = {}) {
  const n = Number(amount);
  const fd = opts.decimals ?? 2;
  return "¥" + n.toLocaleString("zh-CN", { minimumFractionDigits: fd, maximumFractionDigits: fd });
}

const PAIR_META = {
  usd_idr: { label: "USD / IDR", flag: "🇮🇩", quote: "IDR", base: "USD", quoteSym: "Rp", baseSym: "$" },
  usd_jpy: { label: "USD / JPY", flag: "🇯🇵", quote: "JPY", base: "USD", quoteSym: "¥",  baseSym: "$" },
  jpy_idr: { label: "JPY / IDR", flag: "🇯🇵", quote: "IDR", base: "JPY", quoteSym: "Rp", baseSym: "¥" },
  cny_idr: { label: "CNY / IDR", flag: "🇨🇳", quote: "IDR", base: "CNY", quoteSym: "Rp", baseSym: "¥" },
  cny_usd: { label: "CNY / USD", flag: "🇨🇳", quote: "USD", base: "CNY", quoteSym: "$",  baseSym: "¥" },
};
export function pairMeta(pair) { return PAIR_META[pair] || null; }

export function fmtQuoteCcy(amount, pair, opts = {}) {
  const m = PAIR_META[pair];
  if (!m) return Number(amount).toLocaleString();
  if (m.quote === "IDR") return fmtIDR(amount, opts);
  if (m.quote === "JPY") return fmtJPY(amount, opts);
  if (m.quote === "USD") return fmtUSD(amount, { cents: true, ...opts });
  if (m.quote === "CNY") return fmtCNY(amount, opts);
  return Number(amount).toLocaleString();
}

export function fmtBaseCcy(amount, pair, opts = {}) {
  const m = PAIR_META[pair];
  if (!m) return Number(amount).toLocaleString();
  if (m.base === "USD") return fmtUSD(amount, { cents: true, ...opts });
  if (m.base === "JPY") return fmtJPY(amount, opts);
  if (m.base === "IDR") return fmtIDR(amount, opts);
  if (m.base === "CNY") return fmtCNY(amount, opts);
  return Number(amount).toLocaleString();
}

export function fmtPair(pair) { return PAIR_META[pair]?.label || pair; }
export function fmtPairFlag(pair) { return PAIR_META[pair]?.flag || ""; }

export function fmtPct(decimal, decimals = 2) {
  return (decimal * 100).toFixed(decimals) + "%";
}

export function fmtDate(ts) {
  return new Date(Number(ts) * 1000).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

export function fmtRelativeDays(unixTs) {
  const diff = Number(unixTs) - Math.floor(Date.now() / 1000);
  if (diff <= 0) return "Past due";
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  if (days > 0) return `in ${days} ${days === 1 ? "day" : "days"}`;
  if (hours > 0) return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const mins = Math.floor(diff / 60);
  return `in ${mins} ${mins === 1 ? "minute" : "minutes"}`;
}

export function fmtCountdown(seconds) {
  if (seconds <= 0) return "Expired";
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── Payoff math (mirrors on-chain put_payout_usdc / call_payout_usdc) ──
export function computePayout(kind, strike, spot, notionalUsdc) {
  if (strike <= 0 || spot < 0) return 0;
  const isPut = kind === 0;
  const itm = isPut ? strike > spot : spot > strike;
  if (!itm) return 0;
  const diff = isPut ? strike - spot : spot - strike;
  return Math.floor((diff * notionalUsdc) / strike);
}

// Scenarios for quote preview. Returns 3 rows with computed spot + payout.
export function buildScenarios(kind, strike, currentSpot, notionalUsdc) {
  const isPut = kind === 0;
  const ref = currentSpot || strike;
  const moves = isPut
    ? [-0.05, 0, +0.03] // put: down (ITM), flat (ATM), up (OTM)
    : [+0.05, 0, -0.03]; // call: up (ITM), flat, down (OTM)
  return moves.map(pct => {
    const spot = Math.round(ref * (1 + pct));
    const payout = computePayout(kind, strike, spot, notionalUsdc);
    const isItm = payout > 0;
    return { pct, spot, payout, isItm };
  });
}

// ── Toast ──
export function toast(msg, type = "info") {
  const icons = { info: "ℹ️", ok: "✅", err: "❌" };
  const container = $("#toast-container");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type]}</span>${msg}`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0"; el.style.transform = "translateX(40px)"; el.style.transition = "all .3s ease";
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// ── Skeleton ──
export function showSkeleton(container) {
  container.innerHTML = `<div class="skeleton"><div class="skeleton-row"></div><div class="skeleton-row short"></div><div class="skeleton-row"></div></div>`;
}

// ── SHA-256 ──
export async function sha256(data) {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return new Uint8Array(hash);
}

export async function discriminator(name) {
  return (await sha256(`global:${name}`)).slice(0, 8);
}

// ── Borsh ──
export function serializeSignedQuote(q) {
  const buyerBytes = bs58.decode(q.buyer);
  const signerBytes = bs58.decode(q.mm_quote_signer);
  const marketBytes = bs58.decode(q.market);
  const arr = new Uint8Array(32 + 32 + 32 + 8 + 4 + 8 + 8 + 8 + 8 + 8);
  let off = 0;
  arr.set(buyerBytes, off); off += 32;
  arr.set(signerBytes, off); off += 32;
  arr.set(marketBytes, off); off += 32;
  const dvv = new DataView(arr.buffer);
  dvv.setBigInt64(off, BigInt(q.strike), true); off += 8;
  dvv.setInt32(off, q.strike_exponent, true); off += 4;
  dvv.setBigUint64(off, BigInt(q.notional), true); off += 8;
  dvv.setBigUint64(off, BigInt(q.premium), true); off += 8;
  dvv.setBigInt64(off, BigInt(q.expiry), true); off += 8;
  dvv.setBigUint64(off, BigInt(q.quote_nonce), true); off += 8;
  dvv.setBigInt64(off, BigInt(q.valid_until), true);
  return arr;
}

// ── Parsers ──
export function parseQuoteFromPayload(payloadB64) {
  const raw = Uint8Array.from(atob(payloadB64), c => c.charCodeAt(0));
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const off = 32 + 32 + 32; // skip buyer + mm_quote_signer + market
  const strikeRaw = dv.getBigInt64(off, true);
  const expRaw = dv.getInt32(off + 8, true);
  const notionalRaw = dv.getBigUint64(off + 8 + 4, true);
  const premiumRaw = dv.getBigUint64(off + 8 + 4 + 8, true);
  const expiryRaw = dv.getBigInt64(off + 8 + 4 + 8 + 8, true);
  const validRaw = dv.getBigInt64(off + 8 + 4 + 8 + 8 + 8 + 8, true);
  const strikeFloat = Number(strikeRaw) * Math.pow(10, expRaw);
  return {
    strikeRaw: Number(strikeRaw),
    strikeExponent: expRaw,
    strikeFloat,
    strike: strikeFloat.toLocaleString("en-US", { minimumFractionDigits: 2 }),
    notional: Number(notionalRaw),
    premium: Number(premiumRaw),
    expiry: Number(expiryRaw),
    valid_until: Number(validRaw),
  };
}

// Parse PriceFeed account: discriminator(8) + authority(32) + symbol(8) + price(8) + exponent(4) + updated_at(8) + bump(1)
export function parsePriceFeed(data) {
  if (data.length < 8 + 32 + 8 + 8 + 4 + 8 + 1) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const off = 8 + 32 + 8;
  const price = Number(dv.getBigInt64(off, true));
  const exponent = dv.getInt32(off + 8, true);
  const updatedAt = Number(dv.getBigInt64(off + 8 + 4, true));
  return { price, exponent, updatedAt, priceFloat: price * Math.pow(10, exponent) };
}

// Parse OptionPosition fully
// Layout: disc(8) buyer(32) mm(32) market(32) strike(i64,8) strike_exp(i32,4)
//   notional(u64,8) premium(u64,8) expiry(i64,8) quote_nonce(u64,8) status(u8,1)
//   created_at(i64,8) payout(u64,8) settled_at(i64,8) bump(u8,1)
export function parsePositionFull(data) {
  if (data.length < 100) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = 8;
  off += 32; // buyer
  const mmBytes = data.slice(off, off + 32); off += 32;
  const marketBytes = data.slice(off, off + 32); off += 32;
  const strikeRaw = Number(dv.getBigInt64(off, true)); off += 8;
  const strikeExponent = dv.getInt32(off, true); off += 4;
  const notional = Number(dv.getBigUint64(off, true)); off += 8;
  const premium = Number(dv.getBigUint64(off, true)); off += 8;
  const expiry = Number(dv.getBigInt64(off, true)); off += 8;
  off += 8; // quote_nonce
  const status = data[off]; off += 1;
  off += 8; // created_at
  const payout = Number(dv.getBigUint64(off, true)); off += 8;
  const settledAt = Number(dv.getBigInt64(off, true));
  return {
    mmBytes, marketBytes,
    strikeRaw, strikeExponent, strikeFloat: strikeRaw * Math.pow(10, strikeExponent),
    notional, premium, expiry, status, payout, settledAt,
  };
}

export function parsePosition(data) {
  if (data.length < 100) return { notional: 0, premium: 0, expiry: 0, status: 0, payout: 0 };
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const base = 8;
  const sz = data.length;
  const readBig = (off) => (off + 8 <= sz) ? dv.getBigUint64(off, true) : 0n;
  const notional = readBig(base + 32 + 32 + 32 + 8 + 4);
  const premium  = readBig(base + 32 + 32 + 32 + 8 + 4 + 8);
  const expiry   = (base + 32 + 32 + 32 + 8 + 4 + 8 + 8 + 8 <= sz) ? Number(dv.getBigInt64(base + 32 + 32 + 32 + 8 + 4 + 8 + 8, true)) : 0;
  const status   = data[base + 32 + 32 + 32 + 8 + 4 + 8 + 8 + 8 + 8];
  const payout   = readBig(base + 32 + 32 + 32 + 8 + 4 + 8 + 8 + 8 + 8 + 1 + 8);
  return { notional: Number(notional), premium: Number(premium), expiry, status, payout: Number(payout) };
}
