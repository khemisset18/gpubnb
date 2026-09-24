use serde::{Deserialize, Serialize};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

pub const DEFAULT_THERMAL_STOP_CELSIUS: u16 = 85;
pub const MIN_THERMAL_STOP_CELSIUS: u16 = 85;
pub const MAX_THERMAL_STOP_CELSIUS: u16 = 98;
pub const THERMAL_WARNING_CELSIUS: f64 = 85.0;
pub const THERMAL_QUARANTINE_CELSIUS: f64 = 98.0;
const SETTINGS_FILE_NAME: &str = "mining-thermal-settings.json";

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MiningThermalSettings {
    stop_celsius: u16,
}

impl Default for MiningThermalSettings {
    fn default() -> Self {
        Self {
            stop_celsius: DEFAULT_THERMAL_STOP_CELSIUS,
        }
    }
}

impl MiningThermalSettings {
    fn validate(self) -> Result<Self, &'static str> {
        if !(MIN_THERMAL_STOP_CELSIUS..=MAX_THERMAL_STOP_CELSIUS)
            .contains(&self.stop_celsius)
        {
            return Err("mining_thermal_stop_out_of_range");
        }
        Ok(self)
    }

    fn rearm_celsius(self) -> f64 {
        if self.stop_celsius == DEFAULT_THERMAL_STOP_CELSIUS {
            75.0
        } else {
            80.0
        }
    }
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
    pub customized: bool,
}

#[derive(Debug, Default)]
struct MiningThermalGuard {
    latched: bool,
    last_temperature_celsius: Option<f64>,
}

impl MiningThermalGuard {
    fn observe(&mut self, temperature_celsius: f64, settings: MiningThermalSettings) -> bool {
        if !temperature_celsius.is_finite() {
            return false;
        }
        self.last_temperature_celsius = Some(temperature_celsius);

        if self.latched && temperature_celsius <= settings.rearm_celsius() {
            self.latched = false;
            return false;
        }

        if temperature_celsius >= f64::from(settings.stop_celsius) && !self.latched {
            self.latched = true;
            return true;
        }
        false
    }

    fn acknowledge(
        &mut self,
        temperature_celsius: f64,
        settings: MiningThermalSettings,
    ) -> Result<(), &'static str> {
        if !temperature_celsius.is_finite() || temperature_celsius > settings.rearm_celsius() {
            return Err("miner_temperature_still_too_high");
        }
        self.last_temperature_celsius = Some(temperature_celsius);
        self.latched = false;
        Ok(())
    }

    fn snapshot(&self, settings: MiningThermalSettings) -> MiningThermalSafetySnapshot {
        MiningThermalSafetySnapshot {
            latched: self.latched,
            last_temperature_celsius: self.last_temperature_celsius,
            warning_celsius: THERMAL_WARNING_CELSIUS,
            stop_celsius: f64::from(settings.stop_celsius),
            rearm_celsius: settings.rearm_celsius(),
            quarantine_celsius: THERMAL_QUARANTINE_CELSIUS,
            customized: settings.stop_celsius != DEFAULT_THERMAL_STOP_CELSIUS,
        }
    }
}

#[derive(Debug)]
pub struct MiningThermalSafetyState {
    guard: Mutex<MiningThermalGuard>,
    settings: Mutex<MiningThermalSettings>,
}

impl Default for MiningThermalSafetyState {
    fn default() -> Self {
        let settings = load_settings().unwrap_or_default();
        Self {
            guard: Mutex::new(MiningThermalGuard::default()),
            settings: Mutex::new(settings),
        }
    }
}

impl MiningThermalSafetyState {
    fn settings(&self) -> Result<MiningThermalSettings, &'static str> {
        self.settings
            .lock()
            .map_err(|_| "mining_thermal_settings_unavailable")
            .map(|settings| *settings)
    }

    pub fn observe(&self, temperature_celsius: f64) -> Result<bool, &'static str> {
        let settings = self.settings()?;
        self.guard
            .lock()
            .map_err(|_| "mining_thermal_guard_unavailable")
            .map(|mut guard| guard.observe(temperature_celsius, settings))
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
        let settings = self.settings()?;
        self.guard
            .lock()
            .map_err(|_| "mining_thermal_guard_unavailable")?
            .acknowledge(temperature_celsius, settings)
    }

    pub fn set_stop_celsius(&self, stop_celsius: u16) -> Result<(), &'static str> {
        let settings = MiningThermalSettings { stop_celsius }.validate()?;
        save_settings(settings)?;
        *self
            .settings
            .lock()
            .map_err(|_| "mining_thermal_settings_unavailable")? = settings;
        Ok(())
    }

    pub fn snapshot(&self) -> Result<MiningThermalSafetySnapshot, &'static str> {
        let settings = self.settings()?;
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
                    .observe(temperature, settings);
            }
        }
        self.guard
            .lock()
            .map_err(|_| "mining_thermal_guard_unavailable")
            .map(|guard| guard.snapshot(settings))
    }
}

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

fn settings_path() -> Result<PathBuf, &'static str> {
    if let Some(path) = std::env::var_os("GPUBNB_DATA_DIR").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path).join(SETTINGS_FILE_NAME));
    }

    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA").or_else(|| std::env::var_os("APPDATA"));
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|path| path.join("Library").join("Application Support"))
        .map(|path| path.into_os_string());
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_STATE_HOME").or_else(|| {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|path| path.join(".local").join("state"))
            .map(|path| path.into_os_string())
    });

    base.map(PathBuf::from)
        .map(|path| path.join("GPUbnb").join("Host").join(SETTINGS_FILE_NAME))
        .ok_or("gpubnb_data_directory_unavailable")
}

fn load_settings() -> Result<MiningThermalSettings, &'static str> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(MiningThermalSettings::default());
    }
    let content = fs::read_to_string(path).map_err(|_| "mining_thermal_settings_read_failed")?;
    serde_json::from_str::<MiningThermalSettings>(&content)
        .map_err(|_| "mining_thermal_settings_decode_failed")?
        .validate()
}

fn save_settings(settings: MiningThermalSettings) -> Result<(), &'static str> {
    let settings = settings.validate()?;
    let path = settings_path()?;
    let parent = path.parent().ok_or("mining_thermal_settings_parent_missing")?;
    fs::create_dir_all(parent).map_err(|_| "mining_thermal_settings_directory_failed")?;
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let backup = path.with_extension("bak");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| "mining_thermal_settings_temp_open_failed")?;
    let content =
        serde_json::to_vec_pretty(&settings).map_err(|_| "mining_thermal_settings_encode_failed")?;
    file.write_all(&content)
        .map_err(|_| "mining_thermal_settings_write_failed")?;
    file.sync_all()
        .map_err(|_| "mining_thermal_settings_sync_failed")?;
    drop(file);

    if backup.exists() {
        fs::remove_file(&backup).map_err(|_| "mining_thermal_settings_backup_cleanup_failed")?;
    }
    if path.exists() {
        fs::rename(&path, &backup).map_err(|_| "mining_thermal_settings_backup_failed")?;
    }
    if fs::rename(&temporary, &path).is_err() {
        if backup.exists() {
            let _ = fs::rename(&backup, &path);
        }
        let _ = fs::remove_file(&temporary);
        return Err("mining_thermal_settings_commit_failed");
    }
    if backup.exists() {
        fs::remove_file(&backup).map_err(|_| "mining_thermal_settings_backup_cleanup_failed")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_conservative_and_custom_range_is_bounded() {
        let settings = MiningThermalSettings::default();
        assert_eq!(settings.stop_celsius, 85);
        assert_eq!(settings.rearm_celsius(), 75.0);
        assert_eq!(
            MiningThermalSettings { stop_celsius: 84 }.validate(),
            Err("mining_thermal_stop_out_of_range")
        );
        assert!(MiningThermalSettings { stop_celsius: 98 }.validate().is_ok());
        assert_eq!(
            MiningThermalSettings { stop_celsius: 99 }.validate(),
            Err("mining_thermal_stop_out_of_range")
        );
    }

    #[test]
    fn customized_limit_stops_exactly_at_owner_selected_temperature() {
        let mut guard = MiningThermalGuard::default();
        let settings = MiningThermalSettings { stop_celsius: 92 };
        assert!(!guard.observe(91.9, settings));
        assert!(guard.observe(92.0, settings));
        assert!(guard.latched);
    }

    #[test]
    fn customized_mode_rearms_only_after_real_cooldown() {
        let mut guard = MiningThermalGuard::default();
        let settings = MiningThermalSettings { stop_celsius: 98 };
        assert!(guard.observe(98.0, settings));
        assert!(guard.latched);
        assert!(!guard.observe(80.0, settings));
        assert!(!guard.latched);
    }

    #[test]
    fn snapshot_exposes_user_choice_and_fixed_quarantine_boundary() {
        let mut guard = MiningThermalGuard::default();
        let settings = MiningThermalSettings { stop_celsius: 94 };
        guard.observe(90.0, settings);
        let snapshot = guard.snapshot(settings);
        assert_eq!(snapshot.warning_celsius, 85.0);
        assert_eq!(snapshot.stop_celsius, 94.0);
        assert_eq!(snapshot.rearm_celsius, 80.0);
        assert_eq!(snapshot.quarantine_celsius, 98.0);
        assert!(snapshot.customized);
    }

    #[test]
    fn rejects_non_finite_sensor_values() {
        let mut guard = MiningThermalGuard::default();
        let settings = MiningThermalSettings::default();
        assert!(!guard.observe(f64::NAN, settings));
        assert_eq!(
            guard.acknowledge(f64::INFINITY, settings),
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
