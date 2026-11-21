//! Candidate-only regressions. Never compile/run an unpatched vulnerable source.

#[cfg(test)]
mod tests {
    use glib::variant::ToVariant;
    use std::collections::VecDeque;

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
