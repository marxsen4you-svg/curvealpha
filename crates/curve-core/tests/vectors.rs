//! Every line of vectors.txt was computed by pump.fun's official SDK.
//! The Rust implementation must reproduce each value exactly, and must fail
//! exactly where the SDK fails.

use curve_core::*;

const FIXTURE: &[(u128, u128, u128, u128)] = &[
    (0, 2, 93, 30),
    (420000000000, 20, 5, 95),
    (1470000000000, 20, 5, 90),
    (2460000000000, 20, 5, 85),
    (3440000000000, 20, 5, 80),
    (4420000000000, 20, 5, 75),
    (9820000000000, 20, 5, 70),
    (14740000000000, 20, 5, 65),
    (19650000000000, 20, 5, 60),
    (24560000000000, 20, 5, 55),
    (29470000000000, 20, 5, 50),
    (34380000000000, 20, 5, 45),
    (39300000000000, 20, 5, 40),
    (44210000000000, 20, 5, 35),
    (49120000000000, 20, 5, 30),
    (54030000000000, 20, 5, 28),
    (58940000000000, 20, 5, 25),
    (63860000000000, 20, 5, 23),
    (68770000000000, 20, 5, 20),
    (73681000000000, 20, 5, 18),
    (78590000000000, 20, 5, 15),
    (83500000000000, 20, 5, 13),
    (88400000000000, 20, 5, 10),
    (93330000000000, 20, 5, 8),
    (98240000000000, 20, 5, 5),
];

fn tier(t: (u128, u128, u128, u128)) -> FeeTier {
    FeeTier { market_cap_lamports_threshold: t.0, lp_fee_bps: t.1, protocol_fee_bps: t.2, creator_fee_bps: t.3 }
}

fn parse_tiers(s: &str) -> Vec<FeeTier> {
    if s == "F" {
        return FIXTURE.iter().copied().map(tier).collect();
    }
    s.split(',')
        .map(|p| {
            let v: Vec<u128> = p.split(':').map(|x| x.parse().unwrap()).collect();
            tier((v[0], v[1], v[2], v[3]))
        })
        .collect()
}

#[test]
fn matches_official_sdk_on_every_vector() {
    let text = include_str!("../vectors.txt");
    let mut count = 0usize;
    for line in text.lines().filter(|l| !l.is_empty()) {
        let f: Vec<&str> = line.split(' ').collect();
        let n = |i: usize| -> u128 { f[i].parse().unwrap() };
        let curve = Curve {
            virtual_token_reserves: n(1),
            virtual_sol_reserves: n(2),
            real_token_reserves: n(3),
            real_sol_reserves: n(4),
            complete: false,
            has_creator: f[5] == "1",
            is_mayhem_mode: f[6] == "1",
            creator_fee_bps: n(7),
        };
        let g = GlobalParams {
            fee_basis_points: 95,
            creator_fee_basis_points: 30,
            creator_fee_configurable: f[8] == "1",
            pool_migration_fee: 15_000_001,
        };
        let mint_supply = n(9);
        let base_balance = n(10);
        let amount = n(11);
        let tiers = parse_tiers(f[12]);
        let want = f[13];
        let s = |r: R<u128>| r.map(|v| v as i128);
        let got: R<i128> = match f[0] {
            "buy_sol" => s(buy_tokens_from_sol(&g, Some(&tiers), mint_supply, &curve, amount)),
            "buy_cost" => s(buy_sol_from_tokens(&g, Some(&tiers), mint_supply, &curve, amount)),
            "sell" => sell_sol_from_tokens(&g, Some(&tiers), mint_supply, &curve, amount),
            "v3_in" => s(v3_buy_tokens_from_sol(&g, &tiers, mint_supply, &curve, amount, base_balance)),
            "v3_tokens" => s(v3_buy_sol_from_tokens(&g, &tiers, mint_supply, &curve, amount, base_balance)),
            k => panic!("unknown kind {k}"),
        };
        match (want, got) {
            ("ERR", Err(_)) => {}
            ("ERR", Ok(v)) => panic!("expected failure, got {v}: {line}"),
            (w, Ok(v)) => assert_eq!(w.parse::<i128>().unwrap(), v, "{line}"),
            (w, Err(e)) => panic!("expected {w}, got {e:?}: {line}"),
        }
        count += 1;
    }
    assert!(count >= 10_000, "only {count} vectors");
}
