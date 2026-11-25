// verifyrefund checks a public, presigned Pearl refund against a separately
// supplied laboratory intent. It has no wallet, signing key, RPC or broadcast.
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/pearl-research-labs/pearl/node/chaincfg"
	"github.com/pearl-research-labs/pearl/node/txscript"
	"github.com/pearl-research-labs/pearl/node/wire"
)

type intent struct {
	Network, Genesis, FundingTxid, ContractScript, Destination string
	Magic, Height                                              uint32
	ContractValue, RefundValue                                 int64
}

func check(ok bool, why string) {
	if !ok {
		panic(why)
	}
}

func transaction(s string) *wire.MsgTx {
	check(len(s) < 8192, "oversize fixture transaction")
	data, err := hex.DecodeString(s)
	check(err == nil, "invalid fixture serialization")
	r := bytes.NewReader(data)
	var tx wire.MsgTx
	check(tx.Deserialize(r) == nil && r.Len() == 0, "invalid Pearl transaction")
	return &tx
}

func main() {
	quote := len(os.Args) == 2 && os.Args[1] == "--fee-quote"
	check(len(os.Args) == 1 || quote, "unsupported verifier arguments")
	var in struct {
		Intent          intent
		Funding, Refund string
	}
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 16385))
	check(err == nil && len(raw) <= 16384, "oversize or unreadable recovery input")
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	check(d.Decode(&in) == nil && d.Decode(new(any)) == io.EOF, "malformed recovery input")
	i := in.Intent
	params := &chaincfg.RegressionNetParams
	if i.Network == "simnet" {
		params = &chaincfg.SimNetParams
	}
	check(i.Network == params.Name && i.Magic == uint32(params.Net) && i.Genesis == params.GenesisHash.String(), "network intent mismatch")
	parent, refund := transaction(in.Funding), transaction(in.Refund)
	check(len(parent.TxOut) == 2 && parent.TxHash().String() == i.FundingTxid, "wrong funding transaction")
	prev := parent.TxOut[0]
	check(txscript.IsPayToTaproot(prev.PkScript) && hex.EncodeToString(prev.PkScript) == i.ContractScript && prev.Value == i.ContractValue, "wrong funding output")
	check(len(refund.TxIn) == 1 && len(refund.TxOut) == 1 && refund.Version == 2, "invalid refund shape")
	input, output := refund.TxIn[0], refund.TxOut[0]
	check(input.PreviousOutPoint.Hash == parent.TxHash() && input.PreviousOutPoint.Index == 0 && len(input.SignatureScript) == 0, "wrong prevout")
	check(i.Height > 0 && i.Height < 500000000 && refund.LockTime == i.Height && input.Sequence == 0xfffffffe, "wrong refund lock")
	check(txscript.IsPayToTaproot(output.PkScript) && hex.EncodeToString(output.PkScript) == i.Destination, "wrong refund destination")
	check(output.Value == i.RefundValue && i.ContractValue == 1000000 && i.RefundValue == 998500, "wrong amount or fee")
	w := input.DecodeWitness()
	check(len(w) == 3 && len(w[0]) == 65 && w[0][64] == byte(txscript.SigHashAll), "unexpected witness or sighash")
	// Enforce the agreed single-key, height-based refund leaf, independently
	// of the signer's script builder; bind its NUMS internal key and tree depth.
	check(len(w[1]) >= 34 && len(w[2]) == 65 && hex.EncodeToString(w[2][1:33]) == "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0", "unexpected control block")
	pub := w[1][len(w[1])-33 : len(w[1])-1]
	leaf, err := txscript.NewScriptBuilder().AddInt64(int64(i.Height)).AddOp(txscript.OP_CHECKLOCKTIMEVERIFY).AddOp(txscript.OP_DROP).AddData(pub).AddOp(txscript.OP_CHECKSIG).Script()
	check(err == nil && bytes.Equal(leaf, w[1]), "unexpected refund leaf")
	fetch := txscript.NewCannedPrevOutputFetcher(prev.PkScript, prev.Value)
	hashes := txscript.NewTxSigHashes(refund, fetch)
	vm, err := txscript.NewEngine(prev.PkScript, refund, 0, txscript.StandardVerifyFlags, nil, hashes, prev.Value, fetch)
	check(err == nil && vm.Execute() == nil, "refund failed native Pearl VM")
	if quote {
		// Pearl v1.5.8 blockchain.CalcVsize discounts each four witness bytes.
		base := refund.SerializeSizeStripped()
		vsize := base + (refund.SerializeSize()-base+3)/4
		err := json.NewEncoder(os.Stdout).Encode(struct {
			Txid      string
			FeeGrains int64
			Vsize     int
		}{refund.TxHash().String(), prev.Value - output.Value, vsize})
		check(err == nil, "cannot write verified fee quote")
		return
	}
	fmt.Println(refund.TxHash().String())
}
