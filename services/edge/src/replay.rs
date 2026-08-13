use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use gpubnb_edge_core::SessionBinding;

const MAX_MARKER_BYTES: u64 = 32;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReplayError {
    AlreadyConsumed,
    Capacity,
    Persistence,
}

#[derive(Debug)]
pub struct ReplayStore {
    capacity: usize,
    root: PathBuf,
    directory: File,
    consumed_until_ms: HashMap<String, u64>,
    quarantined_markers: usize,
}

impl ReplayStore {
    pub fn open(root: impl AsRef<Path>, capacity: usize, now_ms: u64) -> Result<Self> {
        if capacity == 0 {
            bail!("replay-store capacity must be positive");
        }
        let root = root.as_ref().to_path_buf();
        let metadata = fs::metadata(&root)
            .with_context(|| format!("replay-store directory {} is unavailable", root.display()))?;
        if !metadata.is_dir() {
            bail!("replay-store path {} is not a directory", root.display());
        }
        let directory = File::open(&root)
            .with_context(|| format!("failed to open replay-store directory {}", root.display()))?;

        let mut store = Self {
            capacity,
            root,
            directory,
            consumed_until_ms: HashMap::new(),
            quarantined_markers: 0,
        };
        store.load(now_ms)?;
        Ok(store)
    }

    pub fn len(&self) -> usize {
        self.consumed_until_ms.len()
    }

    pub fn quarantined_markers(&self) -> usize {
        self.quarantined_markers
    }

    pub fn consume(&mut self, binding: &SessionBinding, now_ms: u64) -> Result<(), ReplayError> {
        if self.purge_expired(now_ms).is_err() {
            return Err(ReplayError::Persistence);
        }

        if self.consumed_until_ms.contains_key(&binding.nonce) {
            return Err(ReplayError::AlreadyConsumed);
        }
        if self.consumed_until_ms.len() >= self.capacity {
            return Err(ReplayError::Capacity);
        }
        if !valid_nonce(&binding.nonce) {
            return Err(ReplayError::Persistence);
        }

        let marker_path = self.root.join(&binding.nonce);
        let mut marker = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker_path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                return Err(ReplayError::AlreadyConsumed);
            }
            Err(_) => return Err(ReplayError::Persistence),
        };

        let record = format!("{}\n", binding.expires_at_ms);
        if marker.write_all(record.as_bytes()).is_err()
            || marker.sync_all().is_err()
            || self.directory.sync_all().is_err()
        {
            // Never remove an uncertain marker here. Its existence keeps the
            // authority fail-closed after a partial write or sync failure.
            return Err(ReplayError::Persistence);
        }

        self.consumed_until_ms
            .insert(binding.nonce.clone(), binding.expires_at_ms);
        Ok(())
    }

    fn load(&mut self, now_ms: u64) -> Result<()> {
        let mut removed_any = false;
        for entry in fs::read_dir(&self.root)
            .with_context(|| format!("failed to scan replay-store {}", self.root.display()))?
        {
            let entry = entry.context("failed to read replay-store directory entry")?;
            let file_type = entry
                .file_type()
                .context("failed to inspect replay-store entry type")?;
            if !file_type.is_file() {
                bail!(
                    "replay-store contains non-file entry {}",
                    entry.path().display()
                );
            }

            let nonce = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("replay-store contains a non-UTF-8 marker name"))?;
            if !valid_nonce(&nonce) {
                bail!("replay-store contains invalid marker name");
            }

            let marker_metadata = entry
                .metadata()
                .context("failed to inspect replay-store marker metadata")?;
            if marker_metadata.len() > MAX_MARKER_BYTES {
                self.insert_quarantined(nonce)?;
                continue;
            }

            let mut raw = String::new();
            match File::open(entry.path()).and_then(|mut file| file.read_to_string(&mut raw)) {
                Ok(_) => {}
                Err(_) => {
                    self.insert_quarantined(nonce)?;
                    continue;
                }
            }
            let expires_at_ms = match raw.trim().parse::<u64>() {
                Ok(value) => value,
                Err(_) => {
                    self.insert_quarantined(nonce)?;
                    continue;
                }
            };

            if expires_at_ms <= now_ms {
                fs::remove_file(entry.path())
                    .context("failed to remove expired replay-store marker")?;
                removed_any = true;
                continue;
            }
            self.insert_live(nonce, expires_at_ms)?;
        }

        if removed_any {
            self.directory
                .sync_all()
                .context("failed to synchronize replay-store cleanup")?;
        }
        Ok(())
    }

    fn insert_live(&mut self, nonce: String, expires_at_ms: u64) -> Result<()> {
        if self.consumed_until_ms.len() >= self.capacity {
            bail!("replay-store live marker capacity exceeded");
        }
        self.consumed_until_ms.insert(nonce, expires_at_ms);
        Ok(())
    }

    fn insert_quarantined(&mut self, nonce: String) -> Result<()> {
        self.insert_live(nonce, u64::MAX)?;
        self.quarantined_markers += 1;
        Ok(())
    }

    fn purge_expired(&mut self, now_ms: u64) -> Result<()> {
        let expired: Vec<String> = self
            .consumed_until_ms
            .iter()
            .filter_map(|(nonce, expires_at_ms)| (*expires_at_ms <= now_ms).then(|| nonce.clone()))
            .collect();
        if expired.is_empty() {
            return Ok(());
        }

        for nonce in &expired {
            match fs::remove_file(self.root.join(nonce)) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error).context("failed to remove expired replay marker"),
            }
        }
        self.directory
            .sync_all()
            .context("failed to synchronize replay-store cleanup")?;
        for nonce in expired {
            self.consumed_until_ms.remove(&nonce);
        }
        Ok(())
    }
}

fn valid_nonce(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use std::{
        env, process,
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc,
        },
    };

    use super::*;
    use tokio::sync::Mutex;

    static NEXT_DIR: AtomicU64 = AtomicU64::new(1);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(name: &str) -> Self {
            let path = env::temp_dir().join(format!(
                "gpubnb-edge-replay-{name}-{}-{}",
                process::id(),
                NEXT_DIR.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn binding(session: &str, nonce: &str, expires_at_ms: u64) -> SessionBinding {
        SessionBinding {
            protocol_version: 1,
            session_id: session.into(),
            machine_id: "machine_1".into(),
            booking_id: "booking_1".into(),
            renter_user_id: "user_1".into(),
            issued_at_ms: 1_000,
            expires_at_ms,
            nonce: nonce.into(),
        }
    }

    #[test]
    fn authority_is_accepted_once_then_rejected() {
        let dir = TestDir::new("once");
        let mut store = ReplayStore::open(&dir.0, 4, 1_100).unwrap();
        let authority = binding(
            "session_1",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            2_000,
        );

        assert_eq!(store.consume(&authority, 1_100), Ok(()));
        assert_eq!(
            store.consume(&authority, 1_200),
            Err(ReplayError::AlreadyConsumed)
        );
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn consumed_authority_survives_process_restart() {
        let dir = TestDir::new("restart");
        let authority = binding(
            "session_1",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            2_000,
        );
        {
            let mut store = ReplayStore::open(&dir.0, 4, 1_100).unwrap();
            assert_eq!(store.consume(&authority, 1_100), Ok(()));
        }

        let mut restarted = ReplayStore::open(&dir.0, 4, 1_200).unwrap();
        assert_eq!(
            restarted.consume(&authority, 1_200),
            Err(ReplayError::AlreadyConsumed)
        );
    }

    #[test]
    fn expired_entries_are_reclaimed_on_restart() {
        let dir = TestDir::new("expiry");
        let first = binding(
            "session_1",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            2_000,
        );
        {
            let mut store = ReplayStore::open(&dir.0, 1, 1_100).unwrap();
            assert_eq!(store.consume(&first, 1_100), Ok(()));
        }

        let restarted = ReplayStore::open(&dir.0, 1, 2_000).unwrap();
        assert_eq!(restarted.len(), 0);
        assert!(!dir.0.join(&first.nonce).exists());
    }

    #[test]
    fn live_capacity_pressure_fails_closed() {
        let dir = TestDir::new("capacity");
        let mut store = ReplayStore::open(&dir.0, 1, 1_100).unwrap();
        let first = binding(
            "session_1",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            3_000,
        );
        let second = binding(
            "session_2",
            "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
            3_000,
        );

        assert_eq!(store.consume(&first, 1_100), Ok(()));
        assert_eq!(store.consume(&second, 1_100), Err(ReplayError::Capacity));
    }

    #[test]
    fn corrupt_marker_is_quarantined_instead_of_reopening_replay_window() {
        let dir = TestDir::new("corrupt");
        let nonce = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        fs::write(dir.0.join(nonce), b"partial").unwrap();

        let mut store = ReplayStore::open(&dir.0, 4, 1_100).unwrap();
        assert_eq!(store.quarantined_markers(), 1);
        assert_eq!(
            store.consume(&binding("session_1", nonce, 2_000), 1_100),
            Err(ReplayError::AlreadyConsumed)
        );
    }

    #[tokio::test]
    async fn concurrent_duplicate_presentation_can_only_win_once() {
        let dir = TestDir::new("concurrent");
        let store = Arc::new(Mutex::new(ReplayStore::open(&dir.0, 4, 1_100).unwrap()));
        let authority = Arc::new(binding(
            "session_1",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            3_000,
        ));

        let mut tasks = Vec::new();
        for _ in 0..2 {
            let store = Arc::clone(&store);
            let authority = Arc::clone(&authority);
            tasks.push(tokio::spawn(async move {
                store.lock().await.consume(&authority, 1_100)
            }));
        }

        let first = tasks.remove(0).await.unwrap();
        let second = tasks.remove(0).await.unwrap();
        let outcomes = [first, second];
        assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter(|result| **result == Err(ReplayError::AlreadyConsumed))
                .count(),
            1
        );
    }
}
