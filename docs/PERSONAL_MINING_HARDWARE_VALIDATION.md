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

## GPU performance modes

- Eco targets 33% of the NVIDIA default power limit.
- Balanced targets 66% and is the default for new GPU configurations.
- Full targets 100% of the NVIDIA default power limit.
- Every target is clamped to the minimum and default limits reported by the GPU firmware.
- lolMiner receives the resulting per-GPU limits as structured `--pl` arguments; shell input is never used.
- The modes do not apply to the validated XMR profile because that profile uses the CPU on the test machine.

## Display rules

- Hashrate, temperature, power, uptime and shares are parsed from the local miner log.
- A/S/Hw means accepted, stale and hardware-error shares.
- Revenue remains unavailable until a trusted network-yield source is connected.
- Fiat values remain unavailable until a cached, rate-limited price source is connected.
- Estimated revenue, pool-confirmed balance and wallet-paid transactions must remain separate.
