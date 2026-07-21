# Multisig Mainnet

Use a deployed Solana multisig vault (for example Squads) as `config.admin`, not a personal wallet.

Required policy:
- at least 3 signers, threshold 2;
- hardware wallets for all owners;
- one owner held offline for recovery;
- separate oracle authority from admin;
- upgrade authority transferred to the multisig vault;
- platform treasury separated from operational wallets.

Deployment sequence:
1. Create and test the multisig on Devnet.
2. Generate the final program keypair offline.
3. Initialize config with the multisig vault as admin.
4. If initialized with a temporary deployer, call `propose_admin(vault)` then execute `accept_admin` through the vault.
5. Transfer program upgrade authority with `solana program set-upgrade-authority`.
6. Record transaction signatures in `audit/evidence/multisig.json`.

Never store owner seed phrases, program keypairs, or oracle private keys in this repository.
