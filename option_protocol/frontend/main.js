import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import {
  $, $$, fmtUSDC, fmtUSD, fmtIDR, fmtJPY, fmtCNY, fmtQuoteCcy, fmtBaseCcy, fmtPair, fmtPairFlag, fmtPct,
  fmtDate, fmtRelativeDays, fmtCountdown, toast, showSkeleton, sha256, discriminator,
  serializeSignedQuote, parseQuoteFromPayload, parsePosition, parsePositionFull, parsePriceFeed,
  computePayout, buildScenarios, pairMeta,
} from "./utils.js";

// ── Constants ──
const PROGRAM_ID = new PublicKey("H5yv1n2BMwPXgVGYA9Rewz4PQFx7p3RDpbZgBajoiULY");
const ED25519_PROGRAM_ID = new PublicKey("Ed25519SigVerify111111111111111111111111111");
const USDC_MINT = new PublicKey("HaeZjxpic6AWcd6aS2TfLzHXq1c4qFegR6WMd5aH5CRv");
const BOT_URL = "http://localhost:8787";
const CONNECTION = new Connection("https://api.devnet.solana.com", "confirmed");
// Raw bytes for Sysvar1nstructions — zero ambiguity, not a string parse
const INSTRUCTIONS_ID = new PublicKey(new Uint8Array([
  6, 167, 213, 23, 24, 123, 209, 102, 53, 218, 212, 4, 85, 253, 194, 192,
  193, 36, 198, 143, 33, 86, 117, 165, 219, 186, 203, 95, 8, 0, 0, 0
]));

console.log("🚀 Kodrat — Instructions sysvar:", INSTRUCTIONS_ID.toBase58());

// ── Market index: precompute marketPDA + priceFeedPDA for all pair × tenor combos ──
// Each pair has: code, symbol (8-byte PDA seed), base/quote ISO, flag asset
const PAIR_DEFS = [
  { code: "usd_idr", symbol: "USD/IDR", base: "USD", quote: "IDR", flag: "Indonesia.jpg", flagBase: "usa.jpg" },
  { code: "usd_jpy", symbol: "USD/JPY", base: "USD", quote: "JPY", flag: "Japan.jpg",     flagBase: "usa.jpg" },
  { code: "jpy_idr", symbol: "JPY/IDR", base: "JPY", quote: "IDR", flag: "Indonesia.jpg", flagBase: "Japan.jpg" },
  { code: "cny_idr", symbol: "CNY/IDR", base: "CNY", quote: "IDR", flag: "Indonesia.jpg", flagBase: "China.jpg" },
  { code: "cny_usd", symbol: "CNY/USD", base: "CNY", quote: "USD", flag: "usa.jpg",       flagBase: "China.jpg" },
];
const TENOR_DEFS = [
  { seconds: 604800, label: "7 days" },
  { seconds: 2592000, label: "30 days" },
  { seconds: 5184000, label: "60 days" },
];

function symbolBytes(s) {
  const out = new Uint8Array(8);
  const b = new TextEncoder().encode(s);
  out.set(b.slice(0, 8));
  return out;
}

function tenorLeBytes(t) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(t, 0);
  return buf;
}

const MARKET_INDEX = [];
const FEED_BY_PAIR = {};
for (const p of PAIR_DEFS) {
  const sym = symbolBytes(p.symbol);
  const [feedPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("price_feed"), Buffer.from(sym)],
    PROGRAM_ID
  );
  FEED_BY_PAIR[p.code] = feedPda;
  for (const t of TENOR_DEFS) {
    for (const kind of [0, 1]) {
      const [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), Buffer.from(sym), tenorLeBytes(t.seconds), new Uint8Array([kind])],
        PROGRAM_ID
      );
      MARKET_INDEX.push({
        pair: p.code, symbol: p.symbol, tenor: t.seconds, tenorLabel: t.label,
        marketPda: marketPda.toBase58(), priceFeedPda: feedPda.toBase58(),
        kind,
      });
    }
  }
}

function lookupMarket(marketB58) {
  return MARKET_INDEX.find(m => m.marketPda === marketB58) || null;
}

// ── Reactive State (simple pub/sub) ──
const state = {
  _wallet: null,
  _balance: null,
  _currentQuote: null,
  _quoteSpot: null, // { price, exponent, priceFloat } at quote time
  _spots: {}, // pair_code -> { price, exponent, priceFloat } cached for position rendering
  _positions: [],
  _loading: false,
  _buying: false,
  _ttlInterval: null,
  _mode: localStorage.getItem("kodrat_mode") || "retail",
  _wizard: { step: 1, profile: null, pair: "usd_idr", tenor: 2592000, amountUsd: 5000 },

  get wallet() { return this._wallet; },
  set wallet(v) {
    this._wallet = v;
    renderNav();
    renderQuoteForm();
    renderWalletBanner();
    renderProviderBadge();
    if (v) { loadBalance(); loadPositions(); }
  },

  get balance() { return this._balance; },
  set balance(v) { this._balance = v; renderBalance(); },

  get currentQuote() { return this._currentQuote; },
  set currentQuote(v) {
    this._currentQuote = v;
    if (this._ttlInterval) clearInterval(this._ttlInterval);
    renderQuoteResult();
    if (v) {
      this._ttlInterval = setInterval(renderQuoteTTL, 1000);
      renderQuoteTTL();
    }
  },

  get loading() { return this._loading; },
  set loading(v) { this._loading = v; renderQuoteBtn(); renderWizard(); },

  get buying() { return this._buying; },
  set buying(v) { this._buying = v; renderBuyBtn(); },

  get spots() { return this._spots; },
  set spots(v) { this._spots = v; },

  get positions() { return this._positions; },
  set positions(v) { this._positions = v; renderPositions(); },

  get mode() { return this._mode; },
  set mode(v) {
    this._mode = v;
    localStorage.setItem("kodrat_mode", v);
    renderMode();
  },

  get wizard() { return this._wizard; },
  set wizard(v) { this._wizard = { ...this._wizard, ...v }; renderWizard(); },
};

// ── Wallet ──
// Both Backpack and Phantom inject window.backpack / window.solana
// and implement the same interface: .connect(), .signTransaction(), .disconnect(), etc.
// Ref: https://github.com/anza-xyz/wallet-adapter

function getProvider() {
  // Try each known provider in priority order
  if (window.backpack) return window.backpack;
  if (window.solana) return window.solana;
  if (window.solflare) return window.solflare;
  return null;
}

async function connectWallet() {
  const provider = getProvider();
  console.log("Providers on window:", { backpack: !!window.backpack, solana: !!window.solana, solflare: !!window.solflare });

  if (!provider) {
    toast("No wallet detected. Install Backpack → backpack.app", "err");
    return;
  }

  try {
    // .connect() triggers approval popup in the wallet extension
    const resp = await provider.connect();
    console.log("Raw connect response:", resp);

    // Handle different response formats
    let pkBytes;
    if (resp.publicKey) {
      if (resp.publicKey.toBase58) {
        pkBytes = resp.publicKey; // Already a PublicKey object
      } else if (resp.publicKey.toBytes) {
        pkBytes = new PublicKey(resp.publicKey.toBytes());
      } else if (resp.publicKey instanceof Uint8Array) {
        pkBytes = new PublicKey(resp.publicKey);
      } else if (typeof resp.publicKey === 'string') {
        pkBytes = new PublicKey(resp.publicKey);
      } else {
        pkBytes = new PublicKey(resp.publicKey);
      }
    } else if (resp instanceof Uint8Array) {
      pkBytes = new PublicKey(resp);
    } else {
      throw new Error("Cannot parse public key from response: " + JSON.stringify(Object.keys(resp)));
    }

    console.log("Connected:", pkBytes.toBase58());

    state.wallet = {
      publicKey: pkBytes,
      signTransaction: (tx) => provider.signTransaction(tx),
      signAllTransactions: (txs) => provider.signAllTransactions(txs),
    };
    toast("Wallet connected!", "ok");

    // Listen for disconnect/account change
    provider.on?.("disconnect", () => { state.wallet = null; renderNav(); });
    provider.on?.("accountChanged", () => { state.wallet = null; renderNav(); connectWallet(); });
  } catch (e) {
    console.error("Connect failed:", e?.message || e?.code || e);
    const msg = e?.message || e?.code || e?.toString() || "unknown";
    toast("Failed: " + msg, "err");
  }
}

async function disconnectWallet() {
  const provider = getProvider();
  if (provider) await provider.disconnect();
  state.wallet = null;
  state.balance = null;
  state.positions = [];
}

async function loadBalance() {
  if (!state.wallet) return;
  try {
    const ata = await getAssociatedTokenAddress(USDC_MINT, state.wallet.publicKey, false);
    const info = await CONNECTION.getTokenAccountBalance(ata);
    state.balance = info.value.uiAmount;
  } catch { state.balance = 0; }
}

// ── Render Functions ──
function renderNav() {
  const btn = $("#connect-btn");
  if (!btn) return;
  if (!state.wallet) {
    btn.innerHTML = `<span class="btn-icon">🔌</span><span>Connect Wallet</span>`;
    btn.classList.remove("connected");
    renderProviderBadge();
  } else {
    const pk = state.wallet.publicKey.toBase58();
    btn.innerHTML = `<span class="btn-icon">🟢</span><span>${pk.slice(0,4)}…${pk.slice(-4)}</span>`;
    btn.classList.add("connected");
  }
}

function renderBalance() {
  const el = $("#balance-display");
  if (!el) return;
  if (state.balance !== null && state.balance !== undefined) {
    el.style.display = "flex";
    const ba = $("#balance-amount"); if (ba) ba.textContent = state.balance.toFixed(2);
  } else {
    el.style.display = "none";
  }
}

function renderQuoteForm() {
  const btn = $("#quote-btn");
  if (btn) btn.disabled = !state.wallet || !!state.loading || !validateNotional();
}

function renderWalletBanner() {
  const banner = $("#wallet-banner");
  if (banner) banner.style.display = state.wallet ? "none" : "flex";
}

function validateNotional() {
  const inp = $("#notional");
  const warn = $("#notional-warn");
  if (!inp || !warn) return true;
  const pair = $("#pair")?.value || "usd_idr";
  const baseVal = parseFloat(inp.value || "0");
  const usdEq = baseToUsd(pair, baseVal);
  const min = 10;
  const max = 500000;
  if (isNaN(usdEq) || usdEq < min) {
    warn.textContent = `Minimum notional ${fmtUSD(min)} USDC equivalent`;
    warn.style.display = "flex";
    return false;
  }
  if (usdEq > max) {
    warn.textContent = `Maximum notional ${fmtUSD(max)} USDC per transaction`;
    warn.style.display = "flex";
    return false;
  }
  warn.style.display = "none";
  return true;
}

function renderQuoteBtn() {
  const btn = $("#quote-btn");
  if (!btn) return;
  btn.disabled = !state.wallet || state.loading;
  btn.classList.toggle("is-loading", state.loading);
  const txt = btn.querySelector(".btn-text");
  if (txt) txt.textContent = state.loading ? "Fetching quote…" : "Get Quote";
}

function renderBuyBtn() {
  const btn = $("#buy-btn");
  if (!btn) return;
  btn.classList.toggle("is-loading", state.buying);
  if (state.buying) {
    btn.disabled = true;
    const txt = btn.querySelector(".btn-text");
    if (txt) txt.innerHTML = "Processing…";
  } else {
    btn.disabled = false;
    const q = state.currentQuote?.quote;
    const premium = q ? `${fmtUSDC(q.premium)} USDC` : "";
    const txt = btn.querySelector(".btn-text");
    if (txt) txt.innerHTML = `Buy Option — <span>${premium}</span>`;
  }
}

function renderQuoteResult() {
  const el = $("#quote-result");
  if (!el) return;
  if (!state.currentQuote) {
    el.style.display = "none";
    return;
  }
  el.style.display = "block";
  const q = state.currentQuote;
  const parsed = parseQuoteFromPayload(q.quote.payload_b64);
  const pair = q.pair || $("#pair").value;
  const kind = q.kind ?? parseInt($("#kind")?.value || "0");
  const tenor = q.tenor || parseInt($("#tenor").value);

  // Strike — pair-aware formatting
  const strikeStr = fmtQuoteCcy(parsed.strikeFloat, pair, { decimals: pair === "usd_jpy" ? 2 : 0 });
  const qs = $("#q-strike"); if (qs) qs.textContent = `${strikeStr} / USD`;

  // ATM badge — show only if strike is within 0.5% of current spot
  const atmPill = $("#strike-pill");
  if (atmPill && state.quoteSpot) {
    const diff = Math.abs(parsed.strikeFloat - state.quoteSpot.priceFloat) / state.quoteSpot.priceFloat;
    atmPill.style.display = diff < 0.005 ? "inline-block" : "none";
  }

  // Strike subtitle: comparison to current spot
  const qss = $("#q-strike-sub");
  if (qss) {
    if (state.quoteSpot) {
      const spotStr = fmtQuoteCcy(state.quoteSpot.priceFloat, pair, { decimals: pair === "usd_jpy" ? 2 : 0 });
      qss.textContent = `Spot now: ${spotStr}`;
    } else {
      qss.textContent = "option exercise price";
    }
  }

  // Premium with %
  const qp = $("#q-premium"); if (qp) qp.textContent = `${fmtUSDC(parsed.premium)} USDC`;
  const qps = $("#q-premium-sub");
  if (qps) {
    const pct = parsed.premium / parsed.notional;
    qps.textContent = `${fmtPct(pct, 2)} of notional ${fmtUSD(parsed.notional / 1_000_000)}`;
  }

  // Expiry with relative days
  const qe = $("#q-expiry"); if (qe) qe.textContent = fmtDate(parsed.expiry);
  const qes = $("#q-expiry-sub"); if (qes) qes.textContent = fmtRelativeDays(parsed.expiry);

  // Buy button
  const bp = $("#buy-btn-premium"); if (bp) bp.textContent = `${fmtUSDC(parsed.premium)} USDC`;

  // Scenarios
  renderScenarios(kind, parsed, pair);

  const risk = $("#call-risk-note");
  if (risk) risk.style.display = kind === 1 ? "block" : "none";

  renderBuyBtn();
}

function renderScenarios(kind, parsed, pair) {
  const list = $("#scenarios-list");
  if (!list) return;
  const spotForRef = state.quoteSpot ? state.quoteSpot.priceFloat : parsed.strikeFloat;
  // Use raw scaled values for math correctness, just like on-chain
  const refRaw = state.quoteSpot ? state.quoteSpot.price : parsed.strikeRaw;
  const scenarios = buildScenarios(kind, parsed.strikeRaw, refRaw, parsed.notional);

  const isPut = kind === 0;
  const m = pairMeta(pair);
  const quoteCcy = m?.quote || "quote";
  const labels = isPut
    ? [
        { icon: "🟢", title: `${quoteCcy} strengthens`, change: -0.05 },
        { icon: "⚪", title: "No significant move", change: 0 },
        { icon: "🔴", title: `${quoteCcy} weakens`, change: +0.03 },
      ]
    : [
        { icon: "🟢", title: `${quoteCcy} weakens`, change: +0.05 },
        { icon: "⚪", title: "No significant move", change: 0 },
        { icon: "🔴", title: `${quoteCcy} strengthens`, change: -0.03 },
      ];

  list.innerHTML = scenarios.map((s, i) => {
    const lbl = labels[i];
    const spotFloat = s.spot * Math.pow(10, parsed.strikeExponent);
    const spotStr = fmtQuoteCcy(spotFloat, pair, { decimals: pair === "usd_jpy" ? 2 : 0 });
    const moveTxt = lbl.change === 0 ? "± 0%" : (lbl.change > 0 ? "+" : "") + fmtPct(lbl.change, 1);
    const cls = s.payout > 0 ? "gain" : (i === 2 ? "loss" : "flat");
    const payoutStr = s.payout > 0
      ? `+${fmtUSDC(s.payout)} USDC`
      : (i === 2 ? `−${fmtUSDC(parsed.premium)} USDC` : "0 USDC");
    const subTxt = s.payout > 0
      ? `Option payout`
      : (i === 2 ? `Premium loss` : `No payout`);
    return `
      <div class="scenario-row">
        <span class="scenario-icon">${lbl.icon}</span>
        <span class="scenario-text">
          <strong>${lbl.title}</strong> · ${moveTxt}
          <span class="scenario-sub">${spotStr} / USD · ${subTxt}</span>
        </span>
        <span class="scenario-payout ${cls}">${payoutStr}</span>
      </div>`;
  }).join("");
}

function renderQuoteTTL() {
  if (!state.currentQuote) return;
  const parsed = parseQuoteFromPayload(state.currentQuote.quote.payload_b64);
  const remain = parsed.valid_until - Math.floor(Date.now() / 1000);
  const qt = $("#q-ttl");
  if (qt) {
    qt.textContent = fmtCountdown(Math.max(0, remain));
    qt.classList.remove("q-ttl-warn", "q-ttl-danger");
    if (remain > 0 && remain < 10) qt.classList.add("q-ttl-danger");
    else if (remain > 0 && remain < 30) qt.classList.add("q-ttl-warn");
  }
  if (remain <= 0) {
    state.currentQuote = null;
    toast("Quote expired — please request a new one", "err");
  }
}

function sortPositions(positions) {
  // Active first, then by expiry ascending. Settled at the bottom.
  return [...positions].sort((a, b) => {
    const pa = parsePositionFull(a.account.data) || parsePosition(a.account.data);
    const pb = parsePositionFull(b.account.data) || parsePosition(b.account.data);
    if (pa.status === 0 && pb.status !== 0) return -1;
    if (pa.status !== 0 && pb.status === 0) return 1;
    return pa.expiry - pb.expiry;
  });
}

function renderPositions() {
  const list = $("#positions-list");
  if (!state.wallet) {
    return showSkeleton(list);
  }
  const sorted = sortPositions(state.positions);
  if (sorted.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <h4>No positions yet</h4>
        <p>Buy your first put option to hedge your export revenue. Starts at $1,000 notional.</p>
      </div>`;
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  list.innerHTML = sorted.map(p => {
    const pos = parsePositionFull(p.account.data) || parsePosition(p.account.data);
    const canSettle = pos.status === 0 && now >= pos.expiry;
    const statusMap = {
      0: ["status-open", "Active"],
      1: ["status-exercised", "Exercised"],
      2: ["status-expired", "Expired OTM"],
    };
    const [cls, label] = statusMap[pos.status] || ["status-expired", "?"];

    // Look up market metadata (pair, tenor, kind) from cached MARKET_INDEX
    let pairCode = null, pairLabel = "", tenorLabel = "", posKind = 0;
    if (pos.marketBytes) {
      try {
        const marketB58 = new PublicKey(Buffer.from(pos.marketBytes)).toBase58();
        const mkt = lookupMarket(marketB58);
        if (mkt) { pairCode = mkt.pair; pairLabel = mkt.symbol; tenorLabel = mkt.tenorLabel; posKind = mkt.kind; }
      } catch {}
    }
    const pairBadge = pairLabel ? `<span class="pos-pair-pill">${fmtPairFlag(pairCode)} ${pairLabel}</span>` : "";

    // ITM/OTM live indicator for OPEN positions
    let itmRow = "";
    if (pos.status === 0 && pairCode && state.spots[pairCode] && pos.strikeFloat) {
      const spot = state.spots[pairCode];
      const livePayout = computePayout(posKind, pos.strikeRaw, spot.price, pos.notional);
      const isItm = livePayout > 0;
      const spotStr = fmtQuoteCcy(spot.priceFloat, pairCode, { decimals: pairCode === "usd_jpy" ? 2 : 0 });
      if (isItm) {
        itmRow = `<div class="pos-itm-row itm">
          <span class="pos-itm-icon">🟢</span>
          <span>ITM · spot ${spotStr} → if settled now <strong>+${fmtUSDC(livePayout)} USDC</strong></span>
        </div>`;
      } else {
        itmRow = `<div class="pos-itm-row otm">
          <span class="pos-itm-icon">⚪</span>
          <span>Spot ${spotStr} · not ITM yet (strike ${fmtQuoteCcy(pos.strikeFloat, pairCode, { decimals: pairCode === "usd_jpy" ? 2 : 0 })})</span>
        </div>`;
      }
    }

    // Settled payout display
    const payoutStr = pos.status === 1 ? `<span>·</span><span class="success-text">Payout ${fmtUSDC(pos.payout)} USDC</span>` : "";
    const expiryDisplay = pos.status === 0
      ? `<span class="tabular">${fmtRelativeDays(pos.expiry)}</span>`
      : `<span class="tabular">${fmtDate(pos.expiry)}</span>`;

    return `
      <div class="pos-card">
        <div class="pos-info">
          <div class="pos-headline">
            <span class="pos-amount">${fmtUSDC(pos.notional)} USDC</span>
            ${pairBadge}
            ${tenorLabel ? `<span class="pos-pair-pill" style="background:rgba(85,85,122,0.08);color:var(--text2);border-color:rgba(85,85,122,0.15)">${tenorLabel}</span>` : ""}
          </div>
          <div class="pos-meta">
            <span>Premium <span class="tabular">${fmtUSDC(pos.premium)}</span></span>
            <span class="pos-sep">·</span>
            ${expiryDisplay}
            ${payoutStr}
          </div>
          ${itmRow}
        </div>
        <div class="pos-actions">
          <span class="pos-status ${cls}">${label}</span>
          ${canSettle ? `<button class="settle-btn" data-pda="${p.pubkey.toBase58()}">Settle →</button>` : ""}
        </div>
      </div>`;
  }).join("");
  // Bind settle handlers
  $$(".settle-btn", list).forEach(btn => {
    btn.addEventListener("click", () => settlePosition(btn.dataset.pda));
  });
}

// ── Friendly error mapper ──
const ERROR_MESSAGES = {
  RegistryPaused: "Protocol is paused — please try again later",
  MarketInactive: "Market is currently inactive",
  MmInactive: "Market maker is inactive",
  NotionalTooSmall: "Notional too small for this market",
  NotionalTooLarge: "Notional exceeds the market limit",
  QuoteExpired: "Quote expired — please request a new price",
  QuoteSignerMismatch: "MM signature mismatch",
  QuotePayloadMismatch: "Quote details don't match",
  PositionNotExpired: "Position hasn't expired yet — can't be settled",
  PositionAlreadySettled: "Position has already been settled",
  PriceStale: "Price data is stale — try again in a few minutes",
  InvalidPrice: "Invalid price",
  PriceExponentMismatch: "Price format mismatch",
  MmVaultMismatch: "MM vault mismatch",
  MarketMismatch: "Market doesn't match the position",
  PriceFeedMismatch: "Price feed mismatch",
  MmMismatch: "MM mismatch",
  BuyerMismatch: "Token account owner mismatch",
  AdminOnly: "Admin-only action",
  Unauthorized: "Unauthorized",
};
function friendlyError(err) {
  const raw = (err && (err.message || err.toString())) || "Unknown error";
  // Try to match Anchor error name patterns
  for (const name of Object.keys(ERROR_MESSAGES)) {
    if (raw.includes(name)) return ERROR_MESSAGES[name];
  }
  // Try common chain error codes
  if (/insufficient funds|0x1$/.test(raw)) return "Insufficient SOL/USDC balance";
  if (/blockhash not found/i.test(raw)) return "Network is busy — please retry";
  if (/User rejected|rejected the request/i.test(raw)) return "Transaction cancelled in wallet";
  // Trim long chain dumps
  if (raw.length > 140) return raw.slice(0, 120) + "…";
  return raw;
}

// ── Confirm modal ──
function showConfirmBuy({ pair, kind, premium, notional, expiry, strikeText, onConfirm }) {
  const root = $("#modal-root");
  if (!root) return;
  const kindLabel = kind === 0 ? "Put" : "Call";
  const riskNote = kind === 1
    ? `<div class="modal-warning">
        V1 demo note: call payouts can exceed notional in extreme FX moves. This demo reserves 100% of notional and is scoped to short-tenor major FX pairs.
      </div>`
    : "";
  root.innerHTML = `
    <div class="modal-backdrop" id="confirm-backdrop">
      <div class="modal" role="dialog" aria-labelledby="confirm-title">
        <div class="modal-icon">${kind === 0 ? "📉" : "📈"}</div>
        <h3 id="confirm-title">Confirm ${kindLabel} option purchase</h3>
        <p class="modal-sub">${fmtPair(pair)} · expires in ${fmtRelativeDays(expiry)}</p>
        <div class="modal-summary">
          <div class="modal-summary-row"><span>Notional</span><strong>${fmtUSDC(notional)} USDC</strong></div>
          <div class="modal-summary-row"><span>Strike</span><strong class="tabular">${strikeText}</strong></div>
          <div class="modal-summary-row"><span>You pay premium</span><strong style="color:var(--green)">${fmtUSDC(premium)} USDC</strong></div>
        </div>
        <div class="modal-warning">
          This premium is <strong>non-refundable</strong>. If the option expires OTM (out of the money), you lose the premium. If ITM, you receive an automatic payout at settlement.
        </div>
        ${riskNote}
        <div class="modal-actions">
          <button class="btn-cancel" id="confirm-cancel" type="button">Cancel</button>
          <button class="btn-confirm" id="confirm-ok" type="button">Confirm &amp; Pay</button>
        </div>
      </div>
    </div>`;
  const close = () => { root.innerHTML = ""; };
  $("#confirm-cancel").addEventListener("click", close);
  $("#confirm-backdrop").addEventListener("click", (e) => { if (e.target.id === "confirm-backdrop") close(); });
  $("#confirm-ok").addEventListener("click", () => { close(); onConfirm(); });
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
  });
}

// ── Success card ──
function showSuccessCard({ title, sub, txSig }) {
  const c = $("#success-card-container");
  if (!c) return;
  const explorerUrl = `https://explorer.solana.com/tx/${txSig}?cluster=custom&customUrl=http://localhost:8899`;
  c.innerHTML = `
    <div class="success-card">
      <div class="success-card-head">
        <div class="success-card-icon">✅</div>
        <div style="flex:1">
          <div class="success-card-title">${title}</div>
          <div class="success-card-sub">${sub}</div>
        </div>
        <button class="success-card-close" id="success-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="success-card-actions">
        <a class="success-card-link" href="${explorerUrl}" target="_blank" rel="noopener">🔗 Lihat di Explorer</a>
        <a class="success-card-link" href="#positions-section">📋 View positions</a>
      </div>
    </div>`;
  $("#success-close")?.addEventListener("click", () => { c.innerHTML = ""; });
  setTimeout(() => {
    if (c.firstChild?.style) c.firstChild.style.transition = "opacity 0.4s";
  }, 100);
}

// ── Mock spot rates (TODO: wire to PriceFeed PDA when bot/admin is updating) ──
// price = priceFloat * 10^-exponent (negative exp means decimal precision)
const MOCK_SPOTS = {
  usd_idr: { price: 1625000, exponent: -2, priceFloat: 16250.00 }, // 1 USD = Rp 16,250
  usd_jpy: { price: 14520,   exponent: -2, priceFloat: 145.20 },    // 1 USD = ¥ 145.20
  jpy_idr: { price: 11180,   exponent: -2, priceFloat: 111.80 },    // 1 JPY = Rp 111.80
  cny_idr: { price: 226000,  exponent: -2, priceFloat: 2260.00 },   // 1 CNY = Rp 2,260
  cny_usd: { price: 1390,    exponent: -4, priceFloat: 0.1390 },    // 1 CNY = $0.1390 (USD/CNY ≈ 7.19)
};
function getSpot(pairCode) {
  return MOCK_SPOTS[pairCode] || null;
}
async function fetchSpot(pairCode) {
  // Mock for now — real impl would parse PriceFeed PDA via parsePriceFeed
  return getSpot(pairCode);
}

// Pair-aware dual-input config: left = base ccy, right = quote ccy.
// rate = quote per base (1 base = rate quote), straight from MOCK_SPOTS.
function ccyDecimals(ccy) {
  return ccy === "IDR" ? 0 : ccy === "JPY" ? 0 : 2;
}
function getPairDualConfig(pair) {
  const m = pairMeta(pair);
  const spot = getSpot(pair);
  if (!m || !spot) return null;
  return {
    baseCcy: m.base, baseSym: m.baseSym, baseDecimals: ccyDecimals(m.base),
    quoteCcy: m.quote, quoteSym: m.quoteSym, quoteDecimals: ccyDecimals(m.quote),
    rate: spot.priceFloat,
  };
}
// Convert a base-ccy amount to USD (for notional sent to contract).
function baseToUsd(pair, baseAmount) {
  const m = pairMeta(pair);
  if (!m || !baseAmount) return 0;
  if (m.base === "USD") return baseAmount;
  if (m.base === "JPY") return baseAmount / MOCK_SPOTS.usd_jpy.priceFloat;
  if (m.base === "CNY") return baseAmount * MOCK_SPOTS.cny_usd.priceFloat;
  if (m.base === "IDR") return baseAmount / MOCK_SPOTS.usd_idr.priceFloat;
  return baseAmount;
}
// Convert a USD amount to the pair's base ccy (for default seeding when pair changes).
function usdToBase(pair, usdAmount) {
  const m = pairMeta(pair);
  if (!m || !usdAmount) return 0;
  if (m.base === "USD") return usdAmount;
  if (m.base === "JPY") return usdAmount * MOCK_SPOTS.usd_jpy.priceFloat;
  if (m.base === "CNY") return usdAmount / MOCK_SPOTS.cny_usd.priceFloat;
  if (m.base === "IDR") return usdAmount * MOCK_SPOTS.usd_idr.priceFloat;
  return usdAmount;
}

// Per-pair quoted spot label ("1 USD = Rp 16,250" or "1 JPY = Rp 111.80")
function pairSpotLabel(pair) {
  const m = pairMeta(pair);
  const spot = getSpot(pair);
  if (!m || !spot) return "";
  const quoteFmt = m.quote === "IDR" ? fmtIDR
    : m.quote === "JPY" ? fmtJPY
    : m.quote === "USD" ? (n, o) => fmtUSD(n, { cents: true, ...o })
    : m.quote === "CNY" ? fmtCNY
    : (n) => Number(n).toLocaleString();
  const decimals = m.quote === "IDR" ? 0 : m.quote === "JPY" ? 2 : 4;
  return `1 ${m.base} = ${quoteFmt(spot.priceFloat, { decimals })}`;
}

// ── Unified quote request (used by both Pro form and Retail wizard) ──
async function requestQuote({ pair, tenor, kind, notionalUsdc }) {
  if (!state.wallet) { toast("Connect your wallet first", "err"); return; }
  state.loading = true;
  try {
    const spotPromise = fetchSpot(pair);
    const resp = await fetch(`${BOT_URL}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        buyer: state.wallet.publicKey.toBase58(),
        pair,
        tenor_seconds: tenor,
        notional_usdc: notionalUsdc,
        option_kind: kind,
      }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    state.quoteSpot = await spotPromise;
    if (state.quoteSpot) state.spots[pair] = state.quoteSpot;
    state.currentQuote = { quote: data.quote, signature_b58: data.signature_b58, pair, tenor, kind };
    toast("Quote received!", "ok");
    // Scroll to quote in retail mode (since it appears below wizard)
    if (state.mode === "retail") {
      setTimeout(() => $("#quote-result")?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
    }
  } catch (err) {
    toast(friendlyError(err), "err");
    console.error("Quote failed:", err);
    state.currentQuote = null;
  } finally {
    state.loading = false;
  }
}

$("#quote-btn").addEventListener("click", () => {
  const pair = $("#pair").value;
  const baseAmt = parseFloat($("#notional").value || "0");
  const notionalUsdc = Math.round(baseToUsd(pair, baseAmt));
  requestQuote({
    pair,
    tenor: parseInt($("#tenor").value),
    kind: parseInt($("#kind")?.value || "0"),
    notionalUsdc,
  });
});

// ── Buy Flow ──
async function executeBuy() {
  if (!state.wallet || !state.currentQuote) return;
  state.buying = true;
  try {
    const { quote, signature_b58 } = state.currentQuote;
    const payloadBytes = Uint8Array.from(atob(quote.payload_b64), c => c.charCodeAt(0));
    const sigBytes = bs58.decode(signature_b58);

    // Build ed25519 verify ix
    const edIx = buildEd25519Ix(new PublicKey(quote.mm_quote_signer), sigBytes, payloadBytes);

    // Derive PDAs
    const buyer = state.wallet.publicKey;
    const market = new PublicKey(quote.market);
    const [registry] = PublicKey.findProgramAddressSync([Buffer.from("mm_registry")], PROGRAM_ID);
    const mmAuth = await getMmAuthorityForSigner(quote.mm_quote_signer);
    if (!mmAuth) throw new Error("No registered MM for quote signer");
    const [mm] = PublicKey.findProgramAddressSync([Buffer.from("mm"), mmAuth.toBuffer()], PROGRAM_ID);
    // Read nonce from wire (bot now sends as string to avoid JSON precision loss)
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(quote.quote_nonce));
    const [positionFixed] = PublicKey.findProgramAddressSync([Buffer.from("position"), buyer.toBuffer(), nonceBuf], PROGRAM_ID);
    const buyerUsdc = await getAssociatedTokenAddress(USDC_MINT, buyer, false);
    const mmVault = await getAssociatedTokenAddress(USDC_MINT, mm, true);

    // Build buy ix
    const disc = await discriminator("buy_option");
    const quoteSer = serializeSignedQuote({
      buyer: quote.buyer,
      mm_quote_signer: quote.mm_quote_signer,
      market: quote.market,
      strike: quote.strike,
      strike_exponent: quote.strike_exponent,
      notional: quote.notional,
      premium: quote.premium,
      expiry: quote.expiry,
      quote_nonce: quote.quote_nonce,
      valid_until: quote.valid_until,
    });

    // Derive price_feed PDA for this pair
    const pair = state.currentQuote.pair || $("#pair").value;
    const priceFeedPda = FEED_BY_PAIR[pair] || FEED_BY_PAIR["usd_idr"];

    // Account ordering: signer+writable → readonly → writable → readonly (Solana standard)
    const buyIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: buyer, isSigner: true, isWritable: true },
        { pubkey: INSTRUCTIONS_ID, isSigner: false, isWritable: false },
        { pubkey: registry, isSigner: false, isWritable: false },
        { pubkey: market, isSigner: false, isWritable: false },
        { pubkey: priceFeedPda, isSigner: false, isWritable: false },
        { pubkey: mm, isSigner: false, isWritable: true },
        { pubkey: buyerUsdc, isSigner: false, isWritable: true },
        { pubkey: mmVault, isSigner: false, isWritable: true },
        { pubkey: positionFixed, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from(disc), Buffer.from(quoteSer)]),
    });

    console.log("BUY IX KEYS:");
    buyIx.keys.forEach((k, i) => console.log(`  [${i}] ${k.pubkey.toBase58()} ${k.isSigner ? 'S' : ''} ${k.isWritable ? 'W' : ''}`));

    // Compile tx first to lock account indices, then serialize+deserialize
    // so Backpack's signTransaction doesn't recompile the message
    const tx = new Transaction().add(edIx).add(buyIx);
    tx.feePayer = buyer;
    tx.recentBlockhash = (await CONNECTION.getLatestBlockhash()).blockhash;
    tx.compileMessage();
    const locked = Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    const signed = await state.wallet.signTransaction(locked);
    const sig = await CONNECTION.sendRawTransaction(signed.serialize());
    await CONNECTION.confirmTransaction(sig);
    showSuccessCard({
      title: "Option purchased",
      sub: `Premium ${fmtUSDC(quote.premium)} USDC paid · position added to your list`,
      txSig: sig,
    });
    state.currentQuote = null;
    await loadBalance();
    await loadPositions();
  } catch (err) {
    toast(friendlyError(err), "err");
    console.error("Buy failed:", err);
  } finally {
    state.buying = false;
  }
}

$("#buy-btn").addEventListener("click", () => {
  if (!state.wallet || !state.currentQuote) return;
  const q = state.currentQuote;
  const parsed = parseQuoteFromPayload(q.quote.payload_b64);
  const pair = q.pair || $("#pair").value;
  const kind = q.kind ?? parseInt($("#kind")?.value || "0");
  const strikeText = `${fmtQuoteCcy(parsed.strikeFloat, pair, { decimals: pair === "usd_jpy" ? 2 : 0 })} / USD`;
  showConfirmBuy({
    pair, kind,
    premium: parsed.premium,
    notional: parsed.notional,
    expiry: parsed.expiry,
    strikeText,
    onConfirm: executeBuy,
  });
});

// ── Settle ──
async function settlePosition(pdaStr) {
  if (!state.wallet) return;
  const posPda = new PublicKey(pdaStr);
  try {
    const acc = await CONNECTION.getAccountInfo(posPda);
    if (!acc) throw new Error("Position not found");
    const data = acc.data;
    const marketKey = new PublicKey(data.slice(8 + 32 + 32, 8 + 32 + 32 + 32));
    const mmKey = new PublicKey(data.slice(8 + 32, 8 + 32 + 32));
    const mkt = await CONNECTION.getAccountInfo(marketKey);
    const priceFeedKey = new PublicKey(mkt.data.slice(8, 8 + 32));
    const mmAcc = await CONNECTION.getAccountInfo(mmKey);
    const mmVaultKey = new PublicKey(mmAcc.data.slice(8 + 32, 8 + 32 + 32));
    const buyer = state.wallet.publicKey;
    const buyerUsdc = await getAssociatedTokenAddress(USDC_MINT, buyer, false);

    const disc = await discriminator("settle_option");
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: buyer, isSigner: true, isWritable: false },
        { pubkey: posPda, isSigner: false, isWritable: true },
        { pubkey: marketKey, isSigner: false, isWritable: false },
        { pubkey: priceFeedKey, isSigner: false, isWritable: false },
        { pubkey: mmKey, isSigner: false, isWritable: false },
        { pubkey: mmVaultKey, isSigner: false, isWritable: true },
        { pubkey: buyerUsdc, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(disc),
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = buyer;
    tx.recentBlockhash = (await CONNECTION.getLatestBlockhash()).blockhash;
    const signed = await state.wallet.signTransaction(tx);
    const sig = await CONNECTION.sendRawTransaction(signed.serialize());
    await CONNECTION.confirmTransaction(sig);
    showSuccessCard({
      title: "Settlement complete",
      sub: "Payout sent to your wallet (if ITM)",
      txSig: sig,
    });
    await loadBalance();
    await loadPositions();
  } catch (err) {
    toast(friendlyError(err), "err");
    console.error("Settle failed:", err);
  }
}

// ── Load Positions ──
async function loadPositions() {
  if (!state.wallet) return;
  try {
    const accs = await CONNECTION.getProgramAccounts(PROGRAM_ID, {
      filters: [{ memcmp: { offset: 8, bytes: state.wallet.publicKey.toBase58() } }],
    });
    console.log("loadPositions found:", accs.length, "accounts");
    // Refresh cached spots in parallel for ITM/OTM display
    const spotResults = await Promise.all(PAIR_DEFS.map(p => fetchSpot(p.code)));
    PAIR_DEFS.forEach((p, i) => { if (spotResults[i]) state.spots[p.code] = spotResults[i]; });
    state.positions = accs;
  } catch (e) { console.error("loadPositions error:", e); state.positions = []; }
}

// ── Helpers ──
function buildEd25519Ix(signer, signature, message) {
  const H = 16, pubOff = H, sigOff = H + 32, msgOff = H + 32 + 64;
  const buf = Buffer.alloc(msgOff + message.length);
  let o = 0;
  buf.writeUInt8(1, o++); buf.writeUInt8(0, o++);
  buf.writeUInt16LE(sigOff, o); o += 2; buf.writeUInt16LE(0xFFFF, o); o += 2;
  buf.writeUInt16LE(pubOff, o); o += 2; buf.writeUInt16LE(0xFFFF, o); o += 2;
  buf.writeUInt16LE(msgOff, o); o += 2; buf.writeUInt16LE(message.length, o); o += 2;
  buf.writeUInt16LE(0xFFFF, o); o += 2;
  Buffer.from(signer.toBytes()).copy(buf, o); o += 32;
  Buffer.from(signature).copy(buf, o); o += 64;
  Buffer.from(message).copy(buf, o);
  return new TransactionInstruction({ programId: ED25519_PROGRAM_ID, keys: [], data: buf });
}

async function getMmAuthorityForSigner(quoteSigner) {
  try {
    const expected = new PublicKey(quoteSigner).toBytes();
    const accs = await CONNECTION.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: 122 }] });
    const match = accs.find(({ account }) => {
      const registeredSigner = account.data.slice(40, 72);
      return Buffer.from(registeredSigner).equals(Buffer.from(expected));
    });
    if (!match) return null;
    return new PublicKey(match.account.data.slice(8, 8 + 32));
  } catch { return null; }
}

// ── Test: send SOL ──
$("#test-btn")?.addEventListener("click", async () => {
  const res = $("#test-result");
  if (!state.wallet) { res.textContent = "❌ Connect your wallet first"; return; }
  res.textContent = "⏳ Sending 0.001 SOL…";
  try {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: state.wallet.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1_000_000,
      })
    );
    tx.feePayer = state.wallet.publicKey;
    tx.recentBlockhash = (await CONNECTION.getLatestBlockhash()).blockhash;
    const signed = await state.wallet.signTransaction(tx);
    const sig = await CONNECTION.sendRawTransaction(signed.serialize());
    await CONNECTION.confirmTransaction(sig);
    res.innerHTML = `✅ Success! <a href="https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=http://localhost:8899" target="_blank">${sig.slice(0,20)}...</a>`;
  } catch(e) {
    res.textContent = "❌ Failed: " + (e.message || e);
    console.error(e);
  }
});
$("#connect-btn").addEventListener("click", () => {
  state.wallet ? disconnectWallet() : connectWallet();
});

$("#banner-connect-btn")?.addEventListener("click", () => {
  if (!state.wallet) connectWallet();
});

$("#refresh-btn").addEventListener("click", () => {
  loadPositions();
  loadBalance();
});

// ── Hero copy adapts to pair + kind ──
function updateHero() {
  const pair = $("#pair")?.value || "usd_idr";
  const kind = parseInt($("#kind")?.value || "0");
  const isPut = kind === 0;
  const m = pairMeta(pair);
  const quoteCcy = m?.quote || "quote ccy";
  const pairLabel = fmtPair(pair);
  const title = $("#hero-title");
  const sub = $("#hero-sub");
  if (title) title.textContent = isPut ? "Buy a Put Option" : "Buy a Call Option";
  if (sub) {
    sub.textContent = isPut
      ? `Hedge your export revenue from a strengthening ${quoteCcy}.`
      : `Hedge your import costs from a weakening ${quoteCcy}.`;
  }
  const kindHint = $("#kind-hint");
  if (kindHint) {
    if (isPut) {
      kindHint.innerHTML = `Exporters typically buy a <strong>Put</strong>: payout if ${quoteCcy} strengthens (${pairLabel} drops).`;
    } else {
      kindHint.innerHTML = `Importers typically buy a <strong>Call</strong>: payout if ${quoteCcy} weakens (${pairLabel} rises).`;
    }
  }
  const tenorHint = $("#tenor-hint");
  const tenorVal = parseInt($("#tenor")?.value || "2592000");
  const tenorLabels = { 604800: "≈1 week", 2592000: "≈1 month", 5184000: "≈2 months" };
  if (tenorHint) tenorHint.textContent = tenorLabels[tenorVal] || "expiry";
}

["#pair", "#kind", "#tenor"].forEach(sel => {
  const el = $(sel);
  if (el) el.addEventListener("change", updateHero);
});

// ── Notional preset chips (presets are in USD; convert to current base ccy) ──
function syncPresetChips() {
  const pair = $("#pair")?.value || "usd_idr";
  const baseVal = parseFloat($("#notional")?.value || "0");
  const usdEq = baseToUsd(pair, baseVal);
  $$(".preset-chip").forEach(chip => {
    chip.classList.toggle("active", parseInt(chip.dataset.preset) === Math.round(usdEq));
  });
}
$$(".preset-chip").forEach(chip => {
  chip.addEventListener("click", () => {
    const usdPreset = parseInt(chip.dataset.preset);
    const pair = $("#pair")?.value || "usd_idr";
    const cfg = getPairDualConfig(pair);
    const inp = $("#notional");
    if (inp && cfg) {
      const baseVal = usdToBase(pair, usdPreset);
      inp.value = cfg.baseDecimals === 0 ? Math.round(baseVal) : baseVal.toFixed(cfg.baseDecimals);
      inp.dataset.usd = String(usdPreset);
      inp.dispatchEvent(new Event("input"));
    }
    syncPresetChips();
  });
});
$("#notional")?.addEventListener("input", () => {
  syncPresetChips();
  validateNotional();
  renderQuoteForm();
  syncProDualFromBase();
});

// ── Mode toggle (Retail / Pro) ──
function renderMode() {
  $$(".mode-pill").forEach(p => p.classList.toggle("active", p.dataset.mode === state.mode));
  const wizard = $("#retail-wizard");
  const pro = $("#quote-section");
  if (wizard) wizard.style.display = state.mode === "retail" ? "block" : "none";
  if (pro) pro.style.display = state.mode === "pro" ? "block" : "none";
  // Quote result is shared across modes — keep visible if there's an active quote
}
$$(".mode-pill").forEach(pill => {
  pill.addEventListener("click", () => { state.mode = pill.dataset.mode; });
});

// ── Retail wizard ──
function renderWizard() {
  const w = state.wizard;
  // Step visibility
  $$(".wizard-step").forEach(s => s.classList.toggle("active", parseInt(s.dataset.step) === w.step));
  // Progress dots
  $$(".wizard-dot").forEach(d => {
    const ds = parseInt(d.dataset.step);
    d.classList.toggle("active", ds === w.step);
    d.classList.toggle("done", ds < w.step);
  });
  // Profile cards selection
  $$(".profile-card").forEach(c => c.classList.toggle("selected", c.dataset.profile === w.profile));
  // Pair pills (flag-pair-card)
  $$("#wizard-pair-pills .flag-pair-card").forEach(p => {
    const isActive = p.dataset.pair === w.pair;
    p.classList.toggle("active", isActive);
    p.setAttribute("aria-checked", isActive ? "true" : "false");
  });
  // Tenor cards
  $$("#wizard-tenor-cards .tenor-card").forEach(t => t.classList.toggle("active", parseInt(t.dataset.tenor) === w.tenor));

  // Summary chips on later steps
  const sum2 = $("#wizard-summary-2");
  const sum3 = $("#wizard-summary-3");
  const profileChip = w.profile === "exporter" ? "📦 Exporter" : w.profile === "importer" ? "📥 Importer" : "";
  const pairChip = `${fmtPairFlag(w.pair)} ${fmtPair(w.pair)}`;
  const amtChip = w.amountUsd ? `💰 ${fmtUSD(w.amountUsd)}` : "";
  if (sum2) sum2.innerHTML = profileChip ? `<span class="wizard-summary-chip">${profileChip}</span>` : "";
  if (sum3) sum3.innerHTML = [profileChip, pairChip, amtChip].filter(Boolean)
    .map(c => `<span class="wizard-summary-chip">${c}</span>`).join("");

  // Buttons
  const back = $("#wizard-back");
  const next = $("#wizard-next");
  if (back) back.disabled = w.step === 1;
  if (next) {
    if (w.step === 3) {
      next.innerHTML = `<span class="btn-text">Get Quote →</span><span class="btn-spinner"></span>`;
      next.disabled = !state.wallet || state.loading;
      next.classList.toggle("is-loading", state.loading);
    } else {
      next.innerHTML = `<span class="btn-text">Next →</span><span class="btn-spinner"></span>`;
      next.disabled = (w.step === 1 && !w.profile) || (w.step === 2 && !(w.amountUsd > 0));
      next.classList.remove("is-loading");
    }
  }
}

function wizardComplete() {
  const w = state.wizard;
  // Profile decides option kind: exporter → put (0), importer → call (1)
  const kind = w.profile === "importer" ? 1 : 0;
  requestQuote({
    pair: w.pair,
    tenor: w.tenor,
    kind,
    notionalUsdc: parseInt(w.amountUsd) || 0,
  });
}

$("#wizard-next")?.addEventListener("click", () => {
  const w = state.wizard;
  if (w.step < 3) state.wizard = { step: w.step + 1 };
  else wizardComplete();
});
$("#wizard-back")?.addEventListener("click", () => {
  const w = state.wizard;
  if (w.step > 1) state.wizard = { step: w.step - 1 };
});

// Profile choice
$$(".profile-card").forEach(c => {
  c.addEventListener("click", () => {
    state.wizard = { profile: c.dataset.profile };
  });
});

// Wizard pair pills (flag-pair-card)
$$("#wizard-pair-pills .flag-pair-card").forEach(p => {
  p.addEventListener("click", () => {
    state.wizard = { pair: p.dataset.pair };
    refreshWizardRate();
  });
});

// Wizard tenor cards
$$("#wizard-tenor-cards .tenor-card").forEach(t => {
  t.addEventListener("click", () => {
    state.wizard = { tenor: parseInt(t.dataset.tenor) };
  });
});

// ── Dual-currency sync (wizard step 2) — base ccy ⇌ quote ccy, runs SYNC ──
function refreshWizardRate() {
  const info = $("#wizard-rate-info");
  if (!info) return;
  const cfg = getPairDualConfig(state.wizard.pair);
  if (!cfg) return;
  state.spots[state.wizard.pair] = getSpot(state.wizard.pair);
  // Left side (base) labels
  const baseLbl = $("#wizard-base-ccy-label");
  const baseSuf = $("#wizard-base-ccy-suffix");
  if (baseLbl) baseLbl.textContent = `In ${cfg.baseCcy}`;
  if (baseSuf) baseSuf.textContent = cfg.baseSym;
  // Right side (quote) labels
  const quoteLbl = $("#wizard-quote-ccy-label");
  const quoteSuf = $("#wizard-quote-ccy-suffix");
  if (quoteLbl) quoteLbl.textContent = `In ${cfg.quoteCcy}`;
  if (quoteSuf) quoteSuf.textContent = cfg.quoteSym;
  // Reseed base input when pair changes — preserve USD-equivalent value
  const baseInp = $("#wizard-amount-base");
  if (baseInp && state.wizard.amountUsd > 0) {
    const baseVal = usdToBase(state.wizard.pair, state.wizard.amountUsd);
    baseInp.value = cfg.baseDecimals === 0 ? Math.round(baseVal) : baseVal.toFixed(cfg.baseDecimals);
  }
  // Rate display
  const pairLabel = pairSpotLabel(state.wizard.pair);
  info.innerHTML = `<span class="amount-rate-dot"></span><strong>${pairLabel}</strong> <span style="opacity:0.6;margin-left:6px">· simulated rate</span>`;
  syncWizardDualFromBase();
}
function syncWizardDualFromBase() {
  const baseAmt = parseFloat($("#wizard-amount-base")?.value || "0");
  if (!baseAmt) return;
  const cfg = getPairDualConfig(state.wizard.pair);
  if (!cfg) return;
  const quoteAmt = baseAmt * cfg.rate;
  const inp = $("#wizard-amount-quote");
  if (inp) inp.value = cfg.quoteDecimals === 0 ? Math.round(quoteAmt) : quoteAmt.toFixed(cfg.quoteDecimals);
}
function syncWizardDualFromQuote() {
  const quoteAmt = parseFloat($("#wizard-amount-quote")?.value || "0");
  if (!quoteAmt) return;
  const cfg = getPairDualConfig(state.wizard.pair);
  if (!cfg) return;
  const baseAmt = quoteAmt / cfg.rate;
  const inp = $("#wizard-amount-base");
  if (inp) inp.value = cfg.baseDecimals === 0 ? Math.round(baseAmt) : baseAmt.toFixed(cfg.baseDecimals);
}
$("#wizard-amount-base")?.addEventListener("input", () => {
  const baseAmt = parseFloat($("#wizard-amount-base").value || "0");
  state.wizard = { amountUsd: baseToUsd(state.wizard.pair, baseAmt) };
  syncWizardDualFromBase();
});
$("#wizard-amount-quote")?.addEventListener("input", () => {
  syncWizardDualFromQuote();
  const baseAmt = parseFloat($("#wizard-amount-base")?.value || "0");
  state.wizard = { amountUsd: baseToUsd(state.wizard.pair, baseAmt) };
});

// ── Dual-currency sync (Pro form notional ↔ display ccy) ──
function refreshProRate() {
  const info = $("#pro-rate-info");
  if (!info) return;
  const pair = $("#pair")?.value || "usd_idr";
  const cfg = getPairDualConfig(pair);
  if (!cfg) return;
  state.spots[pair] = getSpot(pair);
  // Update left-side label + suffix (base ccy)
  const baseLbl = $("#notional-base-label");
  const baseSuf = $("#notional-base-suffix");
  if (baseLbl) baseLbl.textContent = cfg.baseCcy;
  if (baseSuf) baseSuf.textContent = cfg.baseSym;
  // Right-side suffix (quote ccy)
  const quoteSuf = $("#notional-quote-suffix");
  if (quoteSuf) quoteSuf.textContent = cfg.quoteSym;
  // Reseed base input from existing USD-equivalent
  const baseInp = $("#notional");
  const usdEq = parseFloat(baseInp?.dataset.usd || baseInp?.value || "0");
  if (baseInp && usdEq > 0) {
    const baseVal = usdToBase(pair, usdEq);
    baseInp.value = cfg.baseDecimals === 0 ? Math.round(baseVal) : baseVal.toFixed(cfg.baseDecimals);
    baseInp.dataset.usd = String(usdEq);
  }
  const pairLabel = pairSpotLabel(pair);
  info.innerHTML = `<span class="amount-rate-dot"></span>${pairLabel} <span style="opacity:0.6;margin-left:4px">· simulated rate</span>`;
  syncProDualFromBase();
}
function syncProDualFromBase() {
  const baseAmt = parseFloat($("#notional")?.value || "0");
  const pair = $("#pair")?.value || "usd_idr";
  if (!baseAmt) return;
  const cfg = getPairDualConfig(pair);
  if (!cfg) return;
  const inp = $("#notional-quote");
  const v = baseAmt * cfg.rate;
  if (inp) inp.value = cfg.quoteDecimals === 0 ? Math.round(v) : v.toFixed(cfg.quoteDecimals);
  // Track USD-equivalent for cross-pair reseeding
  const baseInp = $("#notional");
  if (baseInp) baseInp.dataset.usd = String(baseToUsd(pair, baseAmt));
}
function syncProDualFromQuote() {
  const quoteAmt = parseFloat($("#notional-quote")?.value || "0");
  const pair = $("#pair")?.value || "usd_idr";
  if (!quoteAmt) return;
  const cfg = getPairDualConfig(pair);
  if (!cfg) return;
  const inp = $("#notional");
  const baseAmt = quoteAmt / cfg.rate;
  if (inp) {
    inp.value = cfg.baseDecimals === 0 ? Math.round(baseAmt) : baseAmt.toFixed(cfg.baseDecimals);
    inp.dataset.usd = String(baseToUsd(pair, baseAmt));
  }
}
$("#notional-quote")?.addEventListener("input", () => {
  syncProDualFromQuote();
  syncPresetChips();
  validateNotional();
  renderQuoteForm();
});
$("#pair")?.addEventListener("change", refreshProRate);

// ── Wallet provider detection (visual badge in connect button) ──
function detectProvider() {
  if (window.backpack) return { name: "Backpack", short: "B" };
  if (window.solflare?.isSolflare) return { name: "Solflare", short: "S" };
  if (window.solana?.isPhantom) return { name: "Phantom", short: "P" };
  if (window.solana) return { name: "Solana", short: "◎" };
  return null;
}

function renderProviderBadge() {
  const btn = $("#connect-btn");
  if (!btn || state.wallet) return;
  const p = detectProvider();
  const icon = btn.querySelector(".btn-icon");
  if (icon) {
    if (p) {
      icon.innerHTML = `<span class="provider-icon" title="Detected: ${p.name}">${p.short}</span>`;
    } else {
      icon.textContent = "🔌";
    }
  }
}

// Initialize hero + chips + banner + validation + mode + wizard on load
updateHero();
syncPresetChips();
validateNotional();
renderWalletBanner();
renderMode();
renderWizard();
refreshWizardRate();
refreshProRate();
renderProviderBadge();
setTimeout(renderProviderBadge, 500); // re-check after wallet extensions inject

// Show skeleton initially
showSkeleton($("#positions-list"));

// Auto-connect
(async () => {
  const provider = getProvider();
  if (provider) {
    try {
      const resp = await provider.connect({ onlyIfTrusted: true });
      if (resp) {
        state.wallet = {
          publicKey: new PublicKey(resp.publicKey.toString()),
          signTransaction: (tx) => provider.signTransaction(tx),
          signAllTransactions: (txs) => provider.signAllTransactions(txs),
        };
        provider.on("disconnect", () => { state.wallet = null; });
        provider.on("accountChanged", () => { state.wallet = null; connectWallet(); });
      }
    } catch { /* not connected */ }
  }
})();
