use std::collections::HashMap;

use gpubnb_edge_core::SessionBinding;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReplayError {
    AlreadyConsumed,
    Capacity,
}

#[derive(Debug)]
pub struct ReplayCache {
    capacity: usize,
    consumed_until_ms: HashMap<String, u64>,
}

impl ReplayCache {
    pub fn new(capacity: usize) -> Self {
        debug_assert!(capacity > 0);
        Self {
            capacity,
            consumed_until_ms: HashMap::new(),
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.consumed_until_ms.len()
    }

    pub fn consume(&mut self, binding: &SessionBinding, now_ms: u64) -> Result<(), ReplayError> {
        self.purge_expired(now_ms);

        if self.consumed_until_ms.contains_key(&binding.nonce) {
            return Err(ReplayError::AlreadyConsumed);
        }
        if self.consumed_until_ms.len() >= self.capacity {
            return Err(ReplayError::Capacity);
        }

        self.consumed_until_ms
            .insert(binding.nonce.clone(), binding.expires_at_ms);
        Ok(())
    }

    fn purge_expired(&mut self, now_ms: u64) {
        self.consumed_until_ms
            .retain(|_, expires_at_ms| *expires_at_ms > now_ms);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use tokio::sync::Mutex;

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
        let mut cache = ReplayCache::new(4);
        let authority = binding(
            "session_1",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            2_000,
        );

        assert_eq!(cache.consume(&authority, 1_100), Ok(()));
        assert_eq!(
            cache.consume(&authority, 1_200),
            Err(ReplayError::AlreadyConsumed)
        );
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn expired_entries_are_reclaimed_before_capacity_check() {
        let mut cache = ReplayCache::new(1);
        let first = binding(
            "session_1",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            2_000,
        );
        let second = binding(
            "session_2",
            "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
            3_000,
        );

        assert_eq!(cache.consume(&first, 1_100), Ok(()));
        assert_eq!(cache.consume(&second, 2_000), Ok(()));
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn live_capacity_pressure_fails_closed() {
        let mut cache = ReplayCache::new(1);
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

        assert_eq!(cache.consume(&first, 1_100), Ok(()));
        assert_eq!(cache.consume(&second, 1_100), Err(ReplayError::Capacity));
    }

    #[tokio::test]
    async fn concurrent_duplicate_presentation_can_only_win_once() {
        let cache = Arc::new(Mutex::new(ReplayCache::new(4)));
        let authority = Arc::new(binding(
            "session_1",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            3_000,
        ));

        let mut tasks = Vec::new();
        for _ in 0..2 {
            let cache = Arc::clone(&cache);
            let authority = Arc::clone(&authority);
            tasks.push(tokio::spawn(async move {
                cache.lock().await.consume(&authority, 1_100)
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
