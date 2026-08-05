use serde::Serialize;
use std::process::Command;
use std::sync::Mutex;

pub const THERMAL_WARNING_CELSIUS: f64 = 80.0;
pub const THERMAL_STOP_CELSIUS: f64 = 85.0;
pub const THERMAL_REARM_CELSIUS: f64 = 75.0;

pub fn read_native_temperature() -> Result<f64, &'static str> {
    let output = Command::new("nvidia-smi")
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
    fn stops_once_at_the_fail_closed_threshold() {
        let state = MiningThermalSafetyState::default();
        assert_eq!(state.observe(84.9), Ok(false));
        assert_eq!(state.observe(85.0), Ok(true));
        assert_eq!(state.observe(93.0), Ok(false));
        assert_eq!(state.ensure_start_allowed(), Err("thermal_safety_review_required"));
    }

    #[test]
    fn requires_real_cooldown_before_rearming() {
        let state = MiningThermalSafetyState::default();
        state.observe(90.0).unwrap();
        assert_eq!(state.acknowledge(75.1), Err("miner_temperature_still_too_high"));
        assert_eq!(state.acknowledge(75.0), Ok(()));
        assert_eq!(state.ensure_start_allowed(), Ok(()));
    }

    #[test]
    fn rejects_non_finite_sensor_values() {
        let state = MiningThermalSafetyState::default();
        assert_eq!(state.observe(f64::NAN), Ok(false));
        assert_eq!(state.acknowledge(f64::INFINITY), Err("miner_temperature_still_too_high"));
    }

    #[test]
    fn parses_the_hottest_nvidia_gpu() {
        assert_eq!(parse_max_temperature("61\n74\n68\n"), Ok(74.0));
        assert_eq!(
            parse_max_temperature("not-a-temperature\n"),
            Err("gpu_temperature_sensor_invalid")
        );
        assert_eq!(parse_max_temperature("\n"), Err("gpu_temperature_sensor_invalid"));
    }
}
