use crate::errors::OptionError;
use anchor_lang::prelude::*;

pub fn put_payout_usdc(strike: i64, spot: i64, notional: u64) -> Result<u64> {
    if strike <= 0 || spot < 0 {
        return err!(OptionError::MathOverflow);
    }
    if strike <= spot {
        return Ok(0);
    }
    let diff = (strike as u128)
        .checked_sub(spot as u128)
        .ok_or(OptionError::MathOverflow)?;
    let num = diff
        .checked_mul(notional as u128)
        .ok_or(OptionError::MathOverflow)?;
    let payout = num
        .checked_div(strike as u128)
        .ok_or(OptionError::MathOverflow)?;
    u64::try_from(payout).map_err(|_| OptionError::MathOverflow.into())
}

pub fn call_payout_usdc(strike: i64, spot: i64, notional: u64) -> Result<u64> {
    if strike <= 0 || spot < 0 {
        return err!(OptionError::MathOverflow);
    }
    if spot <= strike {
        return Ok(0);
    }
    let diff = (spot as u128)
        .checked_sub(strike as u128)
        .ok_or(OptionError::MathOverflow)?;
    let num = diff
        .checked_mul(notional as u128)
        .ok_or(OptionError::MathOverflow)?;
    let payout = num
        .checked_div(strike as u128)
        .ok_or(OptionError::MathOverflow)?;
    u64::try_from(payout).map_err(|_| OptionError::MathOverflow.into())
}

pub fn option_payout(kind: u8, strike: i64, spot: i64, notional: u64) -> Result<u64> {
    match kind {
        0 => put_payout_usdc(strike, spot, notional),
        1 => call_payout_usdc(strike, spot, notional),
        _ => err!(OptionError::InvalidOptionKind),
    }
}

pub fn normalize_spot(spot: i64, spot_exponent: i32, target_exponent: i32) -> Result<i64> {
    if spot_exponent == target_exponent {
        return Ok(spot);
    }
    let exp_diff = (target_exponent - spot_exponent).unsigned_abs() as u32;
    let pow10 = 10_i64
        .checked_pow(exp_diff)
        .ok_or(OptionError::MathOverflow)?;
    if target_exponent > spot_exponent {
        spot.checked_mul(pow10).ok_or(OptionError::MathOverflow.into())
    } else {
        spot.checked_div(pow10).ok_or(OptionError::MathOverflow.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_otm_returns_zero() {
        assert_eq!(put_payout_usdc(16_000, 16_500, 5_000_000).unwrap(), 0);
    }
    #[test]
    fn put_atm_returns_zero() {
        assert_eq!(put_payout_usdc(16_000, 16_000, 5_000_000).unwrap(), 0);
    }
    #[test]
    fn put_itm_proportional() {
        let p = put_payout_usdc(16_000, 15_200, 5_000_000).unwrap();
        assert_eq!(p, 250_000);
    }
    #[test]
    fn call_otm_returns_zero() {
        assert_eq!(call_payout_usdc(16_000, 15_500, 5_000_000).unwrap(), 0);
    }
    #[test]
    fn call_itm_proportional() {
        let p = call_payout_usdc(16_000, 16_800, 5_000_000).unwrap();
        assert_eq!(p, 250_000);
    }
}
