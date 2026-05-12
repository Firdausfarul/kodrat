#[cfg(not(feature = "anchor"))]
use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(not(feature = "anchor"), derive(BorshSerialize, BorshDeserialize))]
#[cfg_attr(feature = "anchor", derive(anchor_lang::AnchorSerialize, anchor_lang::AnchorDeserialize))]
#[serde(rename_all = "snake_case")]
pub enum Pair {
    UsdIdr,
    UsdJpy,
}

impl Pair {
    pub fn symbol_bytes(self) -> [u8; 8] {
        let s = match self {
            Pair::UsdIdr => "USD/IDR",
            Pair::UsdJpy => "USD/JPY",
        };
        let mut out = [0u8; 8];
        let bytes = s.as_bytes();
        let n = bytes.len().min(8);
        out[..n].copy_from_slice(&bytes[..n]);
        out
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(not(feature = "anchor"), derive(BorshSerialize, BorshDeserialize))]
#[cfg_attr(feature = "anchor", derive(anchor_lang::AnchorSerialize, anchor_lang::AnchorDeserialize))]
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
