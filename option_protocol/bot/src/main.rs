mod iv_table;
mod pricer;
mod quote;

use std::sync::Arc;

use anyhow::{Context, Result};
use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use rand::RngCore;
use solana_sdk::pubkey::Pubkey;
use solana_rpc_client::rpc_client::RpcClient;
use tokio::signal;
use tower_http::cors::{Any, CorsLayer};

use crate::quote::{Pair, QuoteRequest, QuoteResponse, SignedQuote, SignedQuoteWire};

const PROGRAM_ID: &str = "H5yv1n2BMwPXgVGYA9Rewz4PQFx7p3RDpbZgBajoiULY";

struct AppState {
    signer: SigningKey,
    program_id: Pubkey,
    rpc: RpcClient,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let signer = load_or_generate_signer()?;
    let program_id: Pubkey = PROGRAM_ID.parse()?;
    let rpc_url = std::env::var("SOLANA_RPC_URL")
        .unwrap_or_else(|_| "https://api.devnet.solana.com".into());
    let rpc = RpcClient::new(rpc_url);

    let state = Arc::new(AppState { signer, program_id, rpc });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/quote", post(quote_handler))
        .route("/healthz", axum::routing::get(|| async { "ok" }))
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8787").await?;
    tracing::info!("kodrat-mm listening on 0.0.0.0:8787");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

async fn quote_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<QuoteRequest>,
) -> Result<Json<QuoteResponse>, (StatusCode, String)> {
    let vol = iv_table::lookup(req.pair, req.tenor_seconds)
        .ok_or((StatusCode::BAD_REQUEST, "unsupported pair/tenor".into()))?;

    let (spot_scaled, exponent) = fetch_spot(&state, req.pair)
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, format!("price feed unavailable: {e}")))?;
    let spot_f = (spot_scaled as f64) * 10f64.powi(exponent);

    let premium_quote_ccy = pricer::put_atm_premium(spot_f, vol, req.tenor_seconds);
    let premium_usdc =
        ((req.notional_usdc as f64) * premium_quote_ccy / spot_f).round() as u64 * 1_000_000;

    let now = chrono_now();
    let expiry = now + req.tenor_seconds as i64;
    let valid_until = now + 60;

    let market_pda = derive_market_pda(state.program_id, req.pair, req.tenor_seconds, req.option_kind);
    let signer_pubkey = Pubkey::new_from_array(state.signer.verifying_key().to_bytes());
    let buyer_pubkey: Pubkey = req.buyer.parse().map_err(|_| {
        (StatusCode::BAD_REQUEST, "invalid buyer pubkey".into())
    })?;

    let mut nonce_bytes = [0u8; 8];
    OsRng.fill_bytes(&mut nonce_bytes);
    let quote_nonce = u64::from_le_bytes(nonce_bytes);

    let q = SignedQuote {
        buyer: buyer_pubkey.to_bytes(),
        mm_quote_signer: signer_pubkey.to_bytes(),
        market: market_pda.to_bytes(),
        strike: spot_scaled,
        strike_exponent: exponent,
        notional: req.notional_usdc * 1_000_000, // convert USDC to lamports
        premium: premium_usdc,
        expiry,
        quote_nonce,
        valid_until,
    };

    let payload = borsh::to_vec(&q).map_err(internal)?;
    let sig = state.signer.sign(&payload);

    let resp = QuoteResponse {
        quote: SignedQuoteWire {
            buyer: req.buyer.clone(),
            mm_quote_signer: Pubkey::new_from_array(q.mm_quote_signer).to_string(),
            market: Pubkey::new_from_array(q.market).to_string(),
            strike: q.strike,
            strike_exponent: q.strike_exponent,
            notional: q.notional,
            premium: q.premium,
            expiry: q.expiry,
            quote_nonce: q.quote_nonce.to_string(),
            valid_until: q.valid_until,
            payload_b64: base64::engine::general_purpose::STANDARD.encode(&payload),
        },
        signature_b58: bs58::encode(sig.to_bytes()).into_string(),
    };
    Ok(Json(resp))
}

fn derive_market_pda(program_id: Pubkey, pair: Pair, tenor_seconds: u32, option_kind: u8) -> Pubkey {
    let sym = pair.symbol_bytes();
    let (pda, _) = Pubkey::find_program_address(
        &[b"market", sym.as_ref(), &tenor_seconds.to_le_bytes(), &[option_kind]],
        &program_id,
    );
    pda
}

fn load_or_generate_signer() -> Result<SigningKey> {
    if let Ok(hex) = std::env::var("MM_SIGNER_PRIVATE_KEY_HEX") {
        let bytes = hex::decode(hex.trim())
            .context("MM_SIGNER_PRIVATE_KEY_HEX is not valid hex")?;
        let key: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("MM_SIGNER_PRIVATE_KEY_HEX must be 32 bytes"))?;
        return Ok(SigningKey::from_bytes(&key.into()));
    }
    if let Ok(path) = std::env::var("MM_SIGNER_KEYPAIR_PATH") {
        let json = std::fs::read_to_string(&path)
            .with_context(|| format!("cannot read {}", path))?;
        let key_bytes: Vec<u8> = serde_json::from_str(&json)
            .context("invalid keypair JSON")?;
        let key: [u8; 64] = key_bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("keypair JSON must be 64 bytes"))?;
        // Solana keypair: first 32 bytes = private, next 32 = public
        let private: [u8; 32] = key[..32].try_into().unwrap();
        return Ok(SigningKey::from_bytes(&private.into()));
    }
    // No env var — generate and log
    let mut rng = OsRng;
    let signer = SigningKey::generate(&mut rng);
    let hex_key = hex::encode(signer.to_bytes());
    let pubkey = Pubkey::new_from_array(signer.verifying_key().to_bytes());

    let path = format!(
        ".kodrat-mm-signer-{}.hex",
        &hex::encode(&pubkey.to_bytes()[..4])
    );
    if let Err(e) = std::fs::write(&path, &hex_key) {
        tracing::warn!("Could not persist signer to {path}: {e}");
    }
    tracing::warn!(
        "Generated new MM signer saved to {path}. Set MM_SIGNER_PRIVATE_KEY_HEX to persist. Pubkey: {pubkey}",
    );
    Ok(signer)
}

fn derive_price_feed_pda(program_id: Pubkey, pair: Pair) -> Pubkey {
    let sym = pair.symbol_bytes();
    let (pda, _) = Pubkey::find_program_address(
        &[b"price_feed", sym.as_ref()],
        &program_id,
    );
    pda
}

fn fetch_spot(state: &AppState, pair: Pair) -> Result<(i64, i32)> {
    let feed_pda = derive_price_feed_pda(state.program_id, pair);
    let account = state.rpc.get_account(&feed_pda)?;
    // PriceFeed layout: disc(8) + authority(32) + symbol(8) + price(8) + exponent(4) + updated_at(8) + bump(1)
    let price_bytes = &account.data[8 + 32 + 8..8 + 32 + 8 + 8];
    let exponent_bytes = &account.data[8 + 32 + 8 + 8..8 + 32 + 8 + 8 + 4];
    let updated_at_bytes = &account.data[8 + 32 + 8 + 8 + 4..8 + 32 + 8 + 8 + 4 + 8];
    let price = i64::from_le_bytes(price_bytes.try_into().unwrap());
    let exponent = i32::from_le_bytes(exponent_bytes.try_into().unwrap());
    let updated_at = i64::from_le_bytes(updated_at_bytes.try_into().unwrap());

    let now = chrono_now();
    let staleness = now.saturating_sub(updated_at);
    tracing::debug!(
        "demo oracle staleness check bypassed for {pair:?}; feed age {staleness}s"
    );
    Ok((price, exponent))
}

fn chrono_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn internal<E: std::fmt::Display>(e: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

async fn shutdown() {
    let ctrl_c = async {
        signal::ctrl_c().await.ok();
    };
    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .ok()
            .unwrap()
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate: std::future::Pending<()> = std::future::pending();
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}
