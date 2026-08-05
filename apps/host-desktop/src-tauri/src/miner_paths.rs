use std::fs;
use std::path::PathBuf;

const APPROVED_MINER_DIRECTORY_ENV: &str = "GPUBNB_APPROVED_MINER_DIR";
const DOWNLOAD_DIRECTORY_ENV: &str = "GPUBNB_DOWNLOAD_DIR";

pub fn approved_miner_root() -> Result<PathBuf, &'static str> {
    let configured = std::env::var_os(APPROVED_MINER_DIRECTORY_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let root = match configured {
        Some(root) => root,
        None => default_data_root()?.join("miners").join("xmrig"),
    };
    fs::create_dir_all(&root).map_err(|_| "approved_miner_directory_create_failed")?;
    let root = root
        .canonicalize()
        .map_err(|_| "approved_miner_directory_unavailable")?;
    if !root.is_dir() {
        return Err("approved_miner_directory_invalid");
    }
    Ok(root)
}

pub fn downloads_root() -> Result<PathBuf, &'static str> {
    let configured = std::env::var_os(DOWNLOAD_DIRECTORY_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let root = match configured {
        Some(root) => root,
        None => default_home()?.join("Downloads"),
    };
    let root = root
        .canonicalize()
        .map_err(|_| "downloads_directory_unavailable")?;
    if !root.is_dir() {
        return Err("downloads_directory_invalid");
    }
    Ok(root)
}

fn default_data_root() -> Result<PathBuf, &'static str> {
    if let Some(path) = std::env::var_os("GPUBNB_DATA_DIR").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
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
        .map(|path| path.join("GPUbnb").join("Host"))
        .ok_or("gpubnb_data_directory_unavailable")
}

fn default_home() -> Result<PathBuf, &'static str> {
    #[cfg(target_os = "windows")]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(target_os = "windows"))]
    let home = std::env::var_os("HOME");
    home.filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or("user_home_directory_unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_miner_root_is_never_the_download_directory() {
        if let (Ok(miner), Ok(downloads)) = (approved_miner_root(), downloads_root()) {
            assert_ne!(miner, downloads);
        }
    }
}
