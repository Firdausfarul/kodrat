use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Token, TokenAccount, Transfer};
use option_protocol_types::SignedQuote;
use solana_program::ed25519_program;
use solana_program::sysvar::instructions::{load_instruction_at_checked, ID as IX_SYSVAR_ID};

use crate::constants::{EXPIRY_DRIFT_SECONDS, QUOTE_TTL_SECONDS_MAX, STRIKE_DEVIATION_BPS};
use crate::errors::OptionError;
use crate::state::{Mm, MmRegistry, OptionMarket, OptionPosition, PriceFeed};

#[event]
pub struct QuoteFilled {
    pub buyer: Pubkey,
    pub mm: Pubkey,
    pub market: Pubkey,
    pub premium: u64,
    pub notional: u64,
    pub expiry: i64,
    pub quote_nonce: u64,
}

#[derive(Accounts)]
#[instruction(quote: SignedQuote)]
pub struct BuyOption<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// CHECK: Sysvar instructions for ed25519 precompile verification
    #[account(address = IX_SYSVAR_ID)]
    pub ix_sysvar: UncheckedAccount<'info>,

    #[account(
        seeds = [MmRegistry::SEED],
        bump = registry.bump,
        constraint = !registry.paused @ OptionError::RegistryPaused,
    )]
    pub registry: Account<'info, MmRegistry>,

    #[account(
        constraint = market.active @ OptionError::MarketInactive,
        constraint = market.key().to_bytes() == quote.market @ OptionError::QuotePayloadMismatch,
    )]
    pub market: Account<'info, OptionMarket>,

    #[account(
        constraint = price_feed.key() == market.price_feed @ OptionError::PriceFeedMismatch,
    )]
    pub price_feed: Account<'info, PriceFeed>,

    #[account(
        mut,
        seeds = [Mm::SEED_PREFIX, mm.authority.as_ref()],
        bump = mm.bump,
        constraint = mm.active @ OptionError::MmInactive,
    )]
    pub mm: Account<'info, Mm>,

    #[account(
        mut,
        constraint = buyer_usdc.mint == registry.quote_mint @ OptionError::QuoteMintMismatch,
    )]
    pub buyer_usdc: Account<'info, TokenAccount>,

    #[account(
        mut,
        address = mm.usdc_vault @ OptionError::MmVaultMismatch,
    )]
    pub mm_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = buyer,
        space = 8 + OptionPosition::INIT_SPACE,
        seeds = [
            OptionPosition::SEED_PREFIX,
            buyer.key().as_ref(),
            &quote.quote_nonce.to_le_bytes(),
        ],
        bump,
    )]
    pub position: Account<'info, OptionPosition>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<BuyOption>, quote: SignedQuote) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // ── Ed25519 precompile verification ──
    // Load instruction at index 0 (the ed25519 ix must be first in the tx)
    let ix = load_instruction_at_checked(0, &ctx.accounts.ix_sysvar)?;

    require_keys_eq!(
        ix.program_id,
        ed25519_program::ID,
        OptionError::MissingEd25519Verify,
    );

    let data = &ix.data;
    require!(data.len() >= 16, OptionError::MalformedEd25519);
    let num_sigs = data[0] as usize;
    require!(num_sigs == 1, OptionError::MalformedEd25519);

    let _sig_off = u16::from_le_bytes([data[2], data[3]]) as usize;
    let pub_off = u16::from_le_bytes([data[6], data[7]]) as usize;
    let msg_off = u16::from_le_bytes([data[10], data[11]]) as usize;
    let msg_size = u16::from_le_bytes([data[12], data[13]]) as usize;

    // Verify public key embedded in precompile data matches MM's quote_signer
    require!(
        pub_off.checked_add(32).map_or(false, |e| e <= data.len()),
        OptionError::MalformedEd25519,
    );
    let pk_slice: &[u8; 32] = data[pub_off..pub_off + 32].try_into().unwrap();
    require_keys_eq!(
        Pubkey::new_from_array(*pk_slice),
        ctx.accounts.mm.quote_signer,
        OptionError::QuoteSignerMismatch,
    );

    // Verify message in precompile matches the canonical quote serialization
    let mut quote_bytes = Vec::with_capacity(148);
    quote_bytes.extend_from_slice(&quote.buyer);
    quote_bytes.extend_from_slice(&quote.mm_quote_signer);
    quote_bytes.extend_from_slice(&quote.market);
    quote_bytes.extend_from_slice(&quote.strike.to_le_bytes());
    quote_bytes.extend_from_slice(&quote.strike_exponent.to_le_bytes());
    quote_bytes.extend_from_slice(&quote.notional.to_le_bytes());
    quote_bytes.extend_from_slice(&quote.premium.to_le_bytes());
    quote_bytes.extend_from_slice(&quote.expiry.to_le_bytes());
    quote_bytes.extend_from_slice(&quote.quote_nonce.to_le_bytes());
    quote_bytes.extend_from_slice(&quote.valid_until.to_le_bytes());
    require!(
        msg_off.checked_add(msg_size).map_or(false, |e| e <= data.len()),
        OptionError::MalformedEd25519,
    );
    require!(
        data[msg_off..msg_off + msg_size] == quote_bytes,
        OptionError::QuotePayloadMismatch,
    );

    // ── Quote freshness ──
    require!(quote.valid_until > now, OptionError::QuoteExpired);
    require!(
        quote.valid_until - now <= QUOTE_TTL_SECONDS_MAX,
        OptionError::QuoteExpired
    );

    // ── Notional bounds ──
    require!(
        quote.notional >= ctx.accounts.market.min_notional,
        OptionError::NotionalTooSmall
    );
    require!(
        quote.notional <= ctx.accounts.market.max_notional,
        OptionError::NotionalTooLarge
    );

    // ── Buyer binding ──
    require!(
        ctx.accounts.buyer.key().to_bytes() == quote.buyer,
        OptionError::QuotePayloadMismatch
    );

    // ── Strike validation against current spot ──
    require!(
        quote.strike_exponent == ctx.accounts.price_feed.exponent,
        OptionError::PriceExponentMismatch,
    );
    let spot = ctx.accounts.price_feed.price;
    let strike_floor = spot
        .checked_mul(10_000 - STRIKE_DEVIATION_BPS)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(OptionError::MathOverflow)?;
    let strike_ceil = spot
        .checked_mul(10_000 + STRIKE_DEVIATION_BPS)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(OptionError::MathOverflow)?;
    require!(
        quote.strike >= strike_floor && quote.strike <= strike_ceil,
        OptionError::StrikeOutOfRange,
    );

    // ── Expiry validation against market tenor ──
    let expected_expiry = now
        .checked_add(ctx.accounts.market.tenor_seconds as i64)
        .ok_or(OptionError::MathOverflow)?;
    let drift = (quote.expiry - expected_expiry).abs();
    require!(drift <= EXPIRY_DRIFT_SECONDS, OptionError::ExpiryOutOfRange);

    // ── Collateral check ──
    // Worst-case max liability for a put: notional
    // For a call: also notional (spot could go to infinity, but in practice bounded)
    // We use notional as the worst-case payout for both types
    let new_liability = ctx
        .accounts
        .mm
        .outstanding_liability
        .checked_add(quote.notional)
        .ok_or(OptionError::MathOverflow)?;
    require!(
        ctx.accounts.mm_vault.amount >= new_liability,
        OptionError::InsufficientCollateral,
    );
    ctx.accounts.mm.outstanding_liability = new_liability;

    // ── Premium transfer: buyer → MM vault ──
    let cpi = CpiContext::new(
        anchor_spl::token::ID,
        Transfer {
            from: ctx.accounts.buyer_usdc.to_account_info(),
            to: ctx.accounts.mm_vault.to_account_info(),
            authority: ctx.accounts.buyer.to_account_info(),
        },
    );
    transfer(cpi, quote.premium)?;

    // ── Position init ──
    let pos = &mut ctx.accounts.position;
    pos.buyer = ctx.accounts.buyer.key();
    pos.mm = ctx.accounts.mm.key();
    pos.market = ctx.accounts.market.key();
    pos.strike = quote.strike;
    pos.strike_exponent = quote.strike_exponent;
    pos.notional = quote.notional;
    pos.premium_paid = quote.premium;
    pos.expiry = quote.expiry;
    pos.quote_nonce = quote.quote_nonce;
    pos.status = OptionPosition::STATUS_OPEN;
    pos.created_at = now;
    pos.payout_amount = 0;
    pos.settled_at = 0;
    pos.bump = ctx.bumps.position;

    emit!(QuoteFilled {
        buyer: pos.buyer,
        mm: pos.mm,
        market: pos.market,
        premium: quote.premium,
        notional: quote.notional,
        expiry: quote.expiry,
        quote_nonce: quote.quote_nonce,
    });

    Ok(())
}
