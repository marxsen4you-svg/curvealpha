//! Exact pump.fun bonding curve arithmetic, a second independent
//! implementation of `src/math/curve.ts`.
//!
//! All amounts are integers (lamports, raw token units) held in `u128` so no
//! intermediate product can overflow: the largest product in these formulas
//! is about 1e33, well under u128::MAX (3.4e38). There are no floats anywhere.
//! `tests/vectors.rs` checks every function against expected values produced
//! by pump.fun's official SDK.

pub const BPS_DENOM: u128 = 10_000;
pub const ONE_BILLION_SUPPLY: u128 = 1_000_000_000_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeeTier {
    pub market_cap_lamports_threshold: u128,
    pub lp_fee_bps: u128,
    pub protocol_fee_bps: u128,
    pub creator_fee_bps: u128,
}

#[derive(Clone, Copy, Debug)]
pub struct GlobalParams {
    pub fee_basis_points: u128,
    pub creator_fee_basis_points: u128,
    pub creator_fee_configurable: bool,
    pub pool_migration_fee: u128,
}

#[derive(Clone, Copy, Debug)]
pub struct Curve {
    pub virtual_token_reserves: u128,
    pub virtual_sol_reserves: u128,
    pub real_token_reserves: u128,
    pub real_sol_reserves: u128,
    pub complete: bool,
    pub has_creator: bool,
    pub is_mayhem_mode: bool,
    pub creator_fee_bps: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rates {
    pub protocol: u128,
    pub creator: u128,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CurveError {
    ZeroVirtualTokens,
    EmptyTiers,
    TokensExceedReserves,
    EmptyPoolToBe,
    NotEnoughTokensToBuy,
}

pub type R<T> = Result<T, CurveError>;

fn ceil_div(a: u128, b: u128) -> u128 {
    (a + b - 1) / b
}

pub fn fee(amount: u128, bps: u128) -> u128 {
    ceil_div(amount * bps, BPS_DENOM)
}

pub fn market_cap(mint_supply: u128, v_sol: u128, v_tok: u128) -> R<u128> {
    if v_tok == 0 {
        return Err(CurveError::ZeroVirtualTokens);
    }
    Ok(v_sol * mint_supply / v_tok)
}

pub fn fee_tier(tiers: &[FeeTier], mc: u128) -> R<FeeTier> {
    let first = *tiers.first().ok_or(CurveError::EmptyTiers)?;
    if mc < first.market_cap_lamports_threshold {
        return Ok(first);
    }
    for t in tiers.iter().rev() {
        if mc >= t.market_cap_lamports_threshold {
            return Ok(*t);
        }
    }
    Ok(first)
}

pub fn fee_rates(g: &GlobalParams, tiers: Option<&[FeeTier]>, mint_supply: u128, c: &Curve) -> R<Rates> {
    let mut r = match tiers {
        Some(t) => {
            let mc = market_cap(mint_supply, c.virtual_sol_reserves, c.virtual_token_reserves)?;
            let tier = fee_tier(t, mc)?;
            Rates { protocol: tier.protocol_fee_bps, creator: tier.creator_fee_bps }
        }
        None => Rates { protocol: g.fee_basis_points, creator: g.creator_fee_basis_points },
    };
    if g.creator_fee_configurable && c.creator_fee_bps != 0 {
        r.creator = c.creator_fee_bps;
    }
    Ok(r)
}

fn fee_supply(c: &Curve, mint_supply: u128) -> u128 {
    if c.is_mayhem_mode { mint_supply } else { ONE_BILLION_SUPPLY }
}

pub fn trade_fee(g: &GlobalParams, tiers: Option<&[FeeTier]>, mint_supply: u128, c: &Curve, amount: u128) -> R<u128> {
    let r = fee_rates(g, tiers, fee_supply(c, mint_supply), c)?;
    Ok(fee(amount, r.protocol) + if c.has_creator { fee(amount, r.creator) } else { 0 })
}

pub fn raw_buy_cost(tokens: u128, vt: u128, vs: u128) -> R<u128> {
    if tokens >= vt {
        return Err(CurveError::TokensExceedReserves);
    }
    Ok(tokens * vs / (vt - tokens) + 1)
}

pub fn raw_buy_tokens(net: u128, vt: u128, vs: u128) -> u128 {
    net * vt / (vs + net)
}

pub fn raw_sell_proceeds(tokens: u128, vt: u128, vs: u128) -> u128 {
    tokens * vs / (vt + tokens)
}

/// v1/v2 path: tokens for `sol` lamports (fees included).
pub fn buy_tokens_from_sol(g: &GlobalParams, tiers: Option<&[FeeTier]>, mint_supply: u128, c: &Curve, sol: u128) -> R<u128> {
    if sol == 0 || c.virtual_token_reserves == 0 {
        return Ok(0);
    }
    let r = fee_rates(g, tiers, mint_supply, c)?;
    let total = r.protocol + if c.has_creator { r.creator } else { 0 };
    let input = (sol - 1) * BPS_DENOM / (total + BPS_DENOM);
    Ok(raw_buy_tokens(input, c.virtual_token_reserves, c.virtual_sol_reserves).min(c.real_token_reserves))
}

/// v1/v2 path: lamports (fees included) to buy `tokens`.
pub fn buy_sol_from_tokens(g: &GlobalParams, tiers: Option<&[FeeTier]>, mint_supply: u128, c: &Curve, tokens: u128) -> R<u128> {
    if tokens == 0 || c.virtual_token_reserves == 0 {
        return Ok(0);
    }
    let take = tokens.min(c.real_token_reserves);
    let cost = raw_buy_cost(take, c.virtual_token_reserves, c.virtual_sol_reserves)?;
    Ok(cost + trade_fee(g, tiers, mint_supply, c, cost)?)
}

/// Lamports received after fees for selling `tokens`. Signed: on dust sells
/// the ceiled fees can exceed the gross output, which the reference SDK
/// reports as a negative amount (the program would reject the trade).
pub fn sell_sol_from_tokens(g: &GlobalParams, tiers: Option<&[FeeTier]>, mint_supply: u128, c: &Curve, tokens: u128) -> R<i128> {
    if tokens == 0 || c.virtual_token_reserves == 0 {
        return Ok(0);
    }
    let gross = raw_sell_proceeds(tokens, c.virtual_token_reserves, c.virtual_sol_reserves);
    Ok(gross as i128 - trade_fee(g, tiers, mint_supply, c, gross)? as i128)
}

pub fn v3_rates(g: &GlobalParams, tiers: &[FeeTier], mint_supply: u128, c: &Curve) -> R<Rates> {
    let r = fee_rates(g, Some(tiers), fee_supply(c, mint_supply), c)?;
    Ok(Rates { protocol: r.protocol, creator: if c.has_creator { r.creator } else { 0 } })
}

pub fn v3_fees(amount: u128, r: Rates) -> u128 {
    fee(amount, r.protocol) + fee(amount, r.creator)
}

pub fn v3_exact_quote_in_net(budget: u128, r: Rates) -> u128 {
    let total = r.protocol + r.creator;
    let mut net = if total == 0 { budget } else { budget * BPS_DENOM / (total + BPS_DENOM) };
    let cost = net + v3_fees(net, r);
    if cost > budget {
        net -= cost - budget;
    }
    net
}

fn pool_to_be(g: &GlobalParams, c: &Curve, base_balance: u128, curve_tokens: u128, curve_net: u128) -> R<(u128, u128)> {
    let raised = c.real_sol_reserves + curve_net;
    if base_balance <= curve_tokens || raised <= g.pool_migration_fee {
        return Err(CurveError::EmptyPoolToBe);
    }
    Ok((base_balance - curve_tokens, raised - g.pool_migration_fee))
}

/// `buy_v3`: lamports (fees included) for `tokens`, crossing into the pool-to-be.
pub fn v3_buy_sol_from_tokens(g: &GlobalParams, tiers: &[FeeTier], mint_supply: u128, c: &Curve, tokens: u128, base_balance: u128) -> R<u128> {
    let remaining = c.real_token_reserves;
    if tokens == 0 || c.complete || c.virtual_token_reserves == 0 {
        return Ok(0);
    }
    let r = v3_rates(g, tiers, mint_supply, c)?;
    let curve_tokens = tokens.min(remaining);
    let curve_net = raw_buy_cost(curve_tokens, c.virtual_token_reserves, c.virtual_sol_reserves)?;
    let curve_total = curve_net + v3_fees(curve_net, r);
    if tokens <= remaining || c.is_mayhem_mode {
        return Ok(curve_total);
    }
    let past = tokens - remaining;
    let (base, quote) = pool_to_be(g, c, base_balance, remaining, curve_net)?;
    if base <= past {
        return Err(CurveError::NotEnoughTokensToBuy);
    }
    let leg = (quote * past + (base - past) - 1) / (base - past);
    Ok(curve_total + leg + v3_fees(leg, r))
}

/// `buy_exact_quote_in_v3`: tokens for a budget (fees included).
pub fn v3_buy_tokens_from_sol(g: &GlobalParams, tiers: &[FeeTier], mint_supply: u128, c: &Curve, budget: u128, base_balance: u128) -> R<u128> {
    if budget == 0 || c.complete || c.virtual_token_reserves == 0 {
        return Ok(0);
    }
    let r = v3_rates(g, tiers, mint_supply, c)?;
    let net = v3_exact_quote_in_net(budget, r);
    if net <= 1 {
        return Ok(0);
    }
    let tokens = raw_buy_tokens(net - 1, c.virtual_token_reserves, c.virtual_sol_reserves);
    let remaining = c.real_token_reserves;
    if tokens <= remaining || c.is_mayhem_mode {
        return Ok(tokens.min(remaining));
    }
    let curve_net = raw_buy_cost(remaining, c.virtual_token_reserves, c.virtual_sol_reserves)?;
    let spent = curve_net + v3_fees(curve_net, r);
    if budget <= spent {
        return Ok(remaining);
    }
    let left = budget - spent;
    let total = r.protocol + r.creator;
    let after = if total == 0 { left } else { left * BPS_DENOM / (total + BPS_DENOM) };
    if after < 2 {
        return Ok(remaining);
    }
    let leg_net = v3_exact_quote_in_net(left, r);
    let (base, quote) = pool_to_be(g, c, base_balance, remaining, curve_net)?;
    Ok(remaining + (leg_net - 1) * base / (quote + leg_net - 1))
}
