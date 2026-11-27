package main

import (
	"encoding/binary"
	"fmt"

	"github.com/pearl-research-labs/pearl/node/chaincfg"
)

func main() {
	for _, n := range []*chaincfg.Params{&chaincfg.MainNetParams, &chaincfg.TestNetParams, &chaincfg.TestNet2Params, &chaincfg.RegressionNetParams, &chaincfg.SimNetParams, &chaincfg.SigNetParams} {
		var magic [4]byte
		binary.LittleEndian.PutUint32(magic[:], uint32(n.Net))
		fmt.Printf("%s 0x%08x %x %s %s %s maturity=%d\n", n.Name, uint32(n.Net), magic, n.GenesisHash, n.Bech32HRPSegwit, n.DefaultPort, n.CoinbaseMaturity)
	}
}
