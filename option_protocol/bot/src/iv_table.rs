use crate::quote::Pair;

const IV_7D: f64 = 0.08;
const IV_30D: f64 = 0.12;
const IV_60D: f64 = 0.15;
const IV_7D_JPY: f64 = 0.06;
const IV_30D_JPY: f64 = 0.09;
const IV_60D_JPY: f64 = 0.11;

pub fn lookup(pair: Pair, tenor_seconds: u32) -> Option<f64> {
    let (short_tenor, short_iv, long_tenor, long_iv) = match pair {
        Pair::UsdIdr => (604_800, IV_7D, 2_592_000, IV_30D),
        Pair::UsdJpy => (604_800, IV_7D_JPY, 2_592_000, IV_30D_JPY),
        Pair::JpyIdr => (604_800, IV_7D, 2_592_000, IV_30D),
        Pair::CnyIdr => (604_800, IV_7D, 2_592_000, IV_30D),
        Pair::CnyUsd => (604_800, IV_7D_JPY, 2_592_000, IV_30D_JPY),
    };

    let t = tenor_seconds as f64;
    let t_short = short_tenor as f64;
    let t_long = long_tenor as f64;

    if t <= t_short {
        Some(short_iv)
    } else if t >= t_long {
        let (t60, iv60) = match pair {
            Pair::UsdIdr => (5_184_000f64, IV_60D),
            Pair::UsdJpy => (5_184_000f64, IV_60D_JPY),
            Pair::JpyIdr => (5_184_000f64, IV_60D),
            Pair::CnyIdr => (5_184_000f64, IV_60D),
            Pair::CnyUsd => (5_184_000f64, IV_60D_JPY),
        };
        if t >= t60 {
            Some(iv60)
        } else {
            let slope = (iv60 - long_iv) / (t60 - t_long);
            Some(long_iv + slope * (t - t_long))
        }
    } else {
        let frac = (t - t_short) / (t_long - t_short);
        Some(short_iv + frac * (long_iv - short_iv))
    }
}
