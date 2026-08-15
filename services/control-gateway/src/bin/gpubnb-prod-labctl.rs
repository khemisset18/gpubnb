use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
};

use anyhow::{bail, Context, Result};
use gpubnb_control_gateway::{
    distributed_lab::LabManifest,
    production_lab::{
        plan_production_scale, qualify_production_scale, read_production_evidence,
        ProductionRunPlan, ProductionScaleProfile, ReleaseMetadata,
    },
};

fn main() {
    if let Err(error) = run() {
        eprintln!("gpubnb-prod-labctl: {error:#}");
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
        "qualify" => run_qualify(&args),
        "help" | "--help" | "-h" => {
            print_usage();
            Ok(())
        }
        _ => bail!("unknown command {command}"),
    }
}

fn run_plan(args: &ParsedArgs) -> Result<()> {
    let manifest: LabManifest = read_json(args.required("--distributed-manifest")?)?;
    let profile: ProductionScaleProfile = read_json(args.required("--profile")?)?;
    let release: ReleaseMetadata = read_json(args.required("--release-metadata")?)?;
    let plan = plan_production_scale(&manifest, &profile, release, args.required("--run-id")?)?;
    let encoded = serde_json::to_string_pretty(&plan)?;
    write_output(args.value("--output"), &encoded)?;
    println!("{encoded}");
    if args.flag("--require-pass") && !plan.passed {
        bail!("production scale plan failed");
    }
    Ok(())
}

fn run_qualify(args: &ParsedArgs) -> Result<()> {
    let plan: ProductionRunPlan = read_json(args.required("--plan")?)?;
    let evidence = read_production_evidence(&PathBuf::from(args.required("--evidence-dir")?))?;
    let qualification = qualify_production_scale(&plan, &evidence, args.value("--through-stage"))?;
    let encoded = serde_json::to_string_pretty(&qualification)?;
    write_output(args.value("--output"), &encoded)?;
    println!("{encoded}");
    if args.flag("--require-pass") && !qualification.passed {
        bail!("production scale qualification failed one or more gates");
    }
    Ok(())
}

fn read_json<T>(path: &str) -> Result<T>
where
    T: serde::de::DeserializeOwned,
{
    let path = PathBuf::from(path);
    let raw = std::fs::read(&path).with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_slice(&raw).with_context(|| format!("invalid JSON {}", path.display()))
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
            if token == "--require-pass" {
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
        "gpubnb-prod-labctl\n\n\
         Commands:\n\
           plan --distributed-manifest PATH --profile PATH --release-metadata PATH --run-id ID [--output PATH] [--require-pass]\n\
           qualify --plan PATH --evidence-dir DIR [--through-stage ID] [--output PATH] [--require-pass]\n\n\
         plan derives exact stage shard allocations from the immutable distributed manifest.\n\
         qualify gates progressive promotion and only marks a million live claim measured after final evidence and required chaos drills pass."
    );
}
