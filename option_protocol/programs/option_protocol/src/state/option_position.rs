use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct OptionPosition {
    pub buyer: Pubkey,
    pub mm: Pubkey,
    pub market: Pubkey,
    pub strike: i64,
    pub strike_exponent: i32,
    pub notional: u64,
    pub premium_paid: u64,
    pub expiry: i64,
    pub quote_nonce: u64,
    pub status: u8,
    pub created_at: i64,
    pub payout_amount: u64,
    pub settled_at: i64,
    pub bump: u8,
}

impl OptionPosition {
    pub const SEED_PREFIX: &'static [u8] = b"position";
    pub const STATUS_OPEN: u8 = 0;
    pub const STATUS_EXERCISED: u8 = 1;
    pub const STATUS_EXPIRED_OTM: u8 = 2;
}
