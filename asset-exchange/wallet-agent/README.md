# asset-exchange-wallet-agent

The network-facing Wallet Agent service is NOT IMPLEMENTED. It remains blocked until transport pairing, origin and signing/recovery semantics are reviewed; it must expose no shell, private-key export or arbitrary-file capability.

The Regtest-only [DOGE policy library](dogecoin/README.md) now validates bounded pre-signed refund ladders and narrow external software-signer requests/responses. It does not hold keys, expose a service, assert hardware support or activate financial routes.
