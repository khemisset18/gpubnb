use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWxTWqkZq26fPRmKZX54C9V8uB9m");

const COMMISSION_BPS: u64 = 500;
const BPS: u64 = 10_000;
const FULL_PAY_THRESHOLD_BPS: u64 = 9_000;
const DISPUTE_WINDOW_SECONDS: i64 = 3_600;
const MAX_BOOKING_SECONDS: u32 = 86_400;
const MAX_EXPIRY_SECONDS: i64 = 7 * 86_400;

#[program]
pub mod gpu_escrow {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        platform: Pubkey,
        oracle: Pubkey,
    ) -> Result<()> {
        require!(
            platform != Pubkey::default() && oracle != Pubkey::default(),
            ErrorCode::InvalidAddress
        );
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.platform = platform;
        c.oracle = oracle;
        c.paused = false;
        c.pending_admin = Pubkey::default();
        c.bump = ctx.bumps.config;
        emit!(ConfigInitialized {
            admin: c.admin,
            platform,
            oracle
        });
        Ok(())
    }

    pub fn update_config(
        ctx: Context<AdminConfig>,
        platform: Pubkey,
        oracle: Pubkey,
    ) -> Result<()> {
        require!(
            platform != Pubkey::default() && oracle != Pubkey::default(),
            ErrorCode::InvalidAddress
        );
        let c = &mut ctx.accounts.config;
        c.platform = platform;
        c.oracle = oracle;
        emit!(ConfigUpdated { platform, oracle });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(PauseChanged { paused });
        Ok(())
    }

    pub fn propose_admin(ctx: Context<AdminConfig>, pending_admin: Pubkey) -> Result<()> {
        require!(
            pending_admin != Pubkey::default() && pending_admin != ctx.accounts.config.admin,
            ErrorCode::InvalidAddress
        );
        ctx.accounts.config.pending_admin = pending_admin;
        emit!(AdminTransferProposed {
            current_admin: ctx.accounts.config.admin,
            pending_admin
        });
        Ok(())
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        require!(
            c.pending_admin == ctx.accounts.pending_admin.key(),
            ErrorCode::Unauthorized
        );
        let previous_admin = c.admin;
        c.admin = c.pending_admin;
        c.pending_admin = Pubkey::default();
        emit!(AdminTransferred {
            previous_admin,
            new_admin: c.admin
        });
        Ok(())
    }

    pub fn open(
        ctx: Context<Open>,
        booking: [u8; 32],
        amount: u64,
        expected_seconds: u32,
        expires_at: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(!ctx.accounts.config.paused, ErrorCode::Paused);
        require!(
            amount > 0 && expected_seconds > 0 && expected_seconds <= MAX_BOOKING_SECONDS,
            ErrorCode::InvalidInput
        );
        require!(
            expires_at > now
                && expires_at <= now.checked_add(MAX_EXPIRY_SECONDS).ok_or(ErrorCode::Math)?,
            ErrorCode::InvalidExpiry
        );
        require!(
            ctx.accounts.provider.key() != ctx.accounts.buyer.key(),
            ErrorCode::SelfBooking
        );

        let e = &mut ctx.accounts.escrow;
        e.booking = booking;
        e.buyer = ctx.accounts.buyer.key();
        e.provider = ctx.accounts.provider.key();
        e.amount = amount;
        e.expected_seconds = expected_seconds;
        e.valid_seconds = 0;
        e.expires_at = expires_at;
        e.settle_after = 0;
        e.state = EscrowState::Funded as u8;
        e.bump = ctx.bumps.escrow;

        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.buyer.key(),
            &e.key(),
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.buyer.to_account_info(),
                e.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
        emit!(EscrowOpened {
            escrow: e.key(),
            booking,
            buyer: e.buyer,
            provider: e.provider,
            amount,
            expected_seconds,
            expires_at
        });
        Ok(())
    }

    pub fn propose_settlement(ctx: Context<ProposeSettlement>, valid_seconds: u32) -> Result<()> {
        require!(!ctx.accounts.config.paused, ErrorCode::Paused);
        let e = &mut ctx.accounts.escrow;
        require!(
            e.state == EscrowState::Funded as u8,
            ErrorCode::InvalidState
        );
        require!(valid_seconds <= e.expected_seconds, ErrorCode::InvalidInput);
        e.valid_seconds = valid_seconds;
        e.settle_after = Clock::get()?
            .unix_timestamp
            .checked_add(DISPUTE_WINDOW_SECONDS)
            .ok_or(ErrorCode::Math)?;
        e.state = EscrowState::SettlementProposed as u8;
        emit!(SettlementProposed {
            escrow: e.key(),
            valid_seconds,
            settle_after: e.settle_after
        });
        Ok(())
    }

    pub fn dispute(ctx: Context<Dispute>) -> Result<()> {
        let e = &mut ctx.accounts.escrow;
        require!(
            e.state == EscrowState::SettlementProposed as u8,
            ErrorCode::InvalidState
        );
        require!(
            Clock::get()?.unix_timestamp < e.settle_after,
            ErrorCode::DisputeWindowClosed
        );
        e.state = EscrowState::Disputed as u8;
        emit!(EscrowDisputed {
            escrow: e.key(),
            buyer: e.buyer
        });
        Ok(())
    }

    pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
        require!(
            ctx.accounts.escrow.state == EscrowState::SettlementProposed as u8,
            ErrorCode::InvalidState
        );
        require!(
            Clock::get()?.unix_timestamp >= ctx.accounts.escrow.settle_after,
            ErrorCode::TooEarly
        );
        let valid_seconds = ctx.accounts.escrow.valid_seconds;
        settle(
            &mut ctx.accounts.escrow,
            &ctx.accounts.buyer,
            &ctx.accounts.provider,
            &ctx.accounts.platform,
            valid_seconds,
        )
    }

    pub fn resolve_dispute(ctx: Context<ResolveDispute>, valid_seconds: u32) -> Result<()> {
        require!(
            ctx.accounts.escrow.state == EscrowState::Disputed as u8,
            ErrorCode::InvalidState
        );
        require!(
            valid_seconds <= ctx.accounts.escrow.expected_seconds,
            ErrorCode::InvalidInput
        );
        settle(
            &mut ctx.accounts.escrow,
            &ctx.accounts.buyer,
            &ctx.accounts.provider,
            &ctx.accounts.platform,
            valid_seconds,
        )
    }

    pub fn refund_expired(ctx: Context<RefundExpired>) -> Result<()> {
        let e = &mut ctx.accounts.escrow;
        require!(
            e.state == EscrowState::Funded as u8,
            ErrorCode::InvalidState
        );
        require!(
            Clock::get()?.unix_timestamp >= e.expires_at,
            ErrorCode::TooEarly
        );
        let amount = e.amount;
        transfer_lamports(
            &e.to_account_info(),
            &ctx.accounts.buyer.to_account_info(),
            amount,
        )?;
        e.state = EscrowState::Refunded as u8;
        emit!(EscrowRefunded {
            escrow: e.key(),
            buyer: e.buyer,
            amount
        });
        Ok(())
    }
}

fn settle<'info>(
    e: &mut Account<'info, Escrow>,
    buyer: &UncheckedAccount<'info>,
    provider: &UncheckedAccount<'info>,
    platform: &UncheckedAccount<'info>,
    valid_seconds: u32,
) -> Result<()> {
    let (payable, platform_amount, provider_amount, refund) =
        settlement_amounts(e.amount, valid_seconds, e.expected_seconds)?;
    transfer_lamports(
        &e.to_account_info(),
        &provider.to_account_info(),
        provider_amount,
    )?;
    transfer_lamports(
        &e.to_account_info(),
        &platform.to_account_info(),
        platform_amount,
    )?;
    transfer_lamports(&e.to_account_info(), &buyer.to_account_info(), refund)?;
    e.valid_seconds = valid_seconds;
    e.state = EscrowState::Settled as u8;
    emit!(EscrowSettled {
        escrow: e.key(),
        payable,
        platform_amount,
        provider_amount,
        refund,
        valid_seconds
    });
    Ok(())
}

fn settlement_amounts(
    amount: u64,
    valid_seconds: u32,
    expected_seconds: u32,
) -> Result<(u64, u64, u64, u64)> {
    require!(
        expected_seconds > 0 && valid_seconds <= expected_seconds,
        ErrorCode::InvalidInput
    );
    let availability = (valid_seconds as u128)
        .checked_mul(BPS as u128)
        .ok_or(ErrorCode::Math)?
        / expected_seconds as u128;
    let payable = if availability >= FULL_PAY_THRESHOLD_BPS as u128 {
        amount
    } else {
        ((amount as u128)
            .checked_mul(valid_seconds as u128)
            .ok_or(ErrorCode::Math)?
            / expected_seconds as u128) as u64
    };
    let platform_amount = ((payable as u128)
        .checked_mul(COMMISSION_BPS as u128)
        .ok_or(ErrorCode::Math)?
        / BPS as u128) as u64;
    let provider_amount = payable
        .checked_sub(platform_amount)
        .ok_or(ErrorCode::Math)?;
    let refund = amount.checked_sub(payable).ok_or(ErrorCode::Math)?;
    Ok((payable, platform_amount, provider_amount, refund))
}

fn transfer_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    **from.try_borrow_mut_lamports()? =
        from.lamports().checked_sub(amount).ok_or(ErrorCode::Math)?;
    **to.try_borrow_mut_lamports()? = to.lamports().checked_add(amount).ok_or(ErrorCode::Math)?;
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub pending_admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(booking: [u8; 32])]
pub struct Open<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: destination wallet is stored and constrained during settlement.
    pub provider: UncheckedAccount<'info>,
    #[account(init, payer = buyer, space = 8 + Escrow::INIT_SPACE, seeds = [b"escrow", booking.as_ref()], bump)]
    pub escrow: Account<'info, Escrow>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProposeSettlement<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = oracle)]
    pub config: Account<'info, Config>,
    pub oracle: Signer<'info>,
    #[account(mut, seeds = [b"escrow", escrow.booking.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
pub struct Dispute<'info> {
    pub buyer: Signer<'info>,
    #[account(mut, seeds = [b"escrow", escrow.booking.as_ref()], bump = escrow.bump, has_one = buyer)]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
pub struct Finalize<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = platform)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"escrow", escrow.booking.as_ref()], bump = escrow.bump, has_one = buyer, has_one = provider, close = buyer)]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: constrained by escrow and receives refund plus closed-account rent.
    #[account(mut)]
    pub buyer: UncheckedAccount<'info>,
    /// CHECK: constrained by escrow.
    #[account(mut)]
    pub provider: UncheckedAccount<'info>,
    /// CHECK: constrained by config.
    #[account(mut)]
    pub platform: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin, has_one = platform)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"escrow", escrow.booking.as_ref()], bump = escrow.bump, has_one = buyer, has_one = provider, close = buyer)]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: constrained by escrow.
    #[account(mut)]
    pub buyer: UncheckedAccount<'info>,
    /// CHECK: constrained by escrow.
    #[account(mut)]
    pub provider: UncheckedAccount<'info>,
    /// CHECK: constrained by config.
    #[account(mut)]
    pub platform: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RefundExpired<'info> {
    #[account(mut, seeds = [b"escrow", escrow.booking.as_ref()], bump = escrow.bump, has_one = buyer, close = buyer)]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: constrained by escrow and receives refund plus closed-account rent.
    #[account(mut)]
    pub buyer: UncheckedAccount<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub platform: Pubkey,
    pub oracle: Pubkey,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub booking: [u8; 32],
    pub buyer: Pubkey,
    pub provider: Pubkey,
    pub amount: u64,
    pub expected_seconds: u32,
    pub valid_seconds: u32,
    pub expires_at: i64,
    pub settle_after: i64,
    pub state: u8,
    pub bump: u8,
}

#[repr(u8)]
pub enum EscrowState {
    Funded = 0,
    SettlementProposed = 1,
    Disputed = 2,
    Settled = 3,
    Refunded = 4,
}

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub platform: Pubkey,
    pub oracle: Pubkey,
}
#[event]
pub struct ConfigUpdated {
    pub platform: Pubkey,
    pub oracle: Pubkey,
}
#[event]
pub struct PauseChanged {
    pub paused: bool,
}
#[event]
pub struct AdminTransferProposed {
    pub current_admin: Pubkey,
    pub pending_admin: Pubkey,
}
#[event]
pub struct AdminTransferred {
    pub previous_admin: Pubkey,
    pub new_admin: Pubkey,
}
#[event]
pub struct EscrowOpened {
    pub escrow: Pubkey,
    pub booking: [u8; 32],
    pub buyer: Pubkey,
    pub provider: Pubkey,
    pub amount: u64,
    pub expected_seconds: u32,
    pub expires_at: i64,
}
#[event]
pub struct SettlementProposed {
    pub escrow: Pubkey,
    pub valid_seconds: u32,
    pub settle_after: i64,
}
#[event]
pub struct EscrowDisputed {
    pub escrow: Pubkey,
    pub buyer: Pubkey,
}
#[event]
pub struct EscrowSettled {
    pub escrow: Pubkey,
    pub payable: u64,
    pub platform_amount: u64,
    pub provider_amount: u64,
    pub refund: u64,
    pub valid_seconds: u32,
}
#[event]
pub struct EscrowRefunded {
    pub escrow: Pubkey,
    pub buyer: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("program paused")]
    Paused,
    #[msg("invalid input")]
    InvalidInput,
    #[msg("invalid expiry")]
    InvalidExpiry,
    #[msg("invalid state")]
    InvalidState,
    #[msg("too early")]
    TooEarly,
    #[msg("math error")]
    Math,
    #[msg("invalid address")]
    InvalidAddress,
    #[msg("buyer and provider must differ")]
    SelfBooking,
    #[msg("dispute window is closed")]
    DisputeWindowClosed,
    #[msg("unauthorized")]
    Unauthorized,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_payment_at_90_percent() {
        assert_eq!(
            settlement_amounts(1_000_000, 900, 1000).unwrap(),
            (1_000_000, 50_000, 950_000, 0)
        );
    }
    #[test]
    fn proportional_under_threshold() {
        assert_eq!(
            settlement_amounts(1_000_000, 500, 1000).unwrap(),
            (500_000, 25_000, 475_000, 500_000)
        );
    }
    #[test]
    fn zero_usage_refunds_everything() {
        assert_eq!(
            settlement_amounts(1_000_000, 0, 1000).unwrap(),
            (0, 0, 0, 1_000_000)
        );
    }
    #[test]
    fn rejects_usage_above_expected() {
        assert!(settlement_amounts(1_000_000, 1001, 1000).is_err());
    }
    #[test]
    fn rejects_zero_expected_duration() {
        assert!(settlement_amounts(1_000_000, 0, 0).is_err());
    }
    #[test]
    fn handles_maximum_amount_without_overflow() {
        let (payable, fee, provider, refund) = settlement_amounts(u64::MAX, 1000, 1000).unwrap();
        assert_eq!(payable, u64::MAX);
        assert_eq!(provider.checked_add(fee).unwrap(), payable);
        assert_eq!(refund, 0);
    }
}
