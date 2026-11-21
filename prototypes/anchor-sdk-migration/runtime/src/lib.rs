//! In-memory, synthetic SBF qualification. No RPC, deployment or user keys.
//! Both GPUBNB_SBF_PROGRAM and its expected SHA256 are mandatory.
#[cfg(test)]
mod tests {
    use anchor_lang::prelude::Pubkey;
    use anchor_lang::{AccountDeserialize, Discriminator, InstructionData, ToAccountMetas};
    use gpu_escrow::{accounts, instruction, Config, Escrow};
    use litesvm::LiteSVM;
    use sha2::{Digest, Sha256};
    use solana_account::Account;
    use solana_address::Address;
    use solana_clock::Clock;
    use solana_instruction::{AccountMeta, Instruction};
    use solana_keypair::Keypair;
    use solana_message::Message;
    use solana_signer::Signer;
    use solana_transaction::Transaction;

    fn key(a: Address) -> Pubkey {
        Pubkey::new_from_array(a.to_bytes())
    }
    fn address(k: Pubkey) -> Address {
        Address::new_from_array(k.to_bytes())
    }
    fn ix<A: ToAccountMetas, D: InstructionData>(a: A, data: D) -> Instruction {
        Instruction {
            program_id: address(gpu_escrow::ID),
            accounts: a
                .to_account_metas(None)
                .into_iter()
                .map(|m| AccountMeta {
                    pubkey: address(m.pubkey),
                    is_signer: m.is_signer,
                    is_writable: m.is_writable,
                })
                .collect(),
            data: data.data(),
        }
    }

    struct Lab {
        svm: LiteSVM,
        admin: Keypair,
        buyer: Keypair,
        oracle: Keypair,
        stranger: Keypair,
        provider: Pubkey,
        platform: Pubkey,
        config: Pubkey,
    }
    impl Lab {
        fn new() -> Self {
            // Standard builtins, LiteSVM's pinned mainnet-feature snapshot,
            // ordinary transaction signatures and blockhash checks are retained.
            // GPUbnb never calls the optional ed25519/secp256k1 precompiles;
            // this profile makes no claim to qualify those extensions.
            // This is an in-memory profile and makes no connection to any network.
            let mut svm = LiteSVM::new();
            assert!(
                svm.get_sigverify(),
                "signature verification must stay enabled"
            );
            let path = std::env::var("GPUBNB_SBF_PROGRAM").expect("exact SBF ELF required");
            let expected = std::env::var("GPUBNB_SBF_SHA256").expect("exact SBF SHA256 required");
            assert_eq!(expected.len(), 64);
            let binary = std::fs::read(&path).expect("read the real SBF ELF");
            let actual = format!("{:x}", Sha256::digest(&binary));
            assert_eq!(
                actual, expected,
                "loaded ELF differs from qualification receipt"
            );
            svm.add_program(address(gpu_escrow::ID), &binary)
                .expect("load the real SBF ELF");
            println!(
                "SBF_ELF_SHA256={actual} bytes={} sigverify=true precompiles=NOT_QUALIFIED",
                binary.len()
            );
            let admin = Keypair::new();
            let buyer = Keypair::new();
            let oracle = Keypair::new();
            let stranger = Keypair::new();
            let provider = key(Address::new_unique());
            let platform = key(Address::new_unique());
            for a in [
                admin.pubkey(),
                buyer.pubkey(),
                oracle.pubkey(),
                stranger.pubkey(),
                address(provider),
                address(platform),
            ] {
                svm.airdrop(&a, 2_000_000_000).unwrap();
            }
            let config = Pubkey::find_program_address(&[b"config"], &gpu_escrow::ID).0;
            let mut l = Self {
                svm,
                admin,
                buyer,
                oracle,
                stranger,
                provider,
                platform,
                config,
            };
            let initialize = ix(
                accounts::InitializeConfig {
                    admin: key(l.admin.pubkey()),
                    config,
                    system_program: Pubkey::default(),
                },
                instruction::InitializeConfig {
                    platform,
                    oracle: key(l.oracle.pubkey()),
                },
            );
            l.submit(initialize, 0).unwrap();
            let c = l.config_data();
            assert_eq!(c.admin, key(l.admin.pubkey()));
            assert_eq!(c.platform, platform);
            assert!(!c.paused);
            let a = l.svm.get_account(&address(config)).unwrap();
            assert_eq!(a.data.len(), 138);
            assert_eq!(
                a.lamports,
                l.svm.minimum_balance_for_rent_exemption(a.data.len())
            );
            l
        }
        fn signer(&self, signer: u8) -> &Keypair {
            match signer {
                0 => &self.admin,
                1 => &self.buyer,
                2 => &self.oracle,
                _ => &self.stranger,
            }
        }
        fn submit(&mut self, instruction: Instruction, signer: u8) -> Result<(), String> {
            let cpi_count = if instruction
                .data
                .starts_with(instruction::Open::DISCRIMINATOR)
            {
                2
            } else if instruction
                .data
                .starts_with(instruction::InitializeConfig::DISCRIMINATOR)
            {
                1
            } else {
                0
            };
            self.svm.expire_blockhash();
            let signer = self.signer(signer);
            let message = Message::new(&[instruction], Some(&signer.pubkey()));
            let tx = Transaction::new(&[signer], message, self.svm.latest_blockhash());
            self.svm
                .send_transaction(tx)
                .map(|metadata| {
                    if cpi_count > 0 {
                        assert!(metadata.compute_units_consumed > 0);
                        assert!(
                            metadata
                                .logs
                                .iter()
                                .filter(|s| s.as_str()
                                    == "Program 11111111111111111111111111111111 invoke [2]")
                                .count()
                                >= cpi_count
                        );
                        assert!(
                            metadata
                                .logs
                                .iter()
                                .filter(|s| s.as_str()
                                    == "Program 11111111111111111111111111111111 success")
                                .count()
                                >= cpi_count
                        );
                        println!(
                            "SBF_SYSTEM_CPI_PASS minimum_invocations={cpi_count} compute_units={}",
                            metadata.compute_units_consumed
                        );
                        for line in metadata.logs {
                            println!("SBF_CPI_LOG={line}");
                        }
                    }
                })
                .map_err(|e| format!("{e:?}"))
        }
        fn snapshot(&self, escrow: Pubkey) -> Vec<(Address, Option<Account>)> {
            [
                self.admin.pubkey(),
                self.buyer.pubkey(),
                self.oracle.pubkey(),
                self.stranger.pubkey(),
                address(self.provider),
                address(self.platform),
                address(self.config),
                address(escrow),
            ]
            .into_iter()
            .map(|a| (a, self.svm.get_account(&a)))
            .collect()
        }
        fn unchanged(&self, mut before: Vec<(Address, Option<Account>)>, payer: Address, fee: u64) {
            for (a, account) in &mut before {
                if *a == payer {
                    account.as_mut().unwrap().lamports -= fee;
                }
                assert_eq!(
                    self.svm.get_account(a),
                    *account,
                    "refused transaction mutated {a} beyond its fee"
                );
            }
        }
        fn deny(&mut self, instruction: Instruction, signer: u8, escrow: Pubkey, code: &str) {
            let before = self.snapshot(escrow);
            let payer = self.signer(signer).pubkey();
            let error = self.submit(instruction, signer).unwrap_err();
            assert!(error.contains(code), "expected {code}, got {error}");
            self.unchanged(before, payer, 5_000);
        }
        fn now(&self) -> i64 {
            self.svm.get_sysvar::<Clock>().unix_timestamp
        }
        fn advance(&mut self, seconds: i64) {
            let mut clock = self.svm.get_sysvar::<Clock>();
            clock.unix_timestamp += seconds;
            clock.slot += 1;
            self.svm.set_sysvar(&clock);
        }
        fn config_data(&self) -> Config {
            let a = self.svm.get_account(&address(self.config)).unwrap();
            Config::try_deserialize(&mut a.data.as_slice()).unwrap()
        }
        fn escrow_data(&self, escrow: Pubkey) -> Escrow {
            let a = self.svm.get_account(&address(escrow)).unwrap();
            Escrow::try_deserialize(&mut a.data.as_slice()).unwrap()
        }
        fn escrow(&self, id: u8) -> Pubkey {
            Pubkey::find_program_address(&[b"escrow", &[id; 32]], &gpu_escrow::ID).0
        }
        fn open_instruction(&self, id: u8, amount: u64) -> Instruction {
            ix(
                accounts::Open {
                    config: self.config,
                    buyer: key(self.buyer.pubkey()),
                    provider: self.provider,
                    escrow: self.escrow(id),
                    system_program: Pubkey::default(),
                },
                instruction::Open {
                    booking: [id; 32],
                    amount,
                    expected_seconds: 1_000,
                    expires_at: self.now() + 100,
                },
            )
        }
        fn open(&mut self, id: u8, amount: u64) -> Pubkey {
            self.submit(self.open_instruction(id, amount), 1).unwrap();
            let escrow = self.escrow(id);
            let a = self.svm.get_account(&address(escrow)).unwrap();
            assert_eq!(a.owner, address(gpu_escrow::ID));
            assert_eq!(a.data.len(), 138);
            assert_eq!(
                a.lamports,
                amount + self.svm.minimum_balance_for_rent_exemption(a.data.len())
            );
            let e = self.escrow_data(escrow);
            assert_eq!(e.amount, amount);
            assert_eq!(e.state, 0);
            assert_eq!(e.buyer, key(self.buyer.pubkey()));
            assert_eq!(e.provider, self.provider);
            escrow
        }
        fn propose(&mut self, escrow: Pubkey, valid_seconds: u32) {
            let i = ix(
                accounts::ProposeSettlement {
                    config: self.config,
                    oracle: key(self.oracle.pubkey()),
                    escrow,
                },
                instruction::ProposeSettlement { valid_seconds },
            );
            self.submit(i, 2).unwrap();
            let e = self.escrow_data(escrow);
            assert_eq!(e.state, 1);
            assert_eq!(e.valid_seconds, valid_seconds);
            assert_eq!(e.settle_after, self.now() + 3_600);
        }
        fn finalize(&self, escrow: Pubkey) -> Instruction {
            ix(
                accounts::Finalize {
                    config: self.config,
                    escrow,
                    buyer: key(self.buyer.pubkey()),
                    provider: self.provider,
                    platform: self.platform,
                },
                instruction::Finalize {},
            )
        }
        fn refund(&self, escrow: Pubkey, buyer: Pubkey) -> Instruction {
            ix(
                accounts::RefundExpired { escrow, buyer },
                instruction::RefundExpired {},
            )
        }
        fn lamports(&self, k: Pubkey) -> u64 {
            self.svm.get_account(&address(k)).map_or(0, |a| a.lamports)
        }
    }

    #[test]
    fn real_sbf_funding_cpi_refund_and_refusals_preserve_all_accounts() {
        let mut l = Lab::new();
        let escrow = l.escrow(1);
        let buyer = key(l.buyer.pubkey());
        let buyer_before = l.lamports(buyer);
        l.open(1, 1_000_000);
        let principal_and_rent = l.lamports(escrow);
        assert_eq!(buyer_before - l.lamports(buyer), principal_and_rent + 5_000);
        l.deny(l.refund(escrow, buyer), 3, escrow, "Custom(6004)");
        l.deny(
            l.refund(escrow, key(l.stranger.pubkey())),
            3,
            escrow,
            "Custom(2001)",
        );
        l.advance(101);
        let before = l.lamports(buyer);
        l.submit(l.refund(escrow, buyer), 3).unwrap();
        assert_eq!(l.lamports(buyer) - before, principal_and_rent);
        assert_eq!(l.lamports(escrow), 0);
        l.deny(l.refund(escrow, buyer), 3, escrow, "Custom(3012)");
        println!("SBF_CASE_PASS=funding_cpi_refund_and_repeated_instruction_after_close");
    }
    #[test]
    fn real_sbf_full_and_partial_settlements_conserve_principal_and_rent() {
        for (id, valid, provider_pay, platform_pay, refund) in [
            (2, 900, 950_000, 50_000, 0),
            (3, 500, 475_000, 25_000, 500_000),
        ] {
            let mut l = Lab::new();
            let escrow = l.open(id, 1_000_000);
            let rent = l.svm.minimum_balance_for_rent_exemption(138);
            l.propose(escrow, valid);
            l.deny(l.finalize(escrow), 3, escrow, "Custom(6004)");
            l.advance(3_601);
            let before = [
                l.lamports(l.provider),
                l.lamports(l.platform),
                l.lamports(key(l.buyer.pubkey())),
            ];
            l.submit(l.finalize(escrow), 3).unwrap();
            assert_eq!(l.lamports(l.provider) - before[0], provider_pay);
            assert_eq!(l.lamports(l.platform) - before[1], platform_pay);
            assert_eq!(l.lamports(key(l.buyer.pubkey())) - before[2], refund + rent);
            assert_eq!(l.lamports(escrow), 0);
            l.deny(l.finalize(escrow), 3, escrow, "Custom(3012)");
        }
        println!("SBF_CASE_PASS=full_partial_settlements_and_repeated_instruction_after_close");
    }
    #[test]
    fn real_sbf_dispute_authority_and_pause_fail_closed() {
        let mut l = Lab::new();
        let escrow = l.escrow(4);
        let pause = ix(
            accounts::AdminConfig {
                admin: key(l.admin.pubkey()),
                config: l.config,
            },
            instruction::SetPaused { paused: true },
        );
        l.submit(pause, 0).unwrap();
        l.deny(l.open_instruction(4, 1_000_000), 1, escrow, "Custom(6000)");
        let resume = ix(
            accounts::AdminConfig {
                admin: key(l.admin.pubkey()),
                config: l.config,
            },
            instruction::SetPaused { paused: false },
        );
        l.submit(resume, 0).unwrap();
        l.open(4, 1_000_000);
        let rent = l.svm.minimum_balance_for_rent_exemption(138);
        l.propose(escrow, 500);
        let dispute = ix(
            accounts::Dispute {
                buyer: key(l.buyer.pubkey()),
                escrow,
            },
            instruction::Dispute {},
        );
        l.submit(dispute, 1).unwrap();
        assert_eq!(l.escrow_data(escrow).state, 2);
        let wrong = ix(
            accounts::ResolveDispute {
                config: l.config,
                admin: key(l.stranger.pubkey()),
                escrow,
                buyer: key(l.buyer.pubkey()),
                provider: l.provider,
                platform: l.platform,
            },
            instruction::ResolveDispute { valid_seconds: 700 },
        );
        l.deny(wrong, 3, escrow, "Custom(2001)");
        let before = [
            l.lamports(l.provider),
            l.lamports(l.platform),
            l.lamports(key(l.buyer.pubkey())),
        ];
        let resolve = ix(
            accounts::ResolveDispute {
                config: l.config,
                admin: key(l.admin.pubkey()),
                escrow,
                buyer: key(l.buyer.pubkey()),
                provider: l.provider,
                platform: l.platform,
            },
            instruction::ResolveDispute { valid_seconds: 700 },
        );
        l.submit(resolve, 0).unwrap();
        assert_eq!(l.lamports(l.provider) - before[0], 665_000);
        assert_eq!(l.lamports(l.platform) - before[1], 35_000);
        assert_eq!(
            l.lamports(key(l.buyer.pubkey())) - before[2],
            300_000 + rent
        );
        assert_eq!(l.lamports(escrow), 0);
        println!("SBF_CASE_PASS=dispute_authority_pause_and_conservation");
    }
    #[test]
    fn real_sbf_admin_transfer_and_config_update_preserve_authority() {
        let mut l = Lab::new();
        let escrow = l.escrow(5);
        let propose = ix(
            accounts::AdminConfig {
                admin: key(l.admin.pubkey()),
                config: l.config,
            },
            instruction::ProposeAdmin {
                pending_admin: key(l.stranger.pubkey()),
            },
        );
        l.submit(propose, 0).unwrap();
        assert_eq!(l.config_data().pending_admin, key(l.stranger.pubkey()));
        let wrong = ix(
            accounts::AcceptAdmin {
                pending_admin: key(l.buyer.pubkey()),
                config: l.config,
            },
            instruction::AcceptAdmin {},
        );
        l.deny(wrong, 1, escrow, "Custom(6009)");
        let accept = ix(
            accounts::AcceptAdmin {
                pending_admin: key(l.stranger.pubkey()),
                config: l.config,
            },
            instruction::AcceptAdmin {},
        );
        l.submit(accept, 3).unwrap();
        assert_eq!(l.config_data().admin, key(l.stranger.pubkey()));
        assert_eq!(l.config_data().pending_admin, Pubkey::default());
        let old = ix(
            accounts::AdminConfig {
                admin: key(l.admin.pubkey()),
                config: l.config,
            },
            instruction::UpdateConfig {
                platform: l.platform,
                oracle: key(l.oracle.pubkey()),
            },
        );
        l.deny(old, 0, escrow, "Custom(2001)");
        let platform = key(Address::new_unique());
        let oracle = key(l.buyer.pubkey());
        let update = ix(
            accounts::AdminConfig {
                admin: key(l.stranger.pubkey()),
                config: l.config,
            },
            instruction::UpdateConfig { platform, oracle },
        );
        l.submit(update, 3).unwrap();
        let c = l.config_data();
        assert_eq!(c.platform, platform);
        assert_eq!(c.oracle, oracle);
        println!("SBF_CASE_PASS=admin_transfer_config_and_authority_refusals");
    }
    #[test]
    fn real_vm_rejects_unsigned_and_expired_blockhash_transactions_without_effects() {
        let mut l = Lab::new();
        let escrow = l.escrow(6);
        let pause = || {
            ix(
                accounts::AdminConfig {
                    admin: key(l.admin.pubkey()),
                    config: l.config,
                },
                instruction::SetPaused { paused: true },
            )
        };
        let before = l.snapshot(escrow);
        let payer = l.admin.pubkey();
        let unsigned = Transaction::new_unsigned(Message::new_with_blockhash(
            &[pause()],
            Some(&payer),
            &l.svm.latest_blockhash(),
        ));
        let error = l.svm.send_transaction(unsigned).unwrap_err();
        assert!(format!("{error:?}").contains("SignatureFailure"));
        l.unchanged(before, payer, 0);
        let old_hash = l.svm.latest_blockhash();
        l.svm.expire_blockhash();
        let instruction = ix(
            accounts::AdminConfig {
                admin: key(l.admin.pubkey()),
                config: l.config,
            },
            instruction::SetPaused { paused: true },
        );
        let tx = Transaction::new(
            &[&l.admin],
            Message::new(&[instruction], Some(&payer)),
            old_hash,
        );
        let before = l.snapshot(escrow);
        let error = l.svm.send_transaction(tx).unwrap_err();
        assert!(format!("{error:?}").contains("BlockhashNotFound"));
        l.unchanged(before, payer, 0);
        assert!(!l.config_data().paused);
        println!("SBF_CASE_PASS=signature_and_blockhash_checks_fail_closed");
    }
    #[test]
    fn real_vm_rejects_the_identical_signed_transaction_as_already_processed() {
        let mut l = Lab::new();
        let escrow = l.escrow(7);
        let payer = l.buyer.pubkey();
        l.svm.expire_blockhash();
        let message = Message::new(&[l.open_instruction(7, 1_000_000)], Some(&payer));
        let tx = Transaction::new(&[&l.buyer], message, l.svm.latest_blockhash());
        l.svm.send_transaction(tx.clone()).unwrap();
        assert_eq!(l.escrow_data(escrow).state, 0);
        let before = l.snapshot(escrow);
        let error = l.svm.send_transaction(tx).unwrap_err();
        assert!(format!("{error:?}").contains("AlreadyProcessed"));
        l.unchanged(before, payer, 0);
        println!("SBF_CASE_PASS=identical_signed_transaction_replay_refused_without_fee");
    }
}
