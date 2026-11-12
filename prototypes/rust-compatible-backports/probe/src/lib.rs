//! Candidate-only regressions. Never compile/run an unpatched vulnerable source.

#[cfg(test)]
mod tests {
    use glib::variant::ToVariant;
    use rand::{RngCore, SeedableRng};
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static CALLBACKS: AtomicUsize = AtomicUsize::new(0);
    struct ReentrantLogger;
    impl log::Log for ReentrantLogger {
        fn enabled(&self, _: &log::Metadata<'_>) -> bool { true }
        fn log(&self, _: &log::Record<'_>) {
            CALLBACKS.fetch_add(1, Ordering::SeqCst);
            let _ = rand::thread_rng().next_u64();
        }
        fn flush(&self) {}
    }
    static LOGGER: ReentrantLogger = ReentrantLogger;

    struct FailingReseeder;
    impl RngCore for FailingReseeder {
        fn next_u32(&mut self) -> u32 { panic!("unexpected reseed API") }
        fn next_u64(&mut self) -> u64 { panic!("unexpected reseed API") }
        fn fill_bytes(&mut self, _: &mut [u8]) { panic!("unexpected reseed API") }
        fn try_fill_bytes(&mut self, _: &mut [u8]) -> Result<(), rand::Error> {
            RESEED_ATTEMPTS.fetch_add(1,Ordering::SeqCst);
            Err(rand::Error::new(std::io::Error::other("synthetic entropy failure")))
        }
    }
    static RESEED_ATTEMPTS: AtomicUsize = AtomicUsize::new(0);

    #[test]
    fn rand_reseed_has_no_logger_callback_on_success_or_failure() {
        log::set_logger(&LOGGER).unwrap();
        log::set_max_level(log::LevelFilter::Trace);
        // Calibration: the logger really invokes ThreadRng outside a borrow.
        log::trace!("calibrate bounded security regression");
        assert_eq!(CALLBACKS.load(Ordering::SeqCst),1);
        let mut rng=rand::thread_rng();
        let mut bytes=[0u8;4096];
        for _ in 0..256 { rng.fill_bytes(&mut bytes); }
        let core=rand_chacha::ChaCha20Core::from_seed([0u8;32]);
        let mut failing=rand::rngs::adapter::ReseedingRng::new(core,32,FailingReseeder);
        failing.fill_bytes(&mut bytes);
        assert!(RESEED_ATTEMPTS.load(Ordering::SeqCst)>0);
        assert_eq!(CALLBACKS.load(Ordering::SeqCst),1);
        println!("RAND_BACKPORT_PASS bytes=1048576 reseed_failure_exercised=true logger_calibrated=true callbacks_during_reseed=0");
    }

    #[test]
    fn rand_chacha20_published_zero_key_known_answer_is_preserved() {
        let mut rng=rand_chacha::ChaCha20Rng::from_seed([0u8;32]);
        let mut got=[0u8;64];rng.fill_bytes(&mut got);
        let expected=[0x76,0xb8,0xe0,0xad,0xa0,0xf1,0x3d,0x90,0x40,0x5d,0x6a,0xe5,0x53,0x86,0xbd,0x28,
            0xbd,0xd2,0x19,0xb8,0xa0,0x8d,0xed,0x1a,0xa8,0x36,0xef,0xcc,0x8b,0x77,0x0d,0xc7,
            0xda,0x41,0x59,0x7c,0x51,0x57,0x48,0x8d,0x77,0x24,0xe0,0x3f,0xb8,0xd8,0x4a,0x37,
            0x6a,0x43,0xb8,0xf4,0x15,0x18,0xa1,0x1c,0xc3,0x87,0xb6,0x69,0xb2,0xee,0x65,0x86];
        assert_eq!(got,expected);
    }

    #[test]
    fn glib_mixed_iterator_values_nth_and_exact_size_match_independent_deque() {
        assert!(!cfg!(debug_assertions),"optimized regression build required");
        let cases=[vec![],vec![""],vec!["one","two","three"],vec!["é","中文","🦀","last"]];
        let mut comparisons=0;
        for expected in &cases {
            let value=expected.to_variant();
            for mask in 0..128 {
                let mut oracle=VecDeque::from(expected.clone());
                let mut iter=value.array_iter_str().unwrap();
                for step in 0..expected.len()+2 {
                    assert_eq!(iter.len(),oracle.len());
                    assert_eq!(iter.size_hint(),(oracle.len(),Some(oracle.len())));
                    if mask & (1<<step)!=0 { assert_eq!(iter.next_back(),oracle.pop_back()); }
                    else { assert_eq!(iter.next(),oracle.pop_front()); }
                    comparisons+=1;
                }
            }
            for index in 0..expected.len()+2 {
                assert_eq!(value.array_iter_str().unwrap().nth(index),expected.get(index).copied());
                assert_eq!(value.array_iter_str().unwrap().nth_back(index),expected.iter().rev().nth(index).copied());
                comparisons+=2;
            }
        }
        assert!(42u64.to_variant().array_iter_str().is_err());
        println!("GLIB_BACKPORT_PASS independent_value_comparisons={comparisons} wrong_type_rejected=true optimized=true");
    }
}
