use crate::miner_paths;
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const MAX_TELEMETRY_TAIL_BYTES: u64 = 256 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiningTelemetry {
    pub available: bool,
    pub device_name: Option<String>,
    pub hashrate: Option<f64>,
    pub hashrate_unit: Option<String>,
    pub accepted_shares: Option<u64>,
    pub stale_shares: Option<u64>,
    pub hardware_errors: Option<u64>,
    pub temperature_celsius: Option<f64>,
    pub power_watts: Option<f64>,
    pub uptime_seconds: Option<u64>,
    pub pool_connected: bool,
}

pub fn read(profile_id: &str) -> Result<MiningTelemetry, &'static str> {
    let root = miner_paths::approved_miner_root()?;
    let log = read_tail(&root.join("logs").join("miner-stdout.log"))?;
    Ok(if profile_id == "xmrig_randomx" {
        parse_xmrig(&log)
    } else if profile_id.starts_with("lolminer_") {
        parse_lolminer(&log)
    } else {
        MiningTelemetry::default()
    })
}

fn read_tail(path: &Path) -> Result<String, &'static str> {
    let mut file = File::open(path).map_err(|_| "miner_telemetry_log_unavailable")?;
    let len = file
        .metadata()
        .map_err(|_| "miner_telemetry_log_unavailable")?
        .len();
    let start = len.saturating_sub(MAX_TELEMETRY_TAIL_BYTES);
    file.seek(SeekFrom::Start(start))
        .map_err(|_| "miner_telemetry_log_unavailable")?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| "miner_telemetry_log_unavailable")?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn latest_session<'a>(log: &'a str, marker: &str) -> &'a str {
    log.rsplit_once(marker)
        .map(|(_, session)| session)
        .unwrap_or(log)
}

fn parse_lolminer(log: &str) -> MiningTelemetry {
    let session = latest_session(log, "Setup Miner...");
    let mut telemetry = MiningTelemetry {
        pool_connected: session.contains("Authorized worker:") || session.contains("Connected to:"),
        ..MiningTelemetry::default()
    };
    for line in session.lines() {
        let clean = strip_ansi(line);
        if let Some(value) = clean.strip_prefix("Statistics (") {
            if let Some((_, uptime)) = value.split_once("Uptime:") {
                telemetry.uptime_seconds = parse_uptime(uptime.trim());
            }
        }
        if !clean.trim_start().starts_with("GPU 0 ") {
            continue;
        }
        let fields: Vec<&str> = clean.split_whitespace().collect();
        let Some(share_index) = fields
            .iter()
            .position(|field| parse_shares(field).is_some())
        else {
            continue;
        };
        if share_index < 4 || fields.len() <= share_index + 6 {
            continue;
        }
        telemetry.device_name = Some(fields[2..share_index - 2].join(" "));
        telemetry.hashrate = fields[share_index - 2].parse().ok();
        telemetry.hashrate_unit = Some("MH/s".into());
        if let Some((accepted, stale, hardware)) = parse_shares(fields[share_index]) {
            telemetry.accepted_shares = Some(accepted);
            telemetry.stale_shares = Some(stale);
            telemetry.hardware_errors = Some(hardware);
        }
        telemetry.power_watts = fields[share_index + 3].parse().ok();
        telemetry.temperature_celsius = fields[share_index + 6].parse().ok();
        telemetry.available = telemetry.hashrate.is_some();
    }
    telemetry
}

fn parse_xmrig(log: &str) -> MiningTelemetry {
    let session = latest_session(log, "* ABOUT");
    let mut telemetry = MiningTelemetry {
        pool_connected: session.contains("new job from"),
        ..MiningTelemetry::default()
    };
    for line in session.lines() {
        let clean = strip_ansi(line);
        if let Some(cpu) = clean.trim().strip_prefix("* CPU") {
            telemetry.device_name = cpu.split(" (1)").next().map(str::trim).map(str::to_owned);
        }
        if clean.contains("accepted (") {
            if let Some(value) = clean
                .split("accepted (")
                .nth(1)
                .and_then(|part| part.split('/').next())
            {
                telemetry.accepted_shares = value.parse().ok();
            }
        }
        if let Some(speed) = clean.split("speed 10s/60s/15m").nth(1) {
            telemetry.hashrate = speed
                .split_whitespace()
                .next()
                .and_then(|value| value.parse().ok());
            telemetry.hashrate_unit = Some("H/s".into());
            telemetry.available = telemetry.hashrate.is_some();
        }
    }
    telemetry
}

fn parse_shares(value: &str) -> Option<(u64, u64, u64)> {
    let values: Vec<u64> = value
        .split('/')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    (values.len() == 3).then(|| (values[0], values[1], values[2]))
}

fn parse_uptime(value: &str) -> Option<u64> {
    let mut seconds = 0_u64;
    for field in value.split_whitespace() {
        let (number, multiplier) = match field.as_bytes().last().copied()? {
            b'h' => (&field[..field.len() - 1], 3600),
            b'm' => (&field[..field.len() - 1], 60),
            b's' => (&field[..field.len() - 1], 1),
            _ => continue,
        };
        seconds = seconds.checked_add(number.parse::<u64>().ok()?.checked_mul(multiplier)?)?;
    }
    Some(seconds)
}

fn strip_ansi(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut characters = value.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\u{1b}' && characters.peek() == Some(&'[') {
            characters.next();
            for escaped in characters.by_ref() {
                if escaped.is_ascii_alphabetic() {
                    break;
                }
            }
        } else if character != '\r' {
            output.push(character);
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lolminer_statistics_without_guessing_revenue() {
        let log = "Setup Miner...\nAuthorized worker: wallet\nStatistics (01:51:00); Uptime: 0h 7m 0s\nGPU 0 GTX 1650 113.87 333.33 2/0/0 45.6G 5.771 19.7 495 6000 93 err\n";
        let telemetry = parse_lolminer(log);
        assert_eq!(telemetry.device_name.as_deref(), Some("GTX 1650"));
        assert_eq!(telemetry.hashrate, Some(113.87));
        assert_eq!(telemetry.accepted_shares, Some(2));
        assert_eq!(telemetry.stale_shares, Some(0));
        assert_eq!(telemetry.hardware_errors, Some(0));
        assert_eq!(telemetry.temperature_celsius, Some(93.0));
        assert_eq!(telemetry.power_watts, Some(19.7));
        assert_eq!(telemetry.uptime_seconds, Some(420));
        assert!(telemetry.pool_connected);
    }

    #[test]
    fn only_reads_the_latest_lolminer_session() {
        let log = "Setup Miner...\nGPU 0 OLD 999.0 0 9/9/9 1G 1 99 1 1 99 err\nSetup Miner...\nGPU 0 GTX 1650 80.0 90.0 1/0/0 2G 4 20 1 1 70 ok\n";
        let telemetry = parse_lolminer(log);
        assert_eq!(telemetry.device_name.as_deref(), Some("GTX 1650"));
        assert_eq!(telemetry.hashrate, Some(80.0));
        assert_eq!(telemetry.temperature_celsius, Some(70.0));
    }

    #[test]
    fn parses_xmrig_cpu_hashrate_and_accepted_shares() {
        let log = "* ABOUT XMRig\n * CPU Intel(R) Core(TM) i5-10300H CPU @ 2.50GHz (1) 64-bit\nnet new job from pool\ncpu accepted (2/0) diff 20000\nminer speed 10s/60s/15m 716.0 651.5 n/a H/s\n";
        let telemetry = parse_xmrig(log);
        assert_eq!(telemetry.hashrate, Some(716.0));
        assert_eq!(telemetry.accepted_shares, Some(2));
        assert!(telemetry.pool_connected);
    }
}
