use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::BufReader,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use ed25519_dalek::{Signer, SigningKey};
use gpubnb_control_gateway::{
    distributed_lab::{
        validate_run_id, EvidenceLatency, ShardLiveEvidence, MAX_CONNECTIONS_PER_INJECTOR,
    },
    protocol::{validate_id, validate_region, AgentMessage, ClientHello, GatewayMessage},
    qualification::summarize_latencies,
    store::{machine_auth_key, machine_presence_key},
    wire::{read_json_frame, write_json_frame},
    CONTROL_GATEWAY_ALPN, CONTROL_GATEWAY_PROTOCOL_VERSION,
};
use quinn::crypto::rustls::QuicClientConfig;
use redis::{aio::MultiplexedConnection, AsyncCommands};
use rustls::RootCertStore;
use tokio::sync::Barrier;

const FRAME_BYTES: usize = 64 * 1024;
const CONNECT_TIMEOUT_SECONDS: u64 = 10;
const PRESENCE_PROBE_TIMEOUT_MS: u64 = 2_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Scenario {
    Steady,
    ReconnectStorm,
}

impl Scenario {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "steady" => Ok(Self::Steady),
            "reconnect-storm" => Ok(Self::ReconnectStorm),
            _ => bail!("scenario must be steady or reconnect-storm"),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Steady => "steady",
            Self::ReconnectStorm => "reconnect-storm",
        }
    }
}

#[derive(Clone, Debug)]
struct Config {
    run_id: String,
    shard_id: String,
    region: String,
    machine_id_start: u64,
    scenario: Scenario,
    gateway: SocketAddr,
    server_name: String,
    ca_cert: PathBuf,
    redis_url: String,
    connections: u64,
    duration_seconds: u64,
    heartbeat_ms: u64,
    ramp_ms: u64,
    reconnect_cycles: u32,
    reconnect_jitter_ms: u64,
    presence_sample_every: u64,
    seed: u64,
    max_connect_p99_ms: u64,
    max_presence_p99_ms: u64,
    max_failure_bps: u64,
    require_pass: bool,
    keep_test_auth: bool,
}

#[derive(Default)]
struct Accumulator {
    connect_latencies_ms: Mutex<Vec<u64>>,
    presence_latencies_ms: Mutex<Vec<u64>>,
    failure_reasons: Mutex<BTreeMap<String, u64>>,
    successful_connections: std::sync::atomic::AtomicU64,
    failed_connections: std::sync::atomic::AtomicU64,
    heartbeat_attempts: std::sync::atomic::AtomicU64,
    heartbeat_failures: std::sync::atomic::AtomicU64,
    presence_probe_attempts: std::sync::atomic::AtomicU64,
    presence_probe_failures: std::sync::atomic::AtomicU64,
}

impl Accumulator {
    fn failure(&self, class: &str) {
        let mut failures = self.failure_reasons.lock().expect("failure mutex poisoned");
        *failures.entry(class.to_owned()).or_insert(0) += 1;
    }
}

struct ConnectedAgent {
    connection: quinn::Connection,
    send: quinn::SendStream,
    connect_latency_ms: u64,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("gpubnb-load-shard: {error:#}");
        std::process::exit(2);
    }
}

async fn run() -> Result<()> {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    if raw
        .iter()
        .any(|value| matches!(value.as_str(), "--help" | "-h"))
    {
        print_usage();
        return Ok(());
    }
    let args = ParsedArgs::parse(&raw)?;
    if !args.flag("--allow-test-auth-write") {
        bail!("shard runner requires --allow-test-auth-write because it seeds isolated test identities in Redis");
    }

    let run_id = args.required("--run-id")?.to_owned();
    validate_run_id(&run_id)?;
    let shard_id = args.required("--shard-id")?.to_owned();
    validate_id(&shard_id, "shard_id")?;
    let region = args.required("--region")?.to_owned();
    validate_region(&region)?;

    let config = Config {
        run_id,
        shard_id,
        region,
        machine_id_start: args
            .required("--machine-id-start")?
            .parse::<u64>()
            .context("--machine-id-start must be an integer")?,
        scenario: Scenario::parse(args.value("--scenario").unwrap_or("steady"))?,
        gateway: args
            .required("--gateway")?
            .parse()
            .context("--gateway must be host:port socket address")?,
        server_name: args.required("--server-name")?.to_owned(),
        ca_cert: PathBuf::from(args.required("--ca-cert")?),
        redis_url: args.required("--redis-url")?.to_owned(),
        connections: parse_u64(
            args.value("--connections"),
            128,
            1,
            MAX_CONNECTIONS_PER_INJECTOR,
            "--connections",
        )?,
        duration_seconds: parse_u64(
            args.value("--duration-seconds"),
            5,
            1,
            86_400,
            "--duration-seconds",
        )?,
        heartbeat_ms: parse_u64(
            args.value("--heartbeat-ms"),
            1_000,
            100,
            300_000,
            "--heartbeat-ms",
        )?,
        ramp_ms: parse_u64(args.value("--ramp-ms"), 1_000, 0, 600_000, "--ramp-ms")?,
        reconnect_cycles: parse_u64(
            args.value("--reconnect-cycles"),
            3,
            1,
            1_000,
            "--reconnect-cycles",
        )? as u32,
        reconnect_jitter_ms: parse_u64(
            args.value("--reconnect-jitter-ms"),
            1_000,
            0,
            3_600_000,
            "--reconnect-jitter-ms",
        )?,
        presence_sample_every: parse_u64(
            args.value("--presence-sample-every"),
            16,
            1,
            1_000_000,
            "--presence-sample-every",
        )?,
        seed: parse_u64(args.value("--seed"), 42, 1, u64::MAX, "--seed")?,
        max_connect_p99_ms: parse_u64(
            args.value("--max-connect-p99-ms"),
            5_000,
            1,
            120_000,
            "--max-connect-p99-ms",
        )?,
        max_presence_p99_ms: parse_u64(
            args.value("--max-presence-p99-ms"),
            2_000,
            1,
            120_000,
            "--max-presence-p99-ms",
        )?,
        max_failure_bps: parse_u64(
            args.value("--max-failure-bps"),
            100,
            0,
            10_000,
            "--max-failure-bps",
        )?,
        require_pass: args.flag("--require-pass"),
        keep_test_auth: args.flag("--keep-test-auth"),
    };
    config
        .machine_id_start
        .checked_add(config.connections - 1)
        .context("machine identity shard range overflow")?;

    let report = run_shard(config.clone()).await?;
    let encoded = serde_json::to_string_pretty(&report)?;
    write_output(args.value("--output"), &encoded)?;
    println!("{encoded}");
    if config.require_pass && !report.passed {
        bail!("load shard failed one or more local SLO gates");
    }
    Ok(())
}

async fn run_shard(config: Config) -> Result<ShardLiveEvidence> {
    let endpoint = Arc::new(build_client_endpoint(config.gateway, &config.ca_cert)?);
    let redis_client =
        redis::Client::open(config.redis_url.as_str()).context("invalid Redis URL")?;
    let redis = redis_client
        .get_multiplexed_async_connection()
        .await
        .context("failed to connect shard runner to Redis")?;
    seed_test_auth(&redis, &config).await?;

    let accumulator = Arc::new(Accumulator::default());
    let barrier = Arc::new(Barrier::new(config.connections as usize + 1));
    let mut tasks = Vec::with_capacity(config.connections as usize);
    for local_index in 0..config.connections {
        let endpoint = endpoint.clone();
        let config = config.clone();
        let accumulator = accumulator.clone();
        let barrier = barrier.clone();
        let redis = redis.clone();
        tasks.push(tokio::spawn(async move {
            barrier.wait().await;
            if config.ramp_ms > 0 {
                let delay = deterministic_delay_ms(config.seed, local_index, 0, config.ramp_ms);
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
            match config.scenario {
                Scenario::Steady => {
                    run_steady_agent(local_index, &config, &endpoint, redis, &accumulator).await
                }
                Scenario::ReconnectStorm => {
                    run_reconnect_agent(local_index, &config, &endpoint, &accumulator).await
                }
            }
        }));
    }
    barrier.wait().await;
    for task in tasks {
        if let Err(error) = task.await {
            accumulator
                .failed_connections
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            accumulator.failure(&format!("task_join:{error}"));
        }
    }
    endpoint.close(0_u8.into(), b"distributed shard qualification complete");
    endpoint.wait_idle().await;

    if !config.keep_test_auth {
        cleanup_test_auth(&redis, &config).await?;
    }

    let successful_connections = accumulator
        .successful_connections
        .load(std::sync::atomic::Ordering::Relaxed);
    let failed_connections = accumulator
        .failed_connections
        .load(std::sync::atomic::Ordering::Relaxed);
    let heartbeat_attempts = accumulator
        .heartbeat_attempts
        .load(std::sync::atomic::Ordering::Relaxed);
    let heartbeat_failures = accumulator
        .heartbeat_failures
        .load(std::sync::atomic::Ordering::Relaxed);
    let presence_probe_attempts = accumulator
        .presence_probe_attempts
        .load(std::sync::atomic::Ordering::Relaxed);
    let presence_probe_failures = accumulator
        .presence_probe_failures
        .load(std::sync::atomic::Ordering::Relaxed);
    let mut connect_values = accumulator
        .connect_latencies_ms
        .lock()
        .expect("latency mutex poisoned")
        .clone();
    let mut presence_values = accumulator
        .presence_latencies_ms
        .lock()
        .expect("latency mutex poisoned")
        .clone();
    let connect_latency = to_evidence_latency(summarize_latencies(&mut connect_values));
    let presence_commit_latency = to_evidence_latency(summarize_latencies(&mut presence_values));
    let connection_failure_bps = failure_bps(
        failed_connections,
        successful_connections.saturating_add(failed_connections),
    );
    let heartbeat_failure_bps = failure_bps(heartbeat_failures, heartbeat_attempts);
    let presence_failure_bps = failure_bps(presence_probe_failures, presence_probe_attempts);
    let passed = connection_failure_bps <= config.max_failure_bps
        && heartbeat_failure_bps <= config.max_failure_bps
        && presence_failure_bps <= config.max_failure_bps
        && connect_latency.p99_ms <= config.max_connect_p99_ms
        && presence_commit_latency.p99_ms <= config.max_presence_p99_ms;
    let failure_reasons = accumulator
        .failure_reasons
        .lock()
        .expect("failure mutex poisoned")
        .clone();

    Ok(ShardLiveEvidence {
        schema_version: 1,
        run_id: config.run_id,
        shard_id: config.shard_id,
        region: config.region,
        scenario: config.scenario.as_str().to_owned(),
        machine_id_start: config.machine_id_start,
        requested_connections: config.connections,
        successful_connections,
        failed_connections,
        heartbeat_attempts,
        heartbeat_failures,
        presence_probe_attempts,
        presence_probe_failures,
        connect_latency,
        presence_commit_latency,
        failure_reasons,
        passed,
    })
}

async fn run_steady_agent(
    local_index: u64,
    config: &Config,
    endpoint: &quinn::Endpoint,
    redis: MultiplexedConnection,
    accumulator: &Accumulator,
) {
    let absolute = config.machine_id_start + local_index;
    let key = signing_key(config.seed, absolute);
    let machine = machine_id(&config.run_id, absolute);
    let mut agent = match connect_agent(
        endpoint,
        config.gateway,
        &config.server_name,
        &machine,
        &key,
        0,
        0,
    )
    .await
    {
        Ok(agent) => agent,
        Err(error) => {
            accumulator
                .failed_connections
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            accumulator.failure(&format!("connect:{}", error_class(&error)));
            return;
        }
    };
    accumulator
        .successful_connections
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    accumulator
        .connect_latencies_ms
        .lock()
        .expect("latency mutex poisoned")
        .push(agent.connect_latency_ms);

    let started = Instant::now();
    let mut sequence = 0_u64;
    let mut redis = redis;
    while started.elapsed() < Duration::from_secs(config.duration_seconds) {
        sequence += 1;
        accumulator
            .heartbeat_attempts
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let observed_at_ms = match now_ms() {
            Ok(value) => value,
            Err(error) => {
                accumulator
                    .heartbeat_failures
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                accumulator.failure(&format!("clock:{}", error_class(&error)));
                break;
            }
        };
        let probe_started = Instant::now();
        if let Err(error) = write_json_frame(
            &mut agent.send,
            &AgentMessage::Heartbeat {
                sequence,
                observed_at_ms,
            },
            FRAME_BYTES,
        )
        .await
        {
            accumulator
                .heartbeat_failures
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            accumulator.failure(&format!("heartbeat_write:{}", error_class(&error)));
            break;
        }
        if sequence == 1 && local_index % config.presence_sample_every == 0 {
            accumulator
                .presence_probe_attempts
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            match wait_presence_sequence(&mut redis, &machine, sequence).await {
                Ok(()) => accumulator
                    .presence_latencies_ms
                    .lock()
                    .expect("latency mutex poisoned")
                    .push(elapsed_ms(probe_started)),
                Err(error) => {
                    accumulator
                        .presence_probe_failures
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    accumulator.failure(&format!("presence_probe:{}", error_class(&error)));
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(config.heartbeat_ms)).await;
    }
    agent
        .connection
        .close(0_u8.into(), b"steady shard complete");
}

async fn run_reconnect_agent(
    local_index: u64,
    config: &Config,
    endpoint: &quinn::Endpoint,
    accumulator: &Accumulator,
) {
    let absolute = config.machine_id_start + local_index;
    let key = signing_key(config.seed, absolute);
    let machine = machine_id(&config.run_id, absolute);
    for cycle in 0..config.reconnect_cycles {
        if config.reconnect_jitter_ms > 0 {
            tokio::time::sleep(Duration::from_millis(deterministic_delay_ms(
                config.seed,
                absolute,
                u64::from(cycle) + 1,
                config.reconnect_jitter_ms,
            )))
            .await;
        }
        match connect_agent(
            endpoint,
            config.gateway,
            &config.server_name,
            &machine,
            &key,
            0,
            u64::from(cycle),
        )
        .await
        {
            Ok(mut agent) => {
                accumulator
                    .successful_connections
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                accumulator
                    .connect_latencies_ms
                    .lock()
                    .expect("latency mutex poisoned")
                    .push(agent.connect_latency_ms);
                accumulator
                    .heartbeat_attempts
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let heartbeat = AgentMessage::Heartbeat {
                    sequence: 1,
                    observed_at_ms: now_ms().unwrap_or(1),
                };
                if write_json_frame(&mut agent.send, &heartbeat, FRAME_BYTES)
                    .await
                    .is_err()
                {
                    accumulator
                        .heartbeat_failures
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    accumulator.failure("heartbeat_write:reconnect_cycle");
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
                agent
                    .connection
                    .close(0_u8.into(), b"reconnect shard cycle complete");
            }
            Err(error) => {
                accumulator
                    .failed_connections
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                accumulator.failure(&format!("connect:{}", error_class(&error)));
            }
        }
    }
}

async fn connect_agent(
    endpoint: &quinn::Endpoint,
    gateway: SocketAddr,
    server_name: &str,
    machine_id: &str,
    signing_key: &SigningKey,
    last_acked_sequence: u64,
    nonce_salt: u64,
) -> Result<ConnectedAgent> {
    let started = Instant::now();
    let connecting = endpoint
        .connect(gateway, server_name)
        .context("failed to start QUIC connect")?;
    let connection = tokio::time::timeout(Duration::from_secs(CONNECT_TIMEOUT_SECONDS), connecting)
        .await
        .context("QUIC connect timeout")?
        .context("QUIC handshake failed")?;
    let (mut send, mut recv) = tokio::time::timeout(
        Duration::from_secs(CONNECT_TIMEOUT_SECONDS),
        connection.open_bi(),
    )
    .await
    .context("opening auth stream timed out")?
    .context("failed to open auth stream")?;
    let issued_at_ms = now_ms()?;
    let mut hello = ClientHello {
        protocol_version: CONTROL_GATEWAY_PROTOCOL_VERSION,
        machine_id: machine_id.to_owned(),
        key_version: 1,
        issued_at_ms,
        nonce: nonce_for(machine_id, issued_at_ms, nonce_salt),
        last_acked_command_sequence: last_acked_sequence,
        signature_hex: String::new(),
    };
    hello.signature_hex = hex::encode(signing_key.sign(&hello.signing_bytes()).to_bytes());
    write_json_frame(&mut send, &hello, FRAME_BYTES).await?;
    let frame: GatewayMessage = tokio::time::timeout(
        Duration::from_secs(CONNECT_TIMEOUT_SECONDS),
        read_json_frame(&mut recv, FRAME_BYTES),
    )
    .await
    .context("server hello timed out")??;
    match frame {
        GatewayMessage::ServerHello { hello } => {
            if hello.protocol_version != CONTROL_GATEWAY_PROTOCOL_VERSION {
                bail!("server hello protocol mismatch");
            }
        }
        _ => bail!("first gateway frame was not SERVER_HELLO"),
    }
    Ok(ConnectedAgent {
        connection,
        send,
        connect_latency_ms: elapsed_ms(started),
    })
}

async fn seed_test_auth(redis: &MultiplexedConnection, config: &Config) -> Result<()> {
    let mut redis = redis.clone();
    for batch_start in (0..config.connections).step_by(1_000) {
        let batch_end = config.connections.min(batch_start + 1_000);
        let mut pipeline = redis::pipe();
        for local in batch_start..batch_end {
            let absolute = config.machine_id_start + local;
            let machine = machine_id(&config.run_id, absolute);
            let key = signing_key(config.seed, absolute);
            let public = bs58::encode(key.verifying_key().as_bytes()).into_string();
            pipeline
                .cmd("HSET")
                .arg(machine_auth_key(&machine))
                .arg("status")
                .arg("ACTIVE")
                .arg("keyVersion")
                .arg("1")
                .arg("agentPublicKey")
                .arg(public)
                .ignore();
        }
        let _: () = pipeline
            .query_async(&mut redis)
            .await
            .context("failed to seed distributed test auth cache")?;
    }
    Ok(())
}

async fn cleanup_test_auth(redis: &MultiplexedConnection, config: &Config) -> Result<()> {
    let mut redis = redis.clone();
    for batch_start in (0..config.connections).step_by(1_000) {
        let batch_end = config.connections.min(batch_start + 1_000);
        let mut pipeline = redis::pipe();
        for local in batch_start..batch_end {
            let machine = machine_id(&config.run_id, config.machine_id_start + local);
            pipeline.cmd("DEL").arg(machine_auth_key(&machine)).ignore();
            pipeline
                .cmd("DEL")
                .arg(machine_presence_key(&machine))
                .ignore();
        }
        let _: () = pipeline
            .query_async(&mut redis)
            .await
            .context("failed to clean distributed test auth cache")?;
    }
    Ok(())
}

async fn wait_presence_sequence(
    redis: &mut MultiplexedConnection,
    machine_id: &str,
    expected_sequence: u64,
) -> Result<()> {
    let key = machine_presence_key(machine_id);
    let deadline = Instant::now() + Duration::from_millis(PRESENCE_PROBE_TIMEOUT_MS);
    loop {
        let raw: Option<String> = redis
            .hget(&key, "sequence")
            .await
            .context("presence HGET failed")?;
        if raw
            .as_deref()
            .and_then(|value| value.parse::<u64>().ok())
            .is_some_and(|value| value >= expected_sequence)
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            bail!("presence sequence did not commit before timeout");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn build_client_endpoint(gateway: SocketAddr, ca_cert: &Path) -> Result<quinn::Endpoint> {
    let mut roots = RootCertStore::empty();
    let mut reader = BufReader::new(
        File::open(ca_cert)
            .with_context(|| format!("failed to open CA certificate {}", ca_cert.display()))?,
    );
    let mut cert_count = 0_u64;
    for cert in rustls_pemfile::certs(&mut reader) {
        roots
            .add(cert.context("invalid CA certificate PEM")?)
            .context("failed to add CA certificate")?;
        cert_count += 1;
    }
    if cert_count == 0 {
        bail!("CA certificate file contained no certificates");
    }
    let mut tls = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    tls.alpn_protocols = vec![CONTROL_GATEWAY_ALPN.as_bytes().to_vec()];
    let quic_crypto =
        QuicClientConfig::try_from(tls).context("failed to create QUIC rustls client config")?;
    let mut client = quinn::ClientConfig::new(Arc::new(quic_crypto));
    let mut transport = quinn::TransportConfig::default();
    transport.keep_alive_interval(Some(Duration::from_secs(10)));
    transport.max_idle_timeout(Some(
        Duration::from_secs(120)
            .try_into()
            .context("invalid idle timeout")?,
    ));
    client.transport_config(Arc::new(transport));
    let bind: SocketAddr = if gateway.is_ipv4() {
        "0.0.0.0:0".parse()?
    } else {
        "[::]:0".parse()?
    };
    let mut endpoint =
        quinn::Endpoint::client(bind).context("failed to create QUIC client endpoint")?;
    endpoint.set_default_client_config(client);
    Ok(endpoint)
}

fn signing_key(seed: u64, absolute_index: u64) -> SigningKey {
    let mut bytes = [0_u8; 32];
    let mut state = seed ^ absolute_index.wrapping_mul(0x9e37_79b9_7f4a_7c15);
    for chunk in bytes.chunks_mut(8) {
        state = mix64(state);
        chunk.copy_from_slice(&state.to_le_bytes());
    }
    SigningKey::from_bytes(&bytes)
}

fn machine_id(run_id: &str, absolute_index: u64) -> String {
    format!("load_machine_{run_id}_{absolute_index:012}")
}

fn nonce_for(machine_id: &str, issued_at_ms: u64, salt: u64) -> String {
    let mut hash = issued_at_ms ^ salt ^ 0x6a09_e667_f3bc_c909;
    for byte in machine_id.bytes() {
        hash = mix64(hash ^ u64::from(byte));
    }
    format!("{hash:016x}{:016x}", mix64(hash ^ salt ^ issued_at_ms))
}

fn deterministic_delay_ms(seed: u64, index: u64, cycle: u64, window_ms: u64) -> u64 {
    if window_ms == 0 {
        return 0;
    }
    mix64(seed ^ index.rotate_left(17) ^ cycle.rotate_left(31)) % window_ms
}

fn mix64(mut value: u64) -> u64 {
    value = value.wrapping_add(0x9e37_79b9_7f4a_7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn now_ms() -> Result<u64> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock before UNIX epoch")?
        .as_millis();
    u64::try_from(millis).context("system clock milliseconds overflow u64")
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn failure_bps(failures: u64, attempts: u64) -> u64 {
    if attempts == 0 {
        return if failures == 0 { 0 } else { 10_000 };
    }
    failures.saturating_mul(10_000).div_ceil(attempts)
}

fn to_evidence_latency(
    value: gpubnb_control_gateway::qualification::LatencySummary,
) -> EvidenceLatency {
    EvidenceLatency {
        samples: value.samples,
        min_ms: value.min_ms,
        p50_ms: value.p50_ms,
        p95_ms: value.p95_ms,
        p99_ms: value.p99_ms,
        max_ms: value.max_ms,
    }
}

fn error_class(error: &anyhow::Error) -> String {
    let raw = error.root_cause().to_string();
    let normalized: String = raw
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    normalized.trim_matches('_').chars().take(80).collect()
}

fn parse_u64(value: Option<&str>, default: u64, min: u64, max: u64, field: &str) -> Result<u64> {
    let parsed = match value {
        Some(value) => value
            .parse::<u64>()
            .with_context(|| format!("{field} must be an integer"))?,
        None => default,
    };
    if parsed < min || parsed > max {
        bail!("{field} outside allowed range {min}..={max}");
    }
    Ok(parsed)
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
            if matches!(
                token.as_str(),
                "--allow-test-auth-write" | "--require-pass" | "--keep-test-auth"
            ) {
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
        "gpubnb-load-shard\n\n\
         Required identity arguments:\n\
           --run-id ID --shard-id ID --region REGION --machine-id-start N\n\n\
         Required transport arguments:\n\
           --gateway HOST:PORT --server-name NAME --ca-cert PATH --redis-url URL --allow-test-auth-write\n\n\
         Load arguments:\n\
           --scenario steady|reconnect-storm --connections N --duration-seconds N --heartbeat-ms N\n\
           --ramp-ms N --reconnect-cycles N --reconnect-jitter-ms N --presence-sample-every N --seed N\n\n\
         Gates:\n\
           --max-connect-p99-ms N --max-presence-p99-ms N --max-failure-bps N --require-pass\n\n\
         Every generated machine id is namespaced as load_machine_<run-id>_<absolute-index>."
    );
}
