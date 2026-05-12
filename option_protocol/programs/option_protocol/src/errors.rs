use anchor_lang::prelude::*;

#[error_code]
pub enum OptionError {
    #[msg("Registry is paused")]
    RegistryPaused,
    #[msg("Market is inactive")]
    MarketInactive,
    #[msg("Market maker is inactive")]
    MmInactive,
    #[msg("Notional below market minimum")]
    NotionalTooSmall,
    #[msg("Notional above market maximum")]
    NotionalTooLarge,
    #[msg("Tenor out of allowed range")]
    TenorOutOfRange,
    #[msg("Quote expired")]
    QuoteExpired,
    #[msg("Quote signer mismatch")]
    QuoteSignerMismatch,
    #[msg("Quote payload mismatch")]
    QuotePayloadMismatch,
    #[msg("Missing ed25519 verify instruction")]
    MissingEd25519Verify,
    #[msg("Malformed ed25519 instruction")]
    MalformedEd25519,
    #[msg("Price feed stale")]
    PriceStale,
    #[msg("Position not yet expired")]
    PositionNotExpired,
    #[msg("Position already settled")]
    PositionAlreadySettled,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Admin only")]
    AdminOnly,
    #[msg("Market PDA does not match position's market")]
    MarketMismatch,
    #[msg("Price feed PDA does not match market's price feed")]
    PriceFeedMismatch,
    #[msg("MM PDA does not match position's MM")]
    MmMismatch,
    #[msg("Buyer token account owner mismatch")]
    BuyerMismatch,
    #[msg("Invalid price")]
    InvalidPrice,
    #[msg("Price exponent mismatch with position strike exponent")]
    PriceExponentMismatch,
    #[msg("MM authority mismatch")]
    MmAuthorityMismatch,
    #[msg("Price feed authority mismatch")]
    PriceFeedAuthorityMismatch,
    #[msg("MM vault address mismatch")]
    MmVaultMismatch,
    #[msg("Invalid option kind — must be 0 (put) or 1 (call)")]
    InvalidOptionKind,
    #[msg("Quote mint does not match registry's canonical USDC mint")]
    QuoteMintMismatch,
    #[msg("MM vault has insufficient collateral for new position")]
    InsufficientCollateral,
    #[msg("Strike price out of allowed range relative to spot")]
    StrikeOutOfRange,
    #[msg("Expiry out of allowed range relative to market tenor")]
    ExpiryOutOfRange,
    #[msg("Withdrawal would break collateralization")]
    InsufficientFreeCollateral,
    #[msg("MM must be inactive to withdraw")]
    MmMustBeInactive,
}
