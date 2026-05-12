use anchor_lang::prelude::*;

pub const USDC_DECIMALS: u8 = 6;

pub const MIN_TENOR_SECONDS: u32 = 60 * 60 * 24;
pub const MAX_TENOR_SECONDS: u32 = 60 * 60 * 24 * 90;

pub const QUOTE_TTL_SECONDS_MAX: i64 = 120;

pub const STRIKE_DEVIATION_BPS: i64 = 500;
pub const EXPIRY_DRIFT_SECONDS: i64 = 60;
