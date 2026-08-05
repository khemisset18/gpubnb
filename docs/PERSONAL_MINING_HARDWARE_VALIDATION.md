# Personal mining hardware validation

This document records observed integration results. It is not a profitability claim and does not
guarantee identical performance on other machines.

## Windows test machine

- Platform: Windows x86-64
- CPU: Intel Core i5-10300H
- GPU: NVIDIA GeForce GTX 1650, 4095 MiB
- NVIDIA driver: 592.82

## Validated profiles

| Cryptocurrency | Miner | Integration result | Observed evidence |
| --- | --- | --- | --- |
| XMR | XMRig 6.26.0 | Validated | Pool jobs received, non-zero RandomX hashrate and an accepted share |
| ALPH | lolMiner 1.98a | Validated with thermal reservation | Worker authorized, Alephium jobs received, 2 accepted shares, 0 stale shares and 0 hardware errors |

The ALPH run used the approved `ALEPH` algorithm identifier and a standard Alephium address. The
observed hashrate varied from approximately 70 to 339 MH/s. Temperature reached 91–93 °C and the
hashrate fell sharply, so this machine must not be used for another sustained run until its cooling
has been corrected.

## Thermal protection

- The desktop backend reads the NVIDIA temperature sensor every five seconds while a miner runs.
- A warning is displayed from 80 °C.
- At 85 °C, mining is stopped, owner mining consent is disabled and a restart latch is set.
- A manual rearm is accepted only after a fresh native sensor reading is at or below 75 °C.
- An unavailable or invalid sensor cannot clear the restart latch.

## Display rules

- Hashrate, temperature, power, uptime and shares are parsed from the local miner log.
- A/S/Hw means accepted, stale and hardware-error shares.
- Revenue remains unavailable until a trusted network-yield source is connected.
- Fiat values remain unavailable until a cached, rate-limited price source is connected.
- Estimated revenue, pool-confirmed balance and wallet-paid transactions must remain separate.
