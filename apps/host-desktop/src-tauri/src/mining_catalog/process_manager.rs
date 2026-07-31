use super::secure_launcher::VerifiedMinerBinary;
use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const MAX_ARGUMENTS: usize = 64;
const MAX_ARGUMENT_LENGTH: usize = 2_048;

pub trait ManagedProcess: Send {
    fn id(&self) -> u32;
    fn try_wait(&mut self) -> Result<Option<i32>, &'static str>;
    fn request_stop(&mut self) -> Result<(), &'static str>;
    fn force_stop(&mut self) -> Result<(), &'static str>;
}

pub trait ProcessBackend: Send + Sync {
    fn spawn(
        &self,
        binary: &VerifiedMinerBinary,
        arguments: &[String],
    ) -> Result<Box<dyn ManagedProcess>, &'static str>;
}

#[derive(Default)]
pub struct SystemProcessBackend;

struct SystemManagedProcess {
    child: Child,
}

impl ManagedProcess for SystemManagedProcess {
    fn id(&self) -> u32 {
        self.child.id()
    }

    fn try_wait(&mut self) -> Result<Option<i32>, &'static str> {
        self.child
            .try_wait()
            .map(|status| status.map(|value| value.code().unwrap_or(-1)))
            .map_err(|_| "miner_process_wait_failed")
    }

    fn request_stop(&mut self) -> Result<(), &'static str> {
        self.child
            .kill()
            .map_err(|_| "miner_process_stop_request_failed")
    }

    fn force_stop(&mut self) -> Result<(), &'static str> {
        self.child
            .kill()
            .map_err(|_| "miner_process_force_stop_failed")
    }
}

impl ProcessBackend for SystemProcessBackend {
    fn spawn(
        &self,
        binary: &VerifiedMinerBinary,
        arguments: &[String],
    ) -> Result<Box<dyn ManagedProcess>, &'static str> {
        validate_arguments(arguments)?;
        let child = Command::new(&binary.canonical_path)
            .args(arguments)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "miner_process_spawn_failed")?;
        Ok(Box::new(SystemManagedProcess { child }))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunningMiner {
    pub resource_id: String,
    pub profile_id: String,
    pub process_id: u32,
}

struct ProcessEntry {
    metadata: RunningMiner,
    process: Box<dyn ManagedProcess>,
}

pub struct MinerProcessSupervisor<B: ProcessBackend> {
    backend: B,
    processes: HashMap<String, ProcessEntry>,
}

impl<B: ProcessBackend> MinerProcessSupervisor<B> {
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            processes: HashMap::new(),
        }
    }

    pub fn start(
        &mut self,
        resource_id: &str,
        profile_id: &str,
        binary: &VerifiedMinerBinary,
        arguments: &[String],
    ) -> Result<RunningMiner, &'static str> {
        validate_identifier(resource_id, "invalid_mining_resource_id")?;
        validate_identifier(profile_id, "invalid_mining_profile_id")?;
        validate_arguments(arguments)?;
        self.reap_finished();
        if self.processes.contains_key(resource_id) {
            return Err("miner_process_already_running");
        }

        let process = self.backend.spawn(binary, arguments)?;
        let metadata = RunningMiner {
            resource_id: resource_id.to_owned(),
            profile_id: profile_id.to_owned(),
            process_id: process.id(),
        };
        self.processes.insert(
            resource_id.to_owned(),
            ProcessEntry {
                metadata: metadata.clone(),
                process,
            },
        );
        Ok(metadata)
    }

    pub fn running(&mut self, resource_id: &str) -> Option<RunningMiner> {
        self.reap_finished();
        self.processes
            .get(resource_id)
            .map(|entry| entry.metadata.clone())
    }

    pub fn stop_and_verify(
        &mut self,
        resource_id: &str,
        graceful_timeout: Duration,
        force_timeout: Duration,
    ) -> Result<(), &'static str> {
        let Some(entry) = self.processes.get_mut(resource_id) else {
            return Ok(());
        };

        if entry.process.try_wait()?.is_some() {
            self.processes.remove(resource_id);
            return Ok(());
        }

        entry.process.request_stop()?;
        if wait_until_stopped(entry.process.as_mut(), graceful_timeout)? {
            self.processes.remove(resource_id);
            return Ok(());
        }

        entry.process.force_stop()?;
        if !wait_until_stopped(entry.process.as_mut(), force_timeout)? {
            return Err("miner_process_stop_unverified");
        }
        self.processes.remove(resource_id);
        Ok(())
    }

    pub fn stop_all_and_verify(
        &mut self,
        graceful_timeout: Duration,
        force_timeout: Duration,
    ) -> Result<(), &'static str> {
        let resource_ids: Vec<String> = self.processes.keys().cloned().collect();
        for resource_id in resource_ids {
            self.stop_and_verify(&resource_id, graceful_timeout, force_timeout)?;
        }
        Ok(())
    }

    fn reap_finished(&mut self) {
        self.processes
            .retain(|_, entry| matches!(entry.process.try_wait(), Ok(None) | Err(_)));
    }
}

fn wait_until_stopped(
    process: &mut dyn ManagedProcess,
    timeout: Duration,
) -> Result<bool, &'static str> {
    let deadline = Instant::now() + timeout;
    loop {
        if process.try_wait()?.is_some() {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn validate_identifier(value: &str, error: &'static str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b':'))
    {
        return Err(error);
    }
    Ok(())
}

fn validate_arguments(arguments: &[String]) -> Result<(), &'static str> {
    if arguments.len() > MAX_ARGUMENTS {
        return Err("too_many_miner_arguments");
    }
    for argument in arguments {
        if argument.is_empty()
            || argument.len() > MAX_ARGUMENT_LENGTH
            || argument
                .bytes()
                .any(|byte| byte == 0 || byte == b'\n' || byte == b'\r')
        {
            return Err("invalid_miner_argument");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct FakeState {
        running: bool,
        stop_requests: usize,
        force_requests: usize,
    }

    struct FakeProcess {
        state: Arc<Mutex<FakeState>>,
    }

    impl ManagedProcess for FakeProcess {
        fn id(&self) -> u32 {
            42
        }

        fn try_wait(&mut self) -> Result<Option<i32>, &'static str> {
            let state = self.state.lock().expect("fake state");
            Ok((!state.running).then_some(0))
        }

        fn request_stop(&mut self) -> Result<(), &'static str> {
            let mut state = self.state.lock().expect("fake state");
            state.stop_requests += 1;
            state.running = false;
            Ok(())
        }

        fn force_stop(&mut self) -> Result<(), &'static str> {
            let mut state = self.state.lock().expect("fake state");
            state.force_requests += 1;
            state.running = false;
            Ok(())
        }
    }

    struct FakeBackend {
        state: Arc<Mutex<FakeState>>,
    }

    impl ProcessBackend for FakeBackend {
        fn spawn(
            &self,
            _binary: &VerifiedMinerBinary,
            arguments: &[String],
        ) -> Result<Box<dyn ManagedProcess>, &'static str> {
            validate_arguments(arguments)?;
            self.state.lock().expect("fake state").running = true;
            Ok(Box::new(FakeProcess {
                state: Arc::clone(&self.state),
            }))
        }
    }

    fn verified_binary() -> VerifiedMinerBinary {
        VerifiedMinerBinary {
            canonical_path: PathBuf::from("fake-miner"),
            sha256: "00".repeat(32),
        }
    }

    #[test]
    fn starts_only_one_process_per_resource_and_stops_it() {
        let state = Arc::new(Mutex::new(FakeState::default()));
        let backend = FakeBackend {
            state: Arc::clone(&state),
        };
        let mut supervisor = MinerProcessSupervisor::new(backend);
        let arguments = vec!["--algorithm".to_owned(), "kawpow".to_owned()];
        let running = supervisor
            .start("gpu-0", "trex_rvn_kawpow", &verified_binary(), &arguments)
            .expect("start fake miner");
        assert_eq!(running.process_id, 42);
        assert_eq!(
            supervisor.start("gpu-0", "trex_rvn_kawpow", &verified_binary(), &arguments),
            Err("miner_process_already_running")
        );
        supervisor
            .stop_and_verify("gpu-0", Duration::ZERO, Duration::ZERO)
            .expect("verified stop");
        assert!(supervisor.running("gpu-0").is_none());
        let state = state.lock().expect("fake state");
        assert_eq!(state.stop_requests, 1);
        assert_eq!(state.force_requests, 0);
    }

    #[test]
    fn rejects_unsafe_identifiers_and_arguments() {
        let state = Arc::new(Mutex::new(FakeState::default()));
        let mut supervisor = MinerProcessSupervisor::new(FakeBackend { state });
        assert_eq!(
            supervisor.start(
                "../gpu-0",
                "trex_rvn_kawpow",
                &verified_binary(),
                &["--algorithm".to_owned()]
            ),
            Err("invalid_mining_resource_id")
        );
        assert_eq!(
            supervisor.start(
                "gpu-0",
                "trex_rvn_kawpow",
                &verified_binary(),
                &["secret\nnext-command".to_owned()]
            ),
            Err("invalid_miner_argument")
        );
    }
}
