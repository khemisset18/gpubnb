use serde::Serialize;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::Mutex;

// These are LOCAL workload-protection thresholds, not server quarantine.
// Mining is stopped conservatively before hardware reaches the platform's
// separate 98 C quarantine boundary. The user never has to manually clear a
// server quarantine just because this local protection fired.
pub const THERMAL_WARNING_CELSIUS: f64 = 80.0;
pub const THERMAL_STOP_CELSIUS: f64 = 85.0;
pub const THERMAL_REARM_CELSIUS: f64 = 75.0;
pub const THERMAL_QUARANTINE_CELSIUS: f64 = 98.0;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn background_command(program: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new(program);
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new(program)
    }
}

pub fn read_native_temperature() -> Result<f64, &'static str> {
    // The thermal monitor runs every five seconds while mining. On Windows a
    // plain console-child launch can flash a terminal on every sample even
    // though nvidia-smi is purely a background sensor.
    let output = background_command("nvidia-smi")
        .args([
            "--query-gpu=temperature.gpu",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .map_err(|_| "gpu_temperature_sensor_unavailable")?;
    if !output.status.success() {
        return Err("gpu_temperature_sensor_unavailable");
    }
    parse_max_temperature(&String::from_utf8_lossy(&output.stdout))
}

fn parse_max_temperature(output: &str) -> Result<f64, &'static str> {
    let temperatures = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            line.parse::<f64>()
                .map_err(|_| "gpu_temperature_sensor_invalid")
        })
        .collect::<Result<Vec<_>, _>>()?;
    temperatures
        .into_iter()
        .filter(|temperature| temperature.is_finite())
        .reduce(f64::max)
        .ok_or("gpu_temperature_sensor_invalid")
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiningThermalSafetySnapshot {
    pub latched: bool,
    pub last_temperature_celsius: Option<f64>,
    pub warning_celsius: f64,
    pub stop_celsius: f64,
    pub rearm_celsius: f64,
    pub quarantine_celsius: f64,
}

#[derive(Debug, Default)]
struct MiningThermalGuard {
    latched: bool,
    last_temperature_celsius: Option<f64>,
}

impl MiningThermalGuard {
    fn observe(&mut self, temperature_celsius: f64) -> bool {
        if !temperature_celsius.is_finite() {
            return false;
        }
        self.last_temperature_celsius = Some(temperature_celsius);

        // Automatic hysteresis: after a protective stop, any subsequent real
        // sensor sample at/below the cool threshold clears the local latch.
        // No acknowledgement button or PowerShell intervention is required.
        if self.latched && temperature_celsius <= THERMAL_REARM_CELSIUS {
            self.latched = false;
            return false;
        }

        if temperature_celsius >= THERMAL_STOP_CELSIUS && !self.latched {
            self.latched = true;
            return true;
        }
        false
    }

    fn acknowledge(&mut self, temperature_celsius: f64) -> Result<(), &'static str> {
        if !temperature_celsius.is_finite() || temperature_celsius > THERMAL_REARM_CELSIUS {
            return Err("miner_temperature_still_too_high");
        }
        self.last_temperature_celsius = Some(temperature_celsius);
        self.latched = false;
        Ok(())
    }

    fn snapshot(&self) -> MiningThermalSafetySnapshot {
        MiningThermalSafetySnapshot {
            latched: self.latched,
            last_temperature_celsius: self.last_temperature_celsius,
            warning_celsius: THERMAL_WARNING_CELSIUS,
            stop_celsius: THERMAL_STOP_CELSIUS,
            rearm_celsius: THERMAL_REARM_CELSIUS,
            quarantine_celsius: THERMAL_QUARANTINE_CELSIUS,
        }
    }
}

#[derive(Debug, Default)]
pub struct MiningThermalSafetyState {
    guard: Mutex<MiningThermalGuard>,
}

impl MiningThermalSafetyState {
    pub fn observe(&self, temperature_celsius: f64) -> Result<bool, &'static str> {
        self.guard
            .lock()
            .map_err(|_| "mining_thermal_guard_unavailable")
            .map(|mut guard| guard.observe(temperature_celsius))
    }

    pub fn ensure_start_allowed(&self) -> Result<(), &'static str> {
        let guard = self
            .guard
            .lock()
            .map_err(|_| "mining_thermal_guard_unavailable")?;
        (!guard.latched)
            .then_some(())
            .ok_or("thermal_safety_review_required")
    }

    pub fn acknowledge(&self, temperature_celsius: f64) -> Result<(), &'static str> {
        self.guard
            .lock()
            .map_err(|_| "mining_thermal_guard_unavailable")?
            .acknowledge(temperature_celsius)
    }

    pub fn snapshot(&self) -> Result<MiningThermalSafetySnapshot, &'static str> {
        // The mining monitor stops sampling once it has stopped the miner. Host
        // Desktop still asks for this snapshot on every UI refresh, so use that
        // read to keep checking the real sensor and automatically clear the local
        // latch after cooldown. If the sensor is unavailable, fail closed by
        // leaving the latch untouched.
        let latched = self
            .guard
            .lock()
            .map_err(|_| "mining_thermal_guard_unavailable")?
            .latched;
        if latched {
            if let Ok(temperature) = read_native_temperature() {
                self.guard
                    .lock()
                    .map_err(|_| "mining_thermal_guard_unavailable")?
                    .observe(temperature);
            }
        }
        self.guard
            .lock()
            .map_err(|_| "mining_thermal_guard_unavailable")
            .map(|guard| guard.snapshot())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protective_stop_is_not_the_98c_quarantine_boundary() {
        assert!(THERMAL_STOP_CELSIUS < THERMAL_QUARANTINE_CELSIUS);
        assert_eq!(THERMAL_QUARANTINE_CELSIUS, 98.0);
        let state = MiningThermalSafetyState::default();
        assert_eq!(state.observe(84.9), Ok(false));
        assert_eq!(state.observe(85.0), Ok(true));
        assert_eq!(state.observe(93.0), Ok(false));
        assert_eq!(
            state.ensure_start_allowed(),
            Err("thermal_safety_review_required")
        );
    }

    #[test]
    fn real_cooldown_auto_rearms_without_user_acknowledgement() {
        let mut guard = MiningThermalGuard::default();
        assert!(guard.observe(90.0));
        assert!(guard.latched);
        assert!(!guard.observe(75.0));
        assert!(!guard.latched);
    }

    #[test]
    fn manual_acknowledge_remains_a_safe_optional_fallback() {
        let state = MiningThermalSafetyState::default();
        state.observe(90.0).unwrap();
        assert_eq!(
            state.acknowledge(75.1),
            Err("miner_temperature_still_too_high")
        );
        assert_eq!(state.acknowledge(75.0), Ok(()));
        assert_eq!(state.ensure_start_allowed(), Ok(()));
    }

    #[test]
    fn rejects_non_finite_sensor_values() {
        let state = MiningThermalSafetyState::default();
        assert_eq!(state.observe(f64::NAN), Ok(false));
        assert_eq!(
            state.acknowledge(f64::INFINITY),
            Err("miner_temperature_still_too_high")
        );
    }

    #[test]
    fn parses_the_hottest_nvidia_gpu() {
        assert_eq!(parse_max_temperature("61\n74\n68\n"), Ok(74.0));
        assert_eq!(
            parse_max_temperature("not-a-temperature\n"),
            Err("gpu_temperature_sensor_invalid")
        );
        assert_eq!(
            parse_max_temperature("\n"),
            Err("gpu_temperature_sensor_invalid")
        );
    }
}
