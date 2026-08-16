use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use gpubnb_control_gateway::{
    p2p::RelayPolicy,
    p2p_qualification::{
        issue_to_file, now_ms, parse_options, take_required, IssueRequest,
        DEFAULT_QUALIFICATION_TTL_MS,
    },
};

fn run() -> Result<()> {
    let mut options = parse_options(std::env::args().skip(1))?;
    let relay_policy = match take_required(&mut options, "--relay-policy")?.as_str() {
        "DIRECT_ONLY" => RelayPolicy::DirectOnly,
        _ => bail!("qualification CLI permits only DIRECT_ONLY relay policy"),
    };
    let ttl_ms = options
        .remove("--ttl-seconds")
        .map(|value| value.parse::<u64>().context("invalid --ttl-seconds"))
        .transpose()?
        .unwrap_or(DEFAULT_QUALIFICATION_TTL_MS / 1_000)
        .checked_mul(1_000)
        .context("qualification ticket TTL overflow")?;
    let request = IssueRequest {
        host_candidates: take_required(&mut options, "--host-candidates")?.into(),
        renter_candidates: take_required(&mut options, "--renter-candidates")?.into(),
        host_ephemeral_public_key: take_required(&mut options, "--host-ephemeral-public-key")?,
        renter_ephemeral_public_key: take_required(&mut options, "--renter-ephemeral-public-key")?,
        session_id: take_required(&mut options, "--session-id")?,
        machine_id: take_required(&mut options, "--machine-id")?,
        lease_id: take_required(&mut options, "--lease-id")?,
        fencing_token: take_required(&mut options, "--fencing-token")?,
        relay_policy,
        signing_key_file: PathBuf::from(take_required(&mut options, "--signing-key-file")?),
        output: PathBuf::from(take_required(&mut options, "--output")?),
        ttl_ms,
    };
    if !options.is_empty() {
        bail!("unknown qualification ticket option");
    }
    issue_to_file(&request, now_ms()?)?;
    println!("qualification rendezvous ticket written to {}", request.output.display());
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("p2p_qualification_ticket_failed: {error:#}");
        std::process::exit(2);
    }
}
