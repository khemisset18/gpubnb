use std::path::PathBuf;

use anyhow::{bail, Result};
use gpubnb_control_gateway::p2p_qualification::{
    generate_qualification_key, parse_options, take_required,
};

fn run() -> Result<()> {
    let mut options = parse_options(std::env::args().skip(1))?;
    let private = PathBuf::from(take_required(&mut options, "--private-key-output")?);
    let public = PathBuf::from(take_required(&mut options, "--public-key-output")?);
    if !options.is_empty() {
        bail!("unknown qualification keygen option");
    }
    generate_qualification_key(&private, &public)?;
    println!("qualification Ed25519 key created; public key written to {}", public.display());
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("p2p_qualification_keygen_failed: {error:#}");
        std::process::exit(2);
    }
}
