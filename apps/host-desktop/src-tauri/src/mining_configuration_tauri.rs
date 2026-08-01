use crate::mining_configuration::MiningConfiguration;
use crate::mining_configuration_commands::MiningConfigurationCommands;
use crate::mining_configuration_store::MiningConfigurationView;
use std::sync::Mutex;

#[derive(Debug, Default)]
pub struct MiningConfigurationState {
    commands: Mutex<MiningConfigurationCommands>,
}

impl MiningConfigurationState {
    pub fn get(&self) -> Result<MiningConfigurationView, &'static str> {
        self.commands
            .lock()
            .map_err(|_| "mining_configuration_state_unavailable")?
            .get()
    }

    pub fn save(
        &self,
        expected_revision: u64,
        configuration: MiningConfiguration,
    ) -> Result<MiningConfigurationView, &'static str> {
        self.commands
            .lock()
            .map_err(|_| "mining_configuration_state_unavailable")?
            .save(expected_revision, configuration)
    }

    pub fn test_connection(
        &self,
        expected_revision: u64,
    ) -> Result<MiningConfigurationView, &'static str> {
        let pool_url = {
            let commands = self
                .commands
                .lock()
                .map_err(|_| "mining_configuration_state_unavailable")?;
            let view = commands.get()?;
            if view.revision != expected_revision {
                return Err("mining_configuration_revision_conflict");
            }
            view.configuration
                .and_then(|configuration| configuration.custom_pool_url)
                .ok_or("custom_pool_url_required")?
        };

        self.commands
            .lock()
            .map_err(|_| "mining_configuration_state_unavailable")?
            .test_connection(expected_revision, &pool_url)
    }

    pub fn clear(
        &self,
        expected_revision: u64,
    ) -> Result<MiningConfigurationView, &'static str> {
        self.commands
            .lock()
            .map_err(|_| "mining_configuration_state_unavailable")?
            .clear(expected_revision)
    }

    pub fn require_ready(&self) -> Result<(), &'static str> {
        self.commands
            .lock()
            .map_err(|_| "mining_configuration_state_unavailable")?
            .require_ready()
            .map(|_| ())
    }
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
pub fn mining_configuration_get(
    state: tauri::State<'_, MiningConfigurationState>,
) -> Result<MiningConfigurationView, &'static str> {
    state.get()
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
pub fn mining_configuration_save(
    expected_revision: u64,
    configuration: MiningConfiguration,
    state: tauri::State<'_, MiningConfigurationState>,
) -> Result<MiningConfigurationView, &'static str> {
    state.save(expected_revision, configuration)
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
pub fn mining_configuration_test_connection(
    expected_revision: u64,
    state: tauri::State<'_, MiningConfigurationState>,
) -> Result<MiningConfigurationView, &'static str> {
    state.test_connection(expected_revision)
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
pub fn mining_configuration_clear(
    expected_revision: u64,
    state: tauri::State<'_, MiningConfigurationState>,
) -> Result<MiningConfigurationView, &'static str> {
    state.clear(expected_revision)
}
