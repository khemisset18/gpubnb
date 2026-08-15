use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

pub const MAX_CONNECTIONS_PER_INJECTOR: u64 = 200_000;
pub const MAX_INJECTORS: u64 = 10_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DistributedLabProfile {
    pub schema_version: u32,
    pub name: String,
    pub fleet_size: u64,
    pub machine_id_start: u64,
    pub connections_per_injector: u64,
    pub seed: u64,
    pub regions: Vec<LabRegionProfile>,
    pub slo: LabSlo,
    pub stages: Vec<ChaosStage>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LabRegionProfile {
    pub name: String,
    pub injectors: u32,
    pub gateways: u32,
    pub gateway_max_connections: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LabSlo {
    pub max_normal_utilization_bps: u32,
    pub max_failover_utilization_bps: u32,
    pub max_reconnects_per_second_per_gateway: u64,
    pub max_connection_failure_bps: u64,
    pub max_heartbeat_failure_bps: u64,
    pub max_presence_failure_bps: u64,
    pub max_connect_p99_ms: u64,
    pub max_presence_p99_ms: u64,
    pub max_gateway_cpu_bps: u32,
    pub max_gateway_rss_bytes: u64,
    pub max_gateway_open_fds: u64,
    pub max_gateway_udp_errors: u64,
    pub max_redis_p99_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ChaosStage {
    pub name: String,
    pub kind: ChaosStageKind,
    pub duration_seconds: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_gateways: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reconnect_jitter_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packet_loss_bps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added_latency_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChaosStageKind {
    Baseline,
    ReconnectStorm,
    GatewayLoss,
    RegionLoss,
    NetworkImpairment,
    RedisOutage,
    Soak,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectorShard {
    pub shard_id: String,
    pub region: String,
    pub machine_id_start: u64,
    pub machine_id_end: u64,
    pub connections: u64,
    pub seed: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabManifest {
    pub schema_version: u32,
    pub run_id: String,
    pub profile: String,
    pub fleet_size: u64,
    pub shards: Vec<InjectorShard>,
    pub regions: Vec<LabRegionProfile>,
    pub slo: LabSlo,
    pub stages: Vec<ChaosStage>,
    pub checks: Vec<LabCheck>,
    pub passed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabCheck {
    pub name: String,
    pub passed: bool,
    pub observed: u64,
    pub limit: u64,
    pub unit: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceLatency {
    pub samples: u64,
    pub min_ms: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
    pub max_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShardLiveEvidence {
    pub schema_version: u32,
    pub run_id: String,
    pub shard_id: String,
    pub region: String,
    pub scenario: String,
    pub machine_id_start: u64,
    pub requested_connections: u64,
    pub successful_connections: u64,
    pub failed_connections: u64,
    pub heartbeat_attempts: u64,
    pub heartbeat_failures: u64,
    pub presence_probe_attempts: u64,
    pub presence_probe_failures: u64,
    pub connect_latency: EvidenceLatency,
    pub presence_commit_latency: EvidenceLatency,
    pub failure_reasons: BTreeMap<String, u64>,
    pub passed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributedEvidenceReport {
    pub schema_version: u32,
    pub run_id: String,
    pub profile: String,
    pub scenario: String,
    pub expected_shards: u64,
    pub observed_shards: u64,
    pub requested_connections: u64,
    pub successful_connections: u64,
    pub failed_connections: u64,
    pub heartbeat_attempts: u64,
    pub heartbeat_failures: u64,
    pub presence_probe_attempts: u64,
    pub presence_probe_failures: u64,
    pub connection_failure_bps: u64,
    pub heartbeat_failure_bps: u64,
    pub presence_failure_bps: u64,
    pub conservative_connect_p99_ms: u64,
    pub conservative_presence_p99_ms: u64,
    pub shard_failures: BTreeMap<String, u64>,
    pub checks: Vec<LabCheck>,
    pub passed: bool,
}

pub fn validate_run_id(run_id: &str) -> Result<()> {
    if !(2..=48).contains(&run_id.len())
        || !run_id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        })
    {
        bail!("run_id must be 2..48 lowercase alphanumeric, '-' or '_'");
    }
    Ok(())
}

impl DistributedLabProfile {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != 1 {
            bail!("distributed lab schema_version must be 1");
        }
        if self.name.trim().is_empty() || self.name.len() > 120 {
            bail!("distributed lab profile name invalid");
        }
        if self.fleet_size == 0 {
            bail!("fleet_size must be positive");
        }
        if self.connections_per_injector == 0
            || self.connections_per_injector > MAX_CONNECTIONS_PER_INJECTOR
        {
            bail!("connections_per_injector outside hard bound");
        }
        if self.regions.len() < 2 || self.regions.len() > 32 {
            bail!("distributed lab requires 2..32 regions");
        }
        let mut region_names = BTreeSet::new();
        let mut total_injectors = 0_u64;
        for region in &self.regions {
            validate_region_name(&region.name)?;
            if !region_names.insert(region.name.clone()) {
                bail!("duplicate region {}", region.name);
            }
            if region.injectors == 0 || region.gateways == 0 {
                bail!(
                    "region {} requires positive injectors and gateways",
                    region.name
                );
            }
            if region.gateway_max_connections == 0 || region.gateway_max_connections > 1_000_000 {
                bail!("region {} gateway_max_connections invalid", region.name);
            }
            total_injectors = total_injectors.saturating_add(u64::from(region.injectors));
        }
        if total_injectors == 0 || total_injectors > MAX_INJECTORS {
            bail!("injector count outside hard bound");
        }
        let planned_fleet = total_injectors.saturating_mul(self.connections_per_injector);
        if planned_fleet != self.fleet_size {
            bail!(
                "fleet_size must exactly equal injectors * connections_per_injector; planned={planned_fleet} configured={}",
                self.fleet_size
            );
        }
        self.machine_id_start
            .checked_add(self.fleet_size - 1)
            .context("machine id range overflow")?;
        validate_slo(&self.slo)?;
        validate_stages(&self.stages, &region_names)?;
        Ok(())
    }
}

pub fn plan_distributed_lab(profile: &DistributedLabProfile, run_id: &str) -> Result<LabManifest> {
    profile.validate()?;
    validate_run_id(run_id)?;

    let mut shards = Vec::new();
    let mut next_machine = profile.machine_id_start;
    let mut ordinal = 0_u64;
    for region in &profile.regions {
        for local in 0..region.injectors {
            let start = next_machine;
            let end = start
                .checked_add(profile.connections_per_injector - 1)
                .context("machine id shard overflow")?;
            shards.push(InjectorShard {
                shard_id: format!("shard_{ordinal:04}_{:02}", local),
                region: region.name.clone(),
                machine_id_start: start,
                machine_id_end: end,
                connections: profile.connections_per_injector,
                seed: splitmix64(profile.seed ^ start ^ ordinal.rotate_left(19)),
            });
            next_machine = end.checked_add(1).context("machine id cursor overflow")?;
            ordinal += 1;
        }
    }

    let mut checks = Vec::new();
    for region in &profile.regions {
        let assigned = u64::from(region.injectors).saturating_mul(profile.connections_per_injector);
        let capacity = u64::from(region.gateways).saturating_mul(region.gateway_max_connections);
        checks.push(check(
            &format!("normal_utilization:{}", region.name),
            ratio_bps(assigned, capacity),
            u64::from(profile.slo.max_normal_utilization_bps),
            "basis_points",
        ));
    }

    for failed in &profile.regions {
        let surviving_capacity: u64 = profile
            .regions
            .iter()
            .filter(|region| region.name != failed.name)
            .map(|region| u64::from(region.gateways).saturating_mul(region.gateway_max_connections))
            .sum();
        let surviving_gateways: u64 = profile
            .regions
            .iter()
            .filter(|region| region.name != failed.name)
            .map(|region| u64::from(region.gateways))
            .sum();
        let displaced =
            u64::from(failed.injectors).saturating_mul(profile.connections_per_injector);
        checks.push(check(
            &format!("region_loss_utilization:{}", failed.name),
            ratio_bps(profile.fleet_size, surviving_capacity),
            u64::from(profile.slo.max_failover_utilization_bps),
            "basis_points",
        ));
        let jitter = profile
            .stages
            .iter()
            .filter(|stage| stage.kind == ChaosStageKind::RegionLoss)
            .filter(|stage| stage.target_region.as_deref() == Some(failed.name.as_str()))
            .filter_map(|stage| stage.reconnect_jitter_seconds)
            .min()
            .unwrap_or(1);
        let reconnects_per_gateway = ceil_div(ceil_div(displaced, jitter), surviving_gateways);
        checks.push(check(
            &format!("region_loss_reconnect_budget:{}", failed.name),
            reconnects_per_gateway,
            profile.slo.max_reconnects_per_second_per_gateway,
            "connects_per_second",
        ));
    }

    let passed = checks.iter().all(|item| item.passed);
    Ok(LabManifest {
        schema_version: 1,
        run_id: run_id.to_owned(),
        profile: profile.name.clone(),
        fleet_size: profile.fleet_size,
        shards,
        regions: profile.regions.clone(),
        slo: profile.slo.clone(),
        stages: profile.stages.clone(),
        checks,
        passed,
    })
}

pub fn read_shard_reports(dir: &Path) -> Result<Vec<ShardLiveEvidence>> {
    let mut reports = Vec::new();
    let entries = fs::read_dir(dir)
        .with_context(|| format!("failed to read shard report directory {}", dir.display()))?;
    for entry in entries {
        let entry = entry.context("failed to inspect shard report directory entry")?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let raw = fs::read(&path)
            .with_context(|| format!("failed to read shard report {}", path.display()))?;
        let report = serde_json::from_slice::<ShardLiveEvidence>(&raw)
            .with_context(|| format!("invalid shard report {}", path.display()))?;
        reports.push(report);
    }
    reports.sort_by(|left, right| left.shard_id.cmp(&right.shard_id));
    Ok(reports)
}

pub fn aggregate_shard_evidence(
    manifest: &LabManifest,
    scenario: &str,
    reports: &[ShardLiveEvidence],
) -> Result<DistributedEvidenceReport> {
    if scenario != "steady" && scenario != "reconnect-storm" {
        bail!("aggregate scenario must be steady or reconnect-storm");
    }
    let expected: BTreeMap<&str, &InjectorShard> = manifest
        .shards
        .iter()
        .map(|shard| (shard.shard_id.as_str(), shard))
        .collect();
    let mut seen = BTreeSet::new();
    let mut requested_connections = 0_u64;
    let mut successful_connections = 0_u64;
    let mut failed_connections = 0_u64;
    let mut heartbeat_attempts = 0_u64;
    let mut heartbeat_failures = 0_u64;
    let mut presence_probe_attempts = 0_u64;
    let mut presence_probe_failures = 0_u64;
    let mut connect_p99 = 0_u64;
    let mut presence_p99 = 0_u64;
    let mut shard_failures = BTreeMap::new();

    for report in reports {
        if report.run_id != manifest.run_id || report.scenario != scenario {
            continue;
        }
        let shard = expected
            .get(report.shard_id.as_str())
            .with_context(|| format!("unexpected shard report {}", report.shard_id))?;
        if !seen.insert(report.shard_id.clone()) {
            bail!("duplicate shard report {}", report.shard_id);
        }
        if report.region != shard.region
            || report.machine_id_start != shard.machine_id_start
            || report.requested_connections != shard.connections
        {
            bail!("shard report identity mismatch for {}", report.shard_id);
        }
        requested_connections = requested_connections.saturating_add(report.requested_connections);
        successful_connections =
            successful_connections.saturating_add(report.successful_connections);
        failed_connections = failed_connections.saturating_add(report.failed_connections);
        heartbeat_attempts = heartbeat_attempts.saturating_add(report.heartbeat_attempts);
        heartbeat_failures = heartbeat_failures.saturating_add(report.heartbeat_failures);
        presence_probe_attempts =
            presence_probe_attempts.saturating_add(report.presence_probe_attempts);
        presence_probe_failures =
            presence_probe_failures.saturating_add(report.presence_probe_failures);
        connect_p99 = connect_p99.max(report.connect_latency.p99_ms);
        presence_p99 = presence_p99.max(report.presence_commit_latency.p99_ms);
        if !report.passed {
            *shard_failures.entry(report.region.clone()).or_insert(0) += 1;
        }
    }

    let expected_shards = manifest.shards.len() as u64;
    let observed_shards = seen.len() as u64;
    let connection_failure_bps = failure_bps(
        failed_connections,
        successful_connections.saturating_add(failed_connections),
    );
    let heartbeat_failure_bps = failure_bps(heartbeat_failures, heartbeat_attempts);
    let presence_failure_bps = failure_bps(presence_probe_failures, presence_probe_attempts);
    let checks = vec![
        exact_check(
            "all_shards_present",
            observed_shards,
            expected_shards,
            "shards",
        ),
        check(
            "connection_failure_rate",
            connection_failure_bps,
            manifest.slo.max_connection_failure_bps,
            "basis_points",
        ),
        check(
            "heartbeat_failure_rate",
            heartbeat_failure_bps,
            manifest.slo.max_heartbeat_failure_bps,
            "basis_points",
        ),
        check(
            "presence_failure_rate",
            presence_failure_bps,
            manifest.slo.max_presence_failure_bps,
            "basis_points",
        ),
        check(
            "conservative_connect_p99",
            connect_p99,
            manifest.slo.max_connect_p99_ms,
            "milliseconds",
        ),
        check(
            "conservative_presence_p99",
            presence_p99,
            manifest.slo.max_presence_p99_ms,
            "milliseconds",
        ),
        exact_check(
            "failed_shard_count",
            shard_failures.values().sum(),
            0,
            "shards",
        ),
    ];
    let passed = checks.iter().all(|item| item.passed);
    Ok(DistributedEvidenceReport {
        schema_version: 1,
        run_id: manifest.run_id.clone(),
        profile: manifest.profile.clone(),
        scenario: scenario.to_owned(),
        expected_shards,
        observed_shards,
        requested_connections,
        successful_connections,
        failed_connections,
        heartbeat_attempts,
        heartbeat_failures,
        presence_probe_attempts,
        presence_probe_failures,
        connection_failure_bps,
        heartbeat_failure_bps,
        presence_failure_bps,
        conservative_connect_p99_ms: connect_p99,
        conservative_presence_p99_ms: presence_p99,
        shard_failures,
        checks,
        passed,
    })
}

fn validate_slo(slo: &LabSlo) -> Result<()> {
    if !(1..=10_000).contains(&slo.max_normal_utilization_bps)
        || !(1..=10_000).contains(&slo.max_failover_utilization_bps)
        || slo.max_normal_utilization_bps > slo.max_failover_utilization_bps
    {
        bail!("utilization SLO basis points invalid");
    }
    if slo.max_reconnects_per_second_per_gateway == 0
        || slo.max_connect_p99_ms == 0
        || slo.max_presence_p99_ms == 0
        || slo.max_gateway_cpu_bps == 0
        || slo.max_gateway_cpu_bps > 10_000
        || slo.max_gateway_rss_bytes == 0
        || slo.max_gateway_open_fds == 0
        || slo.max_redis_p99_ms == 0
        || slo.max_connection_failure_bps > 10_000
        || slo.max_heartbeat_failure_bps > 10_000
        || slo.max_presence_failure_bps > 10_000
    {
        bail!("one or more distributed lab SLOs are invalid");
    }
    Ok(())
}

fn validate_stages(stages: &[ChaosStage], regions: &BTreeSet<String>) -> Result<()> {
    if stages.is_empty() || stages.len() > 64 {
        bail!("distributed lab requires 1..64 stages");
    }
    let mut names = BTreeSet::new();
    let mut has_baseline = false;
    let mut has_region_loss = BTreeSet::new();
    for stage in stages {
        if stage.name.trim().is_empty()
            || stage.name.len() > 120
            || !names.insert(stage.name.clone())
        {
            bail!("chaos stage name invalid or duplicate");
        }
        if stage.duration_seconds == 0 || stage.duration_seconds > 86_400 {
            bail!("chaos stage {} duration invalid", stage.name);
        }
        match stage.kind {
            ChaosStageKind::Baseline | ChaosStageKind::Soak | ChaosStageKind::RedisOutage => {
                if stage.target_region.is_some()
                    || stage.target_gateways.is_some()
                    || stage.packet_loss_bps.is_some()
                    || stage.added_latency_ms.is_some()
                {
                    bail!(
                        "stage {} contains fault fields not valid for its kind",
                        stage.name
                    );
                }
                if stage.kind == ChaosStageKind::Baseline {
                    has_baseline = true;
                }
            }
            ChaosStageKind::ReconnectStorm => {
                let jitter = stage.reconnect_jitter_seconds.unwrap_or(0);
                if jitter == 0 || jitter > 3_600 {
                    bail!("reconnect stage {} requires bounded jitter", stage.name);
                }
            }
            ChaosStageKind::GatewayLoss => {
                let count = stage.target_gateways.unwrap_or(0);
                if count == 0 || count > 10_000 {
                    bail!("gateway loss stage {} target count invalid", stage.name);
                }
            }
            ChaosStageKind::RegionLoss => {
                let region = stage
                    .target_region
                    .as_deref()
                    .context("region loss stage requires target_region")?;
                if !regions.contains(region) {
                    bail!("region loss stage targets unknown region {region}");
                }
                let jitter = stage.reconnect_jitter_seconds.unwrap_or(0);
                if jitter == 0 || jitter > 3_600 {
                    bail!(
                        "region loss stage {} requires bounded reconnect jitter",
                        stage.name
                    );
                }
                if !has_region_loss.insert(region.to_owned()) {
                    bail!("duplicate region loss stage for {region}");
                }
            }
            ChaosStageKind::NetworkImpairment => {
                let loss = stage.packet_loss_bps.unwrap_or(0);
                let latency = stage.added_latency_ms.unwrap_or(0);
                if loss > 2_000 || latency > 2_000 || (loss == 0 && latency == 0) {
                    bail!(
                        "network impairment stage {} outside safety bound",
                        stage.name
                    );
                }
            }
        }
    }
    if !has_baseline {
        bail!("distributed lab requires a baseline stage");
    }
    for region in regions {
        if !has_region_loss.contains(region) {
            bail!("distributed lab requires a region-loss stage for {region}");
        }
    }
    Ok(())
}

fn validate_region_name(value: &str) -> Result<()> {
    if !(2..=32).contains(&value.len())
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || (index > 0 && byte == b'-')
        })
    {
        bail!("region name invalid");
    }
    Ok(())
}

fn check(name: &str, observed: u64, limit: u64, unit: &str) -> LabCheck {
    LabCheck {
        name: name.to_owned(),
        passed: observed <= limit,
        observed,
        limit,
        unit: unit.to_owned(),
    }
}

fn exact_check(name: &str, observed: u64, expected: u64, unit: &str) -> LabCheck {
    LabCheck {
        name: name.to_owned(),
        passed: observed == expected,
        observed,
        limit: expected,
        unit: unit.to_owned(),
    }
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

fn failure_bps(failures: u64, attempts: u64) -> u64 {
    if attempts == 0 {
        return if failures == 0 { 0 } else { 10_000 };
    }
    failures.saturating_mul(10_000).div_ceil(attempts)
}

fn splitmix64(mut value: u64) -> u64 {
    value = value.wrapping_add(0x9e37_79b9_7f4a_7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> DistributedLabProfile {
        DistributedLabProfile {
            schema_version: 1,
            name: "distributed-million-v1".into(),
            fleet_size: 1_000_000,
            machine_id_start: 1_000_000,
            connections_per_injector: 25_000,
            seed: 42,
            regions: vec![
                LabRegionProfile {
                    name: "eu-west-1".into(),
                    injectors: 14,
                    gateways: 13,
                    gateway_max_connections: 50_000,
                },
                LabRegionProfile {
                    name: "us-east-1".into(),
                    injectors: 13,
                    gateways: 13,
                    gateway_max_connections: 50_000,
                },
                LabRegionProfile {
                    name: "ap-southeast-1".into(),
                    injectors: 13,
                    gateways: 13,
                    gateway_max_connections: 50_000,
                },
            ],
            slo: LabSlo {
                max_normal_utilization_bps: 7_000,
                max_failover_utilization_bps: 8_000,
                max_reconnects_per_second_per_gateway: 400,
                max_connection_failure_bps: 100,
                max_heartbeat_failure_bps: 100,
                max_presence_failure_bps: 100,
                max_connect_p99_ms: 5_000,
                max_presence_p99_ms: 2_000,
                max_gateway_cpu_bps: 8_500,
                max_gateway_rss_bytes: 8 * 1024 * 1024 * 1024,
                max_gateway_open_fds: 120_000,
                max_gateway_udp_errors: 100,
                max_redis_p99_ms: 50,
            },
            stages: vec![
                ChaosStage {
                    name: "baseline".into(),
                    kind: ChaosStageKind::Baseline,
                    duration_seconds: 300,
                    target_region: None,
                    target_gateways: None,
                    reconnect_jitter_seconds: None,
                    packet_loss_bps: None,
                    added_latency_ms: None,
                },
                ChaosStage {
                    name: "eu-loss".into(),
                    kind: ChaosStageKind::RegionLoss,
                    duration_seconds: 300,
                    target_region: Some("eu-west-1".into()),
                    target_gateways: None,
                    reconnect_jitter_seconds: Some(120),
                    packet_loss_bps: None,
                    added_latency_ms: None,
                },
                ChaosStage {
                    name: "us-loss".into(),
                    kind: ChaosStageKind::RegionLoss,
                    duration_seconds: 300,
                    target_region: Some("us-east-1".into()),
                    target_gateways: None,
                    reconnect_jitter_seconds: Some(120),
                    packet_loss_bps: None,
                    added_latency_ms: None,
                },
                ChaosStage {
                    name: "ap-loss".into(),
                    kind: ChaosStageKind::RegionLoss,
                    duration_seconds: 300,
                    target_region: Some("ap-southeast-1".into()),
                    target_gateways: None,
                    reconnect_jitter_seconds: Some(120),
                    packet_loss_bps: None,
                    added_latency_ms: None,
                },
            ],
        }
    }

    #[test]
    fn million_fleet_plan_has_exact_non_overlapping_shards() {
        let manifest = plan_distributed_lab(&profile(), "run_20260815").unwrap();
        assert!(manifest.passed);
        assert_eq!(manifest.shards.len(), 40);
        assert_eq!(
            manifest
                .shards
                .iter()
                .map(|item| item.connections)
                .sum::<u64>(),
            1_000_000
        );
        for pair in manifest.shards.windows(2) {
            assert_eq!(pair[0].machine_id_end + 1, pair[1].machine_id_start);
        }
    }

    #[test]
    fn underprovisioned_region_fails_plan_checks() {
        let mut bad = profile();
        bad.regions[1].gateways = 4;
        let manifest = plan_distributed_lab(&bad, "run_underprovisioned").unwrap();
        assert!(!manifest.passed);
        assert!(manifest.checks.iter().any(|item| !item.passed));
    }

    #[test]
    fn missing_region_loss_stage_is_rejected() {
        let mut bad = profile();
        bad.stages
            .retain(|stage| stage.target_region.as_deref() != Some("ap-southeast-1"));
        assert!(bad.validate().is_err());
    }

    #[test]
    fn aggregate_rejects_missing_shards_instead_of_hiding_them() {
        let manifest = plan_distributed_lab(&profile(), "run_aggregate").unwrap();
        let shard = &manifest.shards[0];
        let evidence = ShardLiveEvidence {
            schema_version: 1,
            run_id: manifest.run_id.clone(),
            shard_id: shard.shard_id.clone(),
            region: shard.region.clone(),
            scenario: "steady".into(),
            machine_id_start: shard.machine_id_start,
            requested_connections: shard.connections,
            successful_connections: shard.connections,
            failed_connections: 0,
            heartbeat_attempts: shard.connections,
            heartbeat_failures: 0,
            presence_probe_attempts: 1,
            presence_probe_failures: 0,
            connect_latency: EvidenceLatency {
                samples: shard.connections,
                min_ms: 1,
                p50_ms: 1,
                p95_ms: 2,
                p99_ms: 3,
                max_ms: 4,
            },
            presence_commit_latency: EvidenceLatency {
                samples: 1,
                min_ms: 8,
                p50_ms: 8,
                p95_ms: 8,
                p99_ms: 8,
                max_ms: 8,
            },
            failure_reasons: BTreeMap::new(),
            passed: true,
        };
        let report = aggregate_shard_evidence(&manifest, "steady", &[evidence]).unwrap();
        assert!(!report.passed);
        assert_eq!(report.observed_shards, 1);
        assert_eq!(report.expected_shards, 40);
    }
}
