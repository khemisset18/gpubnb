use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
};

use anyhow::{bail, Context, Result};
use gpubnb_control_gateway::distributed_lab::{
    aggregate_shard_evidence, plan_distributed_lab, read_shard_reports, DistributedLabProfile,
    LabManifest,
};

fn main() {
    if let Err(error) = run() {
        eprintln!("gpubnb-labctl: {error:#}");
        std::process::exit(2);
    }
}

fn run() -> Result<()> {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = raw.first().map(String::as_str) else {
        print_usage();
        bail!("missing command");
    };
    let args = ParsedArgs::parse(&raw[1..])?;
    match command {
        "plan" => run_plan(&args),
        "aggregate" => run_aggregate(&args),
        "help" | "--help" | "-h" => {
            print_usage();
            Ok(())
        }
        _ => bail!("unknown command {command}"),
    }
}

fn run_plan(args: &ParsedArgs) -> Result<()> {
    let profile_path = PathBuf::from(args.required("--profile")?);
    let raw = std::fs::read(&profile_path)
        .with_context(|| format!("failed to read profile {}", profile_path.display()))?;
    let profile: DistributedLabProfile =
        serde_json::from_slice(&raw).context("distributed lab profile JSON invalid")?;
    let manifest = plan_distributed_lab(&profile, args.required("--run-id")?)?;
    let encoded = serde_json::to_string_pretty(&manifest)?;
    write_output(args.value("--output"), &encoded)?;
    println!("{encoded}");
    if args.flag("--require-pass") && !manifest.passed {
        bail!("distributed lab plan failed one or more capacity gates");
    }
    Ok(())
}

fn run_aggregate(args: &ParsedArgs) -> Result<()> {
    let manifest_path = PathBuf::from(args.required("--manifest")?);
    let raw = std::fs::read(&manifest_path)
        .with_context(|| format!("failed to read manifest {}", manifest_path.display()))?;
    let manifest: LabManifest =
        serde_json::from_slice(&raw).context("distributed lab manifest JSON invalid")?;
    let reports = read_shard_reports(&PathBuf::from(args.required("--reports-dir")?))?;
    let report = aggregate_shard_evidence(&manifest, args.required("--scenario")?, &reports)?;
    let encoded = serde_json::to_string_pretty(&report)?;
    write_output(args.value("--output"), &encoded)?;
    println!("{encoded}");
    if args.flag("--require-pass") && !report.passed {
        bail!("distributed evidence failed one or more qualification gates");
    }
    Ok(())
}

fn write_output(path: Option<&str>, content: &str) -> Result<()> {
    let Some(path) = path else {
        return Ok(());
    };
    let path = PathBuf::from(path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create output directory {}", parent.display()))?;
    }
    std::fs::write(&path, content)
        .with_context(|| format!("failed to write output {}", path.display()))
}

#[derive(Default)]
struct ParsedArgs {
    values: BTreeMap<String, String>,
    flags: BTreeSet<String>,
}

impl ParsedArgs {
    fn parse(raw: &[String]) -> Result<Self> {
        let mut parsed = Self::default();
        let mut index = 0;
        while index < raw.len() {
            let token = &raw[index];
            if !token.starts_with("--") {
                bail!("unexpected positional argument {token}");
            }
            if matches!(token.as_str(), "--require-pass") {
                if !parsed.flags.insert(token.clone()) {
                    bail!("duplicate flag {token}");
                }
                index += 1;
                continue;
            }
            let value = raw
                .get(index + 1)
                .with_context(|| format!("missing value for {token}"))?;
            if value.starts_with("--") {
                bail!("missing value for {token}");
            }
            if parsed.values.insert(token.clone(), value.clone()).is_some() {
                bail!("duplicate argument {token}");
            }
            index += 2;
        }
        Ok(parsed)
    }

    fn value(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    fn required(&self, key: &str) -> Result<&str> {
        self.value(key)
            .with_context(|| format!("missing required argument {key}"))
    }

    fn flag(&self, key: &str) -> bool {
        self.flags.contains(key)
    }
}

fn print_usage() {
    println!(
        "gpubnb-labctl\n\n\
         Commands:\n\
           plan --profile PATH --run-id ID [--output PATH] [--require-pass]\n\
           aggregate --manifest PATH --reports-dir DIR --scenario steady|reconnect-storm [--output PATH] [--require-pass]\n\n\
         The planner validates shard identity ranges and N+1 region capacity before load is launched.\n\
         The aggregator requires every expected shard and uses the maximum shard p99 as a conservative global gate."
    );
}
