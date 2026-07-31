use serde::{Deserialize, Serialize};

pub const MANAGED_POOL_FEE_BPS: u16 = 100;
pub const BASIS_POINTS_DENOMINATOR: u128 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MiningFeeMode {
    ManagedGpuBnbPool,
    ExternalPool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RewardSplit {
    pub gross_atomic_units: u128,
    pub owner_atomic_units: u128,
    pub platform_atomic_units: u128,
    pub fee_basis_points: u16,
}

pub fn calculate_reward_split(gross_atomic_units: u128, mode: MiningFeeMode) -> RewardSplit {
    let fee_basis_points = match mode {
        MiningFeeMode::ManagedGpuBnbPool => MANAGED_POOL_FEE_BPS,
        MiningFeeMode::ExternalPool => 0,
    };

    let platform_atomic_units =
        gross_atomic_units.saturating_mul(fee_basis_points as u128) / BASIS_POINTS_DENOMINATOR;
    let owner_atomic_units = gross_atomic_units.saturating_sub(platform_atomic_units);

    RewardSplit {
        gross_atomic_units,
        owner_atomic_units,
        platform_atomic_units,
        fee_basis_points,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_pool_charges_exactly_one_percent() {
        let split = calculate_reward_split(1_000_000, MiningFeeMode::ManagedGpuBnbPool);
        assert_eq!(split.platform_atomic_units, 10_000);
        assert_eq!(split.owner_atomic_units, 990_000);
        assert_eq!(split.fee_basis_points, 100);
    }

    #[test]
    fn external_pool_is_always_zero_fee() {
        let split = calculate_reward_split(u128::MAX, MiningFeeMode::ExternalPool);
        assert_eq!(split.platform_atomic_units, 0);
        assert_eq!(split.owner_atomic_units, u128::MAX);
        assert_eq!(split.fee_basis_points, 0);
    }
}
