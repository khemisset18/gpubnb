use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::distributed_lab::{validate_run_id, LabManifest};

pub const MAX_PRODUCTION_STAGES: usize = 16;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProductionScaleProfile {
    pub schema_version: u32,
    pub name: String,
    pub stages: Vec<ProductionScaleStage>,
    pub requirements: ProductionRequirements,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProductionScaleStage {
    pub id: String,
    pub target_connections: u64,
    pub hold_seconds: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProductionRequirements {
    pub max_gateway_cpu_bps: u32,
    pub max_gateway_fd_utilization_bps: u32,
    pub max_gateway_udp_errors_delta: u64,
    pub max_injector_cpu_bps: u32,
    pub max_injector_fd_utilization_bps: u32,
    pub max_injector_udp_errors_delta: u64,
    pub max_redis_cpu_bps: u32,
    pub max_redis_blocked_clients: u64,
    pub max_redis_evictions_delta: u64,
    pub min_soak_seconds: u64,
    pub require_gateway_loss: bool,
    pub require_network_impairment: bool,
    pub require_redis_failover: bool,
    pub require_all_region_loss: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReleaseMetadata {
    pub git_sha: String,
    pub gateway_image_digest: String,
    pub injector_image_digest: String,
    pub config_bundle_sha256: String,
    pub redis_version: String,
    pub redis_topology: String,
    pub os_kernel: String,
    pub instance_type: String,
    pub cpu_count: u32,
    pub memory_bytes: u64,
    pub fd_limit: u64,
    pub nic_mbps: u64,
    pub regions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductionStageShard {
    pub shard_id: String,
    pub region: String,
    pub machine_id_start: u64,
    pub machine_id_end: u64,
    pub connections: u64,
    pub seed: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductionStagePlan {
    pub ordinal: u32,
    pub id: String,
    pub target_connections: u64,
    pub hold_seconds: u64,
    pub shards: Vec<ProductionStageShard>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductionRunPlan {
    pub schema_version: u32,
    pub run_id: String,
    pub profile: String,
    pub distributed_profile: String,
    pub distributed_fleet_size: u64,
    pub distributed_slo: crate::distributed_lab::LabSlo,
    pub release: ReleaseMetadata,
    pub requirements: ProductionRequirements,
    pub stages: Vec<ProductionStagePlan>,
    pub passed: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProductionFaultKind {
    GatewayLoss,
    RegionLoss,
    NetworkImpairment,
    RedisFailover,
    Soak,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProductionFaultEvidence {
    pub kind: ProductionFaultKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_region: Option<String>,
    pub duration_seconds: u64,
    pub recovered: bool,
    pub duplicate_ownership_detected: bool,
    pub manual_intervention: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProductionStageEvidence {
    pub schema_version: u32,
    pub run_id: String,
    pub stage_id: String,
    pub release_git_sha: String,
    pub gateway_image_digest: String,
    pub injector_image_digest: String,
    pub config_bundle_sha256: String,
    pub target_connections: u64,
    pub measured_peak_connections: u64,
    pub sustained_seconds: u64,
    pub expected_shards: u64,
    pub observed_shards: u64,
    pub connection_failure_bps: u64,
    pub heartbeat_failure_bps: u64,
    pub presence_failure_bps: u64,
    pub connect_p99_ms: u64,
    pub presence_p99_ms: u64,
    pub gateway_peak_cpu_bps: u32,
    pub gateway_peak_fd_utilization_bps: u32,
    pub gateway_udp_errors_delta: u64,
    pub injector_peak_cpu_bps: u32,
    pub injector_peak_fd_utilization_bps: u32,
    pub injector_udp_errors_delta: u64,
    pub redis_p99_ms: u64,
    pub redis_peak_cpu_bps: u32,
    pub redis_blocked_clients_peak: u64,
    pub redis_evictions_delta: u64,
    pub faults: Vec<ProductionFaultEvidence>,
    pub evidence_bundle_sha256: String,
    pub passed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductionStageQualification {
    pub stage_id: String,
    pub target_connections: u64,
    pub measured_peak_connections: u64,
    pub checks: Vec<ProductionCheck>,
    pub passed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductionCheck {
    pub name: String,
    pub passed: bool,
    pub observed: u64,
    pub limit: u64,
    pub comparison: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductionQualification {
    pub schema_version: u32,
    pub run_id: String,
    pub profile: String,
    pub through_stage: String,
    pub qualified_stage_count: u32,
    pub measured_peak_connections: u64,
    pub stage_results: Vec<ProductionStageQualification>,
    pub required_fault_checks: Vec<ProductionCheck>,
    pub release_ready: bool,
    pub one_million_measured: bool,
    pub passed: bool,
}

impl ProductionScaleProfile {
    pub fn validate(&self, manifest: &LabManifest) -> Result<()> {
        if self.schema_version != 1 {
            bail!("production scale profile schema_version must be 1");
        }
        if self.name.trim().is_empty() || self.name.len() > 120 {
            bail!("production scale profile name invalid");
        }
        if self.stages.is_empty() || self.stages.len() > MAX_PRODUCTION_STAGES {
            bail!("production scale profile requires 1..{MAX_PRODUCTION_STAGES} stages");
        }
        if !manifest.passed {
            bail!("distributed capacity manifest must pass before production-scale planning");
        }
        let mut ids = BTreeSet::new();
        let mut previous = 0_u64;
        for stage in &self.stages {
            validate_stage_id(&stage.id)?;
            if !ids.insert(stage.id.clone()) {
                bail!("duplicate production scale stage {}", stage.id);
            }
            if stage.target_connections <= previous {
                bail!("production scale targets must increase strictly");
            }
            if stage.target_connections > manifest.fleet_size {
                bail!("stage {} exceeds distributed fleet size", stage.id);
            }
            if stage.hold_seconds == 0 {
                bail!("stage {} hold_seconds must be positive", stage.id);
            }
            previous = stage.target_connections;
        }
        if previous != manifest.fleet_size {
            bail!("final production scale stage must equal distributed fleet size");
        }
        validate_bps(self.requirements.max_gateway_cpu_bps, "max_gateway_cpu_bps")?;
        validate_bps(
            self.requirements.max_gateway_fd_utilization_bps,
            "max_gateway_fd_utilization_bps",
        )?;
        validate_bps(
            self.requirements.max_injector_cpu_bps,
            "max_injector_cpu_bps",
        )?;
        validate_bps(
            self.requirements.max_injector_fd_utilization_bps,
            "max_injector_fd_utilization_bps",
        )?;
        validate_bps(self.requirements.max_redis_cpu_bps, "max_redis_cpu_bps")?;
        if self.requirements.min_soak_seconds < 3600 {
            bail!("min_soak_seconds must be at least one hour");
        }
        Ok(())
    }
}

impl ReleaseMetadata {
    pub fn validate(&self, manifest: &LabManifest) -> Result<()> {
        if !is_hex_len(&self.git_sha, 40) && !is_hex_len(&self.git_sha, 64) {
            bail!("release git_sha must be a 40 or 64 character hex digest");
        }
        validate_image_digest(&self.gateway_image_digest, "gateway_image_digest")?;
        validate_image_digest(&self.injector_image_digest, "injector_image_digest")?;
        if !is_hex_len(&self.config_bundle_sha256, 64) {
            bail!("config_bundle_sha256 must be 64 hexadecimal characters");
        }
        for (name, value) in [
            ("redis_version", self.redis_version.as_str()),
            ("redis_topology", self.redis_topology.as_str()),
            ("os_kernel", self.os_kernel.as_str()),
            ("instance_type", self.instance_type.as_str()),
        ] {
            if value.trim().is_empty() || value.len() > 256 {
                bail!("release metadata {name} invalid");
            }
        }
        if self.cpu_count == 0 || self.memory_bytes == 0 || self.fd_limit == 0 || self.nic_mbps == 0
        {
            bail!("release hardware metadata must be positive");
        }
        let expected: BTreeSet<&str> = manifest
            .regions
            .iter()
            .map(|item| item.name.as_str())
            .collect();
        let observed: BTreeSet<&str> = self.regions.iter().map(String::as_str).collect();
        if observed.len() != self.regions.len() || observed != expected {
            bail!("release metadata regions must exactly match distributed manifest regions");
        }
        Ok(())
    }
}

pub fn plan_production_scale(
    manifest: &LabManifest,
    profile: &ProductionScaleProfile,
    release: ReleaseMetadata,
    run_id: &str,
) -> Result<ProductionRunPlan> {
    validate_run_id(run_id)?;
    profile.validate(manifest)?;
    release.validate(manifest)?;

    let mut stages = Vec::with_capacity(profile.stages.len());
    for (ordinal, stage) in profile.stages.iter().enumerate() {
        let mut remaining = stage.target_connections;
        let mut shards = Vec::new();
        for source in &manifest.shards {
            if remaining == 0 {
                break;
            }
            let connections = remaining.min(source.connections);
            let machine_id_end = source
                .machine_id_start
                .checked_add(connections - 1)
                .context("production stage machine range overflow")?;
            shards.push(ProductionStageShard {
                shard_id: source.shard_id.clone(),
                region: source.region.clone(),
                machine_id_start: source.machine_id_start,
                machine_id_end,
                connections,
                seed: source.seed,
            });
            remaining -= connections;
        }
        if remaining != 0 {
            bail!("distributed manifest cannot satisfy stage {}", stage.id);
        }
        stages.push(ProductionStagePlan {
            ordinal: u32::try_from(ordinal).context("stage ordinal overflow")?,
            id: stage.id.clone(),
            target_connections: stage.target_connections,
            hold_seconds: stage.hold_seconds,
            shards,
        });
    }

    Ok(ProductionRunPlan {
        schema_version: 1,
        run_id: run_id.to_owned(),
        profile: profile.name.clone(),
        distributed_profile: manifest.profile.clone(),
        distributed_fleet_size: manifest.fleet_size,
        distributed_slo: manifest.slo.clone(),
        release,
        requirements: profile.requirements.clone(),
        stages,
        passed: true,
    })
}

pub fn read_production_evidence(dir: &Path) -> Result<Vec<ProductionStageEvidence>> {
    let mut reports = Vec::new();
    for entry in fs::read_dir(dir).with_context(|| {
        format!(
            "failed to read production evidence directory {}",
            dir.display()
        )
    })? {
        let entry = entry.context("failed to inspect production evidence entry")?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let raw = fs::read(&path)
            .with_context(|| format!("failed to read production evidence {}", path.display()))?;
        let report = serde_json::from_slice::<ProductionStageEvidence>(&raw)
            .with_context(|| format!("invalid production evidence {}", path.display()))?;
        reports.push(report);
    }
    reports.sort_by(|left, right| left.stage_id.cmp(&right.stage_id));
    Ok(reports)
}

pub fn qualify_production_scale(
    plan: &ProductionRunPlan,
    evidence: &[ProductionStageEvidence],
    through_stage: Option<&str>,
) -> Result<ProductionQualification> {
    if plan.schema_version != 1 || !plan.passed || plan.stages.is_empty() {
        bail!("production run plan is not qualification-eligible");
    }
    let through_index = match through_stage {
        Some(id) => plan
            .stages
            .iter()
            .position(|stage| stage.id == id)
            .with_context(|| format!("unknown through_stage {id}"))?,
        None => plan.stages.len() - 1,
    };
    let expected_stages = &plan.stages[..=through_index];
    let expected_ids: BTreeSet<&str> = expected_stages
        .iter()
        .map(|stage| stage.id.as_str())
        .collect();
    let mut by_stage = BTreeMap::new();
    for report in evidence {
        if report.run_id != plan.run_id {
            continue;
        }
        if !expected_ids.contains(report.stage_id.as_str()) {
            continue;
        }
        if by_stage.insert(report.stage_id.clone(), report).is_some() {
            bail!(
                "duplicate production evidence for stage {}",
                report.stage_id
            );
        }
    }

    let mut stage_results = Vec::new();
    let mut measured_peak = 0_u64;
    let mut all_faults = Vec::new();
    for stage in expected_stages {
        let report = by_stage
            .get(&stage.id)
            .with_context(|| format!("missing production evidence for stage {}", stage.id))?;
        let checks = qualify_stage(plan, stage, report)?;
        let passed = report.passed && checks.iter().all(|check| check.passed);
        measured_peak = measured_peak.max(report.measured_peak_connections);
        all_faults.extend(report.faults.iter());
        stage_results.push(ProductionStageQualification {
            stage_id: stage.id.clone(),
            target_connections: stage.target_connections,
            measured_peak_connections: report.measured_peak_connections,
            checks,
            passed,
        });
    }

    let final_stage = through_index + 1 == plan.stages.len();
    let required_fault_checks = if final_stage {
        qualify_release_faults(plan, &all_faults)
    } else {
        Vec::new()
    };
    let stage_passed = stage_results.iter().all(|stage| stage.passed);
    let faults_passed = required_fault_checks.iter().all(|check| check.passed);
    let release_ready = final_stage && stage_passed && faults_passed;
    let one_million_measured =
        release_ready && plan.distributed_fleet_size >= 1_000_000 && measured_peak >= 1_000_000;

    Ok(ProductionQualification {
        schema_version: 1,
        run_id: plan.run_id.clone(),
        profile: plan.profile.clone(),
        through_stage: plan.stages[through_index].id.clone(),
        qualified_stage_count: u32::try_from(expected_stages.len())
            .context("qualified stage count overflow")?,
        measured_peak_connections: measured_peak,
        stage_results,
        required_fault_checks,
        release_ready,
        one_million_measured,
        passed: stage_passed && (!final_stage || faults_passed),
    })
}

fn qualify_stage(
    plan: &ProductionRunPlan,
    stage: &ProductionStagePlan,
    report: &ProductionStageEvidence,
) -> Result<Vec<ProductionCheck>> {
    if report.schema_version != 1 {
        bail!("stage {} evidence schema_version must be 1", stage.id);
    }
    if report.stage_id != stage.id || report.target_connections != stage.target_connections {
        bail!("stage {} evidence identity mismatch", stage.id);
    }
    if report.release_git_sha != plan.release.git_sha
        || report.gateway_image_digest != plan.release.gateway_image_digest
        || report.injector_image_digest != plan.release.injector_image_digest
        || report.config_bundle_sha256 != plan.release.config_bundle_sha256
    {
        bail!("stage {} evidence release identity mismatch", stage.id);
    }
    if !is_hex_len(&report.evidence_bundle_sha256, 64) {
        bail!("stage {} evidence bundle digest invalid", stage.id);
    }
    for fault in &report.faults {
        if fault.manual_intervention || fault.duplicate_ownership_detected {
            bail!(
                "stage {} fault evidence contains forbidden manual recovery or duplicate ownership",
                stage.id
            );
        }
    }

    let expected_shards =
        u64::try_from(stage.shards.len()).context("stage shard count overflow")?;
    let slo = &plan.requirements;
    let checks = vec![
        min_check(
            "measured_peak_connections",
            report.measured_peak_connections,
            stage.target_connections,
        ),
        min_check(
            "sustained_seconds",
            report.sustained_seconds,
            stage.hold_seconds,
        ),
        exact_check("expected_shards", report.expected_shards, expected_shards),
        exact_check("observed_shards", report.observed_shards, expected_shards),
        max_check(
            "connection_failure_bps",
            report.connection_failure_bps,
            plan.distributed_slo.max_connection_failure_bps,
        ),
        max_check(
            "heartbeat_failure_bps",
            report.heartbeat_failure_bps,
            plan.distributed_slo.max_heartbeat_failure_bps,
        ),
        max_check(
            "presence_failure_bps",
            report.presence_failure_bps,
            plan.distributed_slo.max_presence_failure_bps,
        ),
        max_check(
            "connect_p99_ms",
            report.connect_p99_ms,
            plan.distributed_slo.max_connect_p99_ms,
        ),
        max_check(
            "presence_p99_ms",
            report.presence_p99_ms,
            plan.distributed_slo.max_presence_p99_ms,
        ),
        max_check(
            "gateway_peak_cpu_bps",
            u64::from(report.gateway_peak_cpu_bps),
            u64::from(slo.max_gateway_cpu_bps),
        ),
        max_check(
            "gateway_peak_fd_utilization_bps",
            u64::from(report.gateway_peak_fd_utilization_bps),
            u64::from(slo.max_gateway_fd_utilization_bps),
        ),
        max_check(
            "gateway_udp_errors_delta",
            report.gateway_udp_errors_delta,
            slo.max_gateway_udp_errors_delta,
        ),
        max_check(
            "injector_peak_cpu_bps",
            u64::from(report.injector_peak_cpu_bps),
            u64::from(slo.max_injector_cpu_bps),
        ),
        max_check(
            "injector_peak_fd_utilization_bps",
            u64::from(report.injector_peak_fd_utilization_bps),
            u64::from(slo.max_injector_fd_utilization_bps),
        ),
        max_check(
            "injector_udp_errors_delta",
            report.injector_udp_errors_delta,
            slo.max_injector_udp_errors_delta,
        ),
        max_check(
            "redis_p99_ms",
            report.redis_p99_ms,
            plan.distributed_slo.max_redis_p99_ms,
        ),
        max_check(
            "redis_peak_cpu_bps",
            u64::from(report.redis_peak_cpu_bps),
            u64::from(slo.max_redis_cpu_bps),
        ),
        max_check(
            "redis_blocked_clients_peak",
            report.redis_blocked_clients_peak,
            slo.max_redis_blocked_clients,
        ),
        max_check(
            "redis_evictions_delta",
            report.redis_evictions_delta,
            slo.max_redis_evictions_delta,
        ),
    ];
    Ok(checks)
}

fn qualify_release_faults(
    plan: &ProductionRunPlan,
    faults: &[&ProductionFaultEvidence],
) -> Vec<ProductionCheck> {
    let requirements = &plan.requirements;
    let mut checks = Vec::new();
    if requirements.require_gateway_loss {
        checks.push(bool_check(
            "gateway_loss_exercised",
            faults
                .iter()
                .any(|fault| fault.kind == ProductionFaultKind::GatewayLoss && fault.recovered),
        ));
    }
    if requirements.require_network_impairment {
        checks.push(bool_check(
            "network_impairment_exercised",
            faults.iter().any(|fault| {
                fault.kind == ProductionFaultKind::NetworkImpairment && fault.recovered
            }),
        ));
    }
    if requirements.require_redis_failover {
        checks.push(bool_check(
            "redis_failover_exercised",
            faults
                .iter()
                .any(|fault| fault.kind == ProductionFaultKind::RedisFailover && fault.recovered),
        ));
    }
    let max_soak = faults
        .iter()
        .filter(|fault| fault.kind == ProductionFaultKind::Soak && fault.recovered)
        .map(|fault| fault.duration_seconds)
        .max()
        .unwrap_or(0);
    checks.push(min_check(
        "soak_seconds",
        max_soak,
        requirements.min_soak_seconds,
    ));

    if requirements.require_all_region_loss {
        for region in &plan.release.regions {
            let passed = faults.iter().any(|fault| {
                fault.kind == ProductionFaultKind::RegionLoss
                    && fault.target_region.as_deref() == Some(region.as_str())
                    && fault.recovered
            });
            checks.push(bool_check(&format!("region_loss:{region}"), passed));
        }
    }
    checks
}

fn min_check(name: &str, observed: u64, limit: u64) -> ProductionCheck {
    ProductionCheck {
        name: name.to_owned(),
        passed: observed >= limit,
        observed,
        limit,
        comparison: ">=".to_owned(),
    }
}

fn max_check(name: &str, observed: u64, limit: u64) -> ProductionCheck {
    ProductionCheck {
        name: name.to_owned(),
        passed: observed <= limit,
        observed,
        limit,
        comparison: "<=".to_owned(),
    }
}

fn exact_check(name: &str, observed: u64, limit: u64) -> ProductionCheck {
    ProductionCheck {
        name: name.to_owned(),
        passed: observed == limit,
        observed,
        limit,
        comparison: "==".to_owned(),
    }
}

fn bool_check(name: &str, passed: bool) -> ProductionCheck {
    ProductionCheck {
        name: name.to_owned(),
        passed,
        observed: u64::from(passed),
        limit: 1,
        comparison: "==".to_owned(),
    }
}

fn validate_stage_id(value: &str) -> Result<()> {
    if !(2..=64).contains(&value.len())
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        })
    {
        bail!("stage id must be 2..64 lowercase alphanumeric, '-' or '_'");
    }
    Ok(())
}

fn validate_bps(value: u32, name: &str) -> Result<()> {
    if value == 0 || value > 10_000 {
        bail!("{name} must be in 1..=10000 basis points");
    }
    Ok(())
}

fn validate_image_digest(value: &str, name: &str) -> Result<()> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        bail!("{name} must use sha256:<64 hex> form");
    };
    if !is_hex_len(hex, 64) {
        bail!("{name} must use sha256:<64 hex> form");
    }
    Ok(())
}

fn is_hex_len(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::distributed_lab::{InjectorShard, LabCheck, LabRegionProfile, LabSlo};

    fn manifest() -> LabManifest {
        let mut shards = Vec::new();
        for index in 0..40_u64 {
            let start = index * 25_000;
            shards.push(InjectorShard {
                shard_id: format!("shard_{index:04}_00"),
                region: match index % 3 {
                    0 => "eu".to_owned(),
                    1 => "us".to_owned(),
                    _ => "ap".to_owned(),
                },
                machine_id_start: start,
                machine_id_end: start + 24_999,
                connections: 25_000,
                seed: index + 1,
            });
        }
        LabManifest {
            schema_version: 1,
            run_id: "distributed_base".to_owned(),
            profile: "distributed-million".to_owned(),
            fleet_size: 1_000_000,
            shards,
            regions: vec![region("eu", 14), region("us", 13), region("ap", 13)],
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
                max_gateway_rss_bytes: 16 * 1024 * 1024 * 1024,
                max_gateway_open_fds: 200_000,
                max_gateway_udp_errors: 0,
                max_redis_p99_ms: 2_000,
            },
            stages: Vec::new(),
            checks: vec![LabCheck {
                name: "ok".to_owned(),
                passed: true,
                observed: 1,
                limit: 1,
                unit: "bool".to_owned(),
            }],
            passed: true,
        }
    }

    fn region(name: &str, injectors: u32) -> LabRegionProfile {
        LabRegionProfile {
            name: name.to_owned(),
            injectors,
            gateways: 13,
            gateway_max_connections: 50_000,
        }
    }

    fn profile() -> ProductionScaleProfile {
        ProductionScaleProfile {
            schema_version: 1,
            name: "production-ladder".to_owned(),
            stages: vec![
                ProductionScaleStage {
                    id: "live_10k".to_owned(),
                    target_connections: 10_000,
                    hold_seconds: 900,
                },
                ProductionScaleStage {
                    id: "live_50k".to_owned(),
                    target_connections: 50_000,
                    hold_seconds: 900,
                },
                ProductionScaleStage {
                    id: "live_1m".to_owned(),
                    target_connections: 1_000_000,
                    hold_seconds: 3_600,
                },
            ],
            requirements: ProductionRequirements {
                max_gateway_cpu_bps: 8_500,
                max_gateway_fd_utilization_bps: 8_000,
                max_gateway_udp_errors_delta: 0,
                max_injector_cpu_bps: 8_500,
                max_injector_fd_utilization_bps: 8_000,
                max_injector_udp_errors_delta: 0,
                max_redis_cpu_bps: 8_500,
                max_redis_blocked_clients: 0,
                max_redis_evictions_delta: 0,
                min_soak_seconds: 14_400,
                require_gateway_loss: true,
                require_network_impairment: true,
                require_redis_failover: true,
                require_all_region_loss: true,
            },
        }
    }

    fn release() -> ReleaseMetadata {
        ReleaseMetadata {
            git_sha: "a".repeat(40),
            gateway_image_digest: format!("sha256:{}", "b".repeat(64)),
            injector_image_digest: format!("sha256:{}", "c".repeat(64)),
            config_bundle_sha256: "d".repeat(64),
            redis_version: "7.4".to_owned(),
            redis_topology: "sentinel-3".to_owned(),
            os_kernel: "linux-6.8".to_owned(),
            instance_type: "lab-x86-64".to_owned(),
            cpu_count: 32,
            memory_bytes: 64 * 1024 * 1024 * 1024,
            fd_limit: 1_048_576,
            nic_mbps: 25_000,
            regions: vec!["eu".to_owned(), "us".to_owned(), "ap".to_owned()],
        }
    }

    fn evidence(plan: &ProductionRunPlan, stage: &ProductionStagePlan) -> ProductionStageEvidence {
        ProductionStageEvidence {
            schema_version: 1,
            run_id: plan.run_id.clone(),
            stage_id: stage.id.clone(),
            release_git_sha: plan.release.git_sha.clone(),
            gateway_image_digest: plan.release.gateway_image_digest.clone(),
            injector_image_digest: plan.release.injector_image_digest.clone(),
            config_bundle_sha256: plan.release.config_bundle_sha256.clone(),
            target_connections: stage.target_connections,
            measured_peak_connections: stage.target_connections,
            sustained_seconds: stage.hold_seconds,
            expected_shards: stage.shards.len() as u64,
            observed_shards: stage.shards.len() as u64,
            connection_failure_bps: 0,
            heartbeat_failure_bps: 0,
            presence_failure_bps: 0,
            connect_p99_ms: 100,
            presence_p99_ms: 50,
            gateway_peak_cpu_bps: 7_000,
            gateway_peak_fd_utilization_bps: 6_000,
            gateway_udp_errors_delta: 0,
            injector_peak_cpu_bps: 7_000,
            injector_peak_fd_utilization_bps: 6_000,
            injector_udp_errors_delta: 0,
            redis_p99_ms: 20,
            redis_peak_cpu_bps: 5_000,
            redis_blocked_clients_peak: 0,
            redis_evictions_delta: 0,
            faults: Vec::new(),
            evidence_bundle_sha256: "e".repeat(64),
            passed: true,
        }
    }

    #[test]
    fn production_plan_supports_partial_first_shard_and_full_final_fleet() {
        let plan =
            plan_production_scale(&manifest(), &profile(), release(), "release_2026_08_15_a")
                .unwrap();
        assert_eq!(plan.stages[0].shards.len(), 1);
        assert_eq!(plan.stages[0].shards[0].connections, 10_000);
        assert_eq!(plan.stages[1].shards.len(), 2);
        assert_eq!(plan.stages.last().unwrap().shards.len(), 40);
        assert_eq!(plan.stages.last().unwrap().target_connections, 1_000_000);
    }

    #[test]
    fn stage_promotion_rejects_missing_evidence() {
        let plan =
            plan_production_scale(&manifest(), &profile(), release(), "release_2026_08_15_a")
                .unwrap();
        let error = qualify_production_scale(&plan, &[], Some("live_10k")).unwrap_err();
        assert!(error.to_string().contains("missing production evidence"));
    }

    #[test]
    fn final_release_requires_every_region_loss_and_soak() {
        let plan =
            plan_production_scale(&manifest(), &profile(), release(), "release_2026_08_15_a")
                .unwrap();
        let mut reports: Vec<_> = plan
            .stages
            .iter()
            .map(|stage| evidence(&plan, stage))
            .collect();
        let last = reports.last_mut().unwrap();
        last.faults = vec![
            fault(ProductionFaultKind::GatewayLoss, None, 60),
            fault(ProductionFaultKind::NetworkImpairment, None, 300),
            fault(ProductionFaultKind::RedisFailover, None, 120),
            fault(ProductionFaultKind::RegionLoss, Some("eu"), 120),
            fault(ProductionFaultKind::RegionLoss, Some("us"), 120),
            fault(ProductionFaultKind::Soak, None, 14_400),
        ];
        let result = qualify_production_scale(&plan, &reports, None).unwrap();
        assert!(!result.release_ready);
        assert!(!result.one_million_measured);
        assert!(result
            .required_fault_checks
            .iter()
            .any(|check| check.name == "region_loss:ap" && !check.passed));
    }

    #[test]
    fn full_evidence_allows_measured_one_million_claim() {
        let plan =
            plan_production_scale(&manifest(), &profile(), release(), "release_2026_08_15_a")
                .unwrap();
        let mut reports: Vec<_> = plan
            .stages
            .iter()
            .map(|stage| evidence(&plan, stage))
            .collect();
        let last = reports.last_mut().unwrap();
        last.faults = vec![
            fault(ProductionFaultKind::GatewayLoss, None, 60),
            fault(ProductionFaultKind::NetworkImpairment, None, 300),
            fault(ProductionFaultKind::RedisFailover, None, 120),
            fault(ProductionFaultKind::RegionLoss, Some("eu"), 120),
            fault(ProductionFaultKind::RegionLoss, Some("us"), 120),
            fault(ProductionFaultKind::RegionLoss, Some("ap"), 120),
            fault(ProductionFaultKind::Soak, None, 14_400),
        ];
        let result = qualify_production_scale(&plan, &reports, None).unwrap();
        assert!(result.passed);
        assert!(result.release_ready);
        assert!(result.one_million_measured);
        assert_eq!(result.measured_peak_connections, 1_000_000);
    }

    fn fault(
        kind: ProductionFaultKind,
        region: Option<&str>,
        duration_seconds: u64,
    ) -> ProductionFaultEvidence {
        ProductionFaultEvidence {
            kind,
            target_region: region.map(str::to_owned),
            duration_seconds,
            recovered: true,
            duplicate_ownership_detected: false,
            manual_intervention: false,
        }
    }
}
