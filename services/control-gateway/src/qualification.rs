use std::collections::BTreeMap;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CapacityProfile {
    pub name: String,
    pub fleet_size: u64,
    pub regions: u32,
    pub gateways_per_region: u32,
    pub gateway_max_connections: u64,
    pub target_utilization_bps: u32,
    pub max_failover_utilization_bps: u32,
    pub heartbeat_interval_seconds: u64,
    pub reconnect_jitter_seconds: u64,
    pub max_reconnects_per_second_per_gateway: u64,
    pub max_heartbeat_writes_per_second_per_gateway: u64,
    pub command_fanout_per_second: u64,
    pub max_command_dispatch_per_second_per_gateway: u64,
    pub seed: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualificationCheck {
    pub name: String,
    pub passed: bool,
    pub observed: u64,
    pub limit: u64,
    pub unit: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapacityModelReport {
    pub schema_version: u32,
    pub profile: String,
    pub passed: bool,
    pub fleet_size: u64,
    pub total_gateways: u64,
    pub total_connection_capacity: u64,
    pub normal_utilization_bps: u64,
    pub failover_utilization_bps: u64,
    pub heartbeat_writes_per_second: u64,
    pub heartbeat_writes_per_second_per_gateway: u64,
    pub failed_region_agents: u64,
    pub reconnect_jitter_seconds: u64,
    pub peak_reconnects_per_second: u64,
    pub peak_reconnects_per_second_per_surviving_gateway: u64,
    pub command_fanout_per_second_per_gateway: u64,
    pub reconnect_distribution: BTreeMap<u64, u64>,
    pub checks: Vec<QualificationCheck>,
}

impl CapacityProfile {
    pub fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty() || self.name.len() > 120 {
            bail!("capacity profile name invalid");
        }
        if self.fleet_size == 0 {
            bail!("fleet_size must be positive");
        }
        if self.regions < 2 || self.regions > 32 {
            bail!("regions must be between 2 and 32");
        }
        if self.gateways_per_region == 0 || self.gateways_per_region > 10_000 {
            bail!("gateways_per_region invalid");
        }
        if self.gateway_max_connections == 0 || self.gateway_max_connections > 1_000_000 {
            bail!("gateway_max_connections invalid");
        }
        if !(1..=10_000).contains(&self.target_utilization_bps)
            || !(1..=10_000).contains(&self.max_failover_utilization_bps)
            || self.target_utilization_bps > self.max_failover_utilization_bps
        {
            bail!("utilization basis points invalid");
        }
        if self.heartbeat_interval_seconds < 5 || self.heartbeat_interval_seconds > 300 {
            bail!("heartbeat_interval_seconds invalid");
        }
        if self.reconnect_jitter_seconds == 0 || self.reconnect_jitter_seconds > 3_600 {
            bail!("reconnect_jitter_seconds invalid");
        }
        if self.max_reconnects_per_second_per_gateway == 0
            || self.max_heartbeat_writes_per_second_per_gateway == 0
            || self.max_command_dispatch_per_second_per_gateway == 0
        {
            bail!("capacity limits must be positive");
        }
        Ok(())
    }
}

pub fn run_capacity_model(profile: &CapacityProfile) -> Result<CapacityModelReport> {
    profile.validate()?;
    let total_gateways = u64::from(profile.regions) * u64::from(profile.gateways_per_region);
    let surviving_gateways =
        u64::from(profile.regions - 1) * u64::from(profile.gateways_per_region);
    let total_capacity = total_gateways.saturating_mul(profile.gateway_max_connections);
    let surviving_capacity = surviving_gateways.saturating_mul(profile.gateway_max_connections);
    let normal_utilization_bps = ratio_bps(profile.fleet_size, total_capacity);
    let failover_utilization_bps = ratio_bps(profile.fleet_size, surviving_capacity);
    let heartbeat_writes_per_second =
        ceil_div(profile.fleet_size, profile.heartbeat_interval_seconds);
    let heartbeat_per_gateway = ceil_div(heartbeat_writes_per_second, total_gateways);
    let failed_region_agents = ceil_div(profile.fleet_size, u64::from(profile.regions));
    let reconnect_distribution = reconnect_distribution(
        failed_region_agents,
        profile.reconnect_jitter_seconds,
        profile.seed,
    );
    let peak_reconnects_per_second = reconnect_distribution.values().copied().max().unwrap_or(0);
    let peak_reconnect_per_surviving = ceil_div(peak_reconnects_per_second, surviving_gateways);
    let command_per_gateway = ceil_div(profile.command_fanout_per_second, total_gateways);

    let checks = vec![
        check(
            "normal_connection_utilization",
            normal_utilization_bps,
            u64::from(profile.target_utilization_bps),
            "basis_points",
        ),
        check(
            "single_region_failure_utilization",
            failover_utilization_bps,
            u64::from(profile.max_failover_utilization_bps),
            "basis_points",
        ),
        check(
            "heartbeat_write_budget_per_gateway",
            heartbeat_per_gateway,
            profile.max_heartbeat_writes_per_second_per_gateway,
            "writes_per_second",
        ),
        check(
            "regional_reconnect_storm_budget_per_gateway",
            peak_reconnect_per_surviving,
            profile.max_reconnects_per_second_per_gateway,
            "connects_per_second",
        ),
        check(
            "command_fanout_budget_per_gateway",
            command_per_gateway,
            profile.max_command_dispatch_per_second_per_gateway,
            "commands_per_second",
        ),
    ];
    let passed = checks.iter().all(|item| item.passed);

    Ok(CapacityModelReport {
        schema_version: 1,
        profile: profile.name.clone(),
        passed,
        fleet_size: profile.fleet_size,
        total_gateways,
        total_connection_capacity: total_capacity,
        normal_utilization_bps,
        failover_utilization_bps,
        heartbeat_writes_per_second,
        heartbeat_writes_per_second_per_gateway: heartbeat_per_gateway,
        failed_region_agents,
        reconnect_jitter_seconds: profile.reconnect_jitter_seconds,
        peak_reconnects_per_second,
        peak_reconnects_per_second_per_surviving_gateway: peak_reconnect_per_surviving,
        command_fanout_per_second_per_gateway: command_per_gateway,
        reconnect_distribution,
        checks,
    })
}

fn check(name: &str, observed: u64, limit: u64, unit: &str) -> QualificationCheck {
    QualificationCheck {
        name: name.to_owned(),
        passed: observed <= limit,
        observed,
        limit,
        unit: unit.to_owned(),
    }
}

fn reconnect_distribution(agents: u64, jitter_seconds: u64, seed: u64) -> BTreeMap<u64, u64> {
    let mut buckets = BTreeMap::new();
    let mut state = seed ^ 0x9e37_79b9_7f4a_7c15;
    for index in 0..agents {
        state = splitmix64(state.wrapping_add(index).wrapping_add(1));
        let second = state % jitter_seconds;
        *buckets.entry(second).or_insert(0) += 1;
    }
    buckets
}

fn splitmix64(mut value: u64) -> u64 {
    value = value.wrapping_add(0x9e37_79b9_7f4a_7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn ratio_bps(numerator: u64, denominator: u64) -> u64 {
    if denominator == 0 {
        return u64::MAX;
    }
    numerator.saturating_mul(10_000).div_ceil(denominator)
}

fn ceil_div(numerator: u64, denominator: u64) -> u64 {
    if denominator == 0 {
        return u64::MAX;
    }
    numerator.div_ceil(denominator)
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencySummary {
    pub samples: u64,
    pub min_ms: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
    pub max_ms: u64,
}

pub fn summarize_latencies(values: &mut [u64]) -> LatencySummary {
    if values.is_empty() {
        return LatencySummary::default();
    }
    values.sort_unstable();
    LatencySummary {
        samples: values.len() as u64,
        min_ms: values[0],
        p50_ms: percentile(values, 50),
        p95_ms: percentile(values, 95),
        p99_ms: percentile(values, 99),
        max_ms: values[values.len() - 1],
    }
}

fn percentile(values: &[u64], percentile: usize) -> u64 {
    let index = ((values.len() - 1) * percentile).div_ceil(100);
    values[index.min(values.len() - 1)]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn million_profile() -> CapacityProfile {
        CapacityProfile {
            name: "million-fleet-n-plus-one".into(),
            fleet_size: 1_000_000,
            regions: 3,
            gateways_per_region: 13,
            gateway_max_connections: 50_000,
            target_utilization_bps: 7_000,
            max_failover_utilization_bps: 8_000,
            heartbeat_interval_seconds: 15,
            reconnect_jitter_seconds: 120,
            max_reconnects_per_second_per_gateway: 400,
            max_heartbeat_writes_per_second_per_gateway: 2_500,
            command_fanout_per_second: 5_000,
            max_command_dispatch_per_second_per_gateway: 1_000,
            seed: 42,
        }
    }

    #[test]
    fn million_fleet_profile_survives_one_region_with_headroom() {
        let report = run_capacity_model(&million_profile()).unwrap();
        assert!(report.passed);
        assert_eq!(report.fleet_size, 1_000_000);
        assert_eq!(report.total_gateways, 39);
        assert!(report.failover_utilization_bps <= 8_000);
        assert!(report.peak_reconnects_per_second_per_surviving_gateway <= 400);
    }

    #[test]
    fn underprovisioned_profile_fails_instead_of_hiding_capacity_debt() {
        let mut profile = million_profile();
        profile.gateways_per_region = 5;
        let report = run_capacity_model(&profile).unwrap();
        assert!(!report.passed);
        assert!(report.checks.iter().any(|item| !item.passed));
    }

    #[test]
    fn reconnect_distribution_is_deterministic_for_reproducible_incidents() {
        let one = reconnect_distribution(100_000, 60, 99);
        let two = reconnect_distribution(100_000, 60, 99);
        assert_eq!(one, two);
        assert_eq!(one.values().sum::<u64>(), 100_000);
    }

    #[test]
    fn latency_summary_is_bounded_and_stable() {
        let mut values = vec![10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
        let summary = summarize_latencies(&mut values);
        assert_eq!(summary.samples, 10);
        assert_eq!(summary.min_ms, 10);
        assert_eq!(summary.p50_ms, 60);
        assert_eq!(summary.p95_ms, 100);
        assert_eq!(summary.p99_ms, 100);
        assert_eq!(summary.max_ms, 100);
    }
}
