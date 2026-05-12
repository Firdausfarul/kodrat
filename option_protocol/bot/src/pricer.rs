use std::f64::consts::TAU;

pub fn put_atm_premium(spot: f64, vol: f64, tenor_seconds: u32) -> f64 {
    let t_years = tenor_seconds as f64 / (365.0 * 24.0 * 3600.0);
    spot * vol * t_years.sqrt() / TAU.sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() < tol
    }

    #[test]
    fn premium_scales_with_sqrt_t() {
        let p7 = put_atm_premium(16_000.0, 0.10, 60 * 60 * 24 * 7);
        let p30 = put_atm_premium(16_000.0, 0.10, 60 * 60 * 24 * 30);
        let ratio = p30 / p7;
        assert!(approx(ratio, (30f64 / 7f64).sqrt(), 1e-6));
    }

    #[test]
    fn premium_is_about_one_percent_of_spot_for_30d_10pct_vol() {
        let p = put_atm_premium(16_000.0, 0.10, 60 * 60 * 24 * 30);
        let pct = p / 16_000.0;
        assert!(pct > 0.005 && pct < 0.02, "got {pct}");
    }
}
