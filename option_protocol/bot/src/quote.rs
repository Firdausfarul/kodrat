use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Pair {
    UsdIdr,
    UsdJpy,
    JpyIdr,
    CnyIdr,
    CnyUsd,
}

impl Pair {
    pub fn symbol_bytes(self) -> [u8; 8] {
        let s = match self {
            Pair::UsdIdr => "USD/IDR",
            Pair::UsdJpy => "USD/JPY",
            Pair::JpyIdr => "JPY/IDR",
            Pair::CnyIdr => "CNY/IDR",
            Pair::CnyUsd => "CNY/USD",
        };
        let mut out = [0u8; 8];
        let bytes = s.as_bytes();
        let n = bytes.len().min(8);
        out[..n].copy_from_slice(&bytes[..n]);
        out
    }
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub struct SignedQuote {
    pub buyer: [u8; 32],
    pub mm_quote_signer: [u8; 32],
    pub market: [u8; 32],
    pub strike: i64,
    pub strike_exponent: i32,
    pub notional: u64,
    pub premium: u64,
    pub expiry: i64,
    pub quote_nonce: u64,
    pub valid_until: i64,
}

#[derive(Deserialize, Debug)]
pub struct QuoteRequest {
    pub buyer: String,
    pub pair: Pair,
    pub tenor_seconds: u32,
    pub notional_usdc: u64,
    pub option_kind: u8,
}

#[derive(Serialize, Debug)]
pub struct QuoteResponse {
    pub quote: SignedQuoteWire,
    pub signature_b58: String,
}

#[derive(Serialize, Debug)]
pub struct SignedQuoteWire {
    pub buyer: String,
    pub mm_quote_signer: String,
    pub market: String,
    pub strike: i64,
    pub strike_exponent: i32,
    pub notional: u64,
    pub premium: u64,
    pub expiry: i64,
    pub quote_nonce: String,
    pub valid_until: i64,
    pub payload_b64: String,
}
