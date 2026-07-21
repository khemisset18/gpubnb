# Incident response runbook

1. Detect and classify: contract, key, API, database, agent, workload isolation or RPC incident.
2. Contain: pause the program through the admin multisig, disable new bookings, revoke affected agent keys, rotate service secrets, preserve logs.
3. Communicate: record UTC timestamps, affected bookings and transaction signatures; notify affected users without exposing exploit details.
4. Recover: reconcile every escrow against finalized chain state, restore databases from tested backups, deploy only an audited build.
5. Review: publish root cause, remediation, financial impact and prevention actions. Never unpause until multisig owners approve the evidence.

Emergency contacts, multisig owners, RPC provider and legal contacts must be maintained outside the repository.
