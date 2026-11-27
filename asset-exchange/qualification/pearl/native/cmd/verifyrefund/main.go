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

type recipientSpend struct {
	Raw, Destination string
}

type feeQuote struct {
	Txid           string
	FeeGrains      int64
	Vsize          int
	ChildTxid      string `json:",omitempty"`
	ChildFeeGrains int64  `json:",omitempty"`
	ChildVsize     int    `json:",omitempty"`
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

func vsize(tx *wire.MsgTx) int {
	// Pearl v1.5.8 blockchain.CalcVsize discounts each four witness bytes.
	base := tx.SerializeSizeStripped()
	return base + (tx.SerializeSize()-base+3)/4
}

func validSpend(tx *wire.MsgTx, prev *wire.TxOut) bool {
	fetch := txscript.NewCannedPrevOutputFetcher(prev.PkScript, prev.Value)
	hashes := txscript.NewTxSigHashes(tx, fetch)
	vm, err := txscript.NewEngine(prev.PkScript, tx, 0, txscript.StandardVerifyFlags, nil, hashes, prev.Value, fetch)
	return err == nil && vm.Execute() == nil
}

func verifyChild(refund *wire.MsgTx, spend *recipientSpend, fee int64) *wire.MsgTx {
	child := transaction(spend.Raw)
	check(child.Version == 2 && child.LockTime == 0 && len(child.TxIn) == 1 && len(child.TxOut) == 1, "invalid recipient transaction")
	input, output, prev := child.TxIn[0], child.TxOut[0], refund.TxOut[0]
	check(input.PreviousOutPoint.Hash == refund.TxHash() && input.PreviousOutPoint.Index == 0 &&
		input.Sequence == 0xfffffffe && len(input.SignatureScript) == 0, "wrong recipient prevout")
	check(txscript.IsPayToTaproot(output.PkScript) && !bytes.Equal(output.PkScript, prev.PkScript) &&
		hex.EncodeToString(output.PkScript) == spend.Destination && output.Value == prev.Value-fee, "wrong recipient payment")
	w := input.DecodeWitness()
	check(len(w) == 1 && len(w[0]) == 65 && w[0][64] == byte(txscript.SigHashAll), "unexpected recipient sighash")
	check(validSpend(child, prev), "recipient payment failed native Pearl VM")
	return child
}

func main() {
	quote := len(os.Args) == 2 && os.Args[1] == "--fee-quote"
	plan := len(os.Args) == 3 && os.Args[1] == "--plan-quote"
	check(len(os.Args) == 1 || quote || plan, "unsupported verifier arguments")
	refundFee, childFee := int64(1500), int64(2000)
	sequence := uint32(0xfffffffe)
	if plan {
		var allowed bool
		refundFee, allowed = map[string]int64{"1500": 1500, "2000": 2000, "3000": 3000}[os.Args[2]]
		check(allowed, "unapproved refund fee")
		if refundFee > 1500 {
			childFee = 3000
		}
		sequence = 0xfffffffd
	}
	var in struct {
		Intent          intent
		Funding, Refund string
		Recipient       json.RawMessage
	}
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 16385))
	check(err == nil && len(raw) <= 16384, "oversize or unreadable recovery input")
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	check(d.Decode(&in) == nil && d.Decode(new(any)) == io.EOF, "malformed recovery input")
	check(plan == (len(in.Recipient) != 0), "unexpected or missing recipient payment")
	var recipient recipientSpend
	if plan {
		childDecoder := json.NewDecoder(bytes.NewReader(in.Recipient))
		childDecoder.DisallowUnknownFields()
		check(childDecoder.Decode(&recipient) == nil && recipient.Raw != "" && recipient.Destination != "", "malformed recipient payment")
	}
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
	check(i.Height > 0 && i.Height < 500000000 && (!plan || i.Height == 104) && refund.LockTime == i.Height && input.Sequence == sequence, "wrong refund lock")
	check(txscript.IsPayToTaproot(output.PkScript) && hex.EncodeToString(output.PkScript) == i.Destination, "wrong refund destination")
	check(output.Value == i.RefundValue && i.ContractValue == 1000000 && i.RefundValue == i.ContractValue-refundFee, "wrong amount or fee")
	w := input.DecodeWitness()
	check(len(w) == 3 && len(w[0]) == 65 && w[0][64] == byte(txscript.SigHashAll), "unexpected witness or sighash")
	// Enforce the agreed single-key, height-based refund leaf, independently
	// of the signer's script builder; bind its NUMS internal key and tree depth.
	check(len(w[1]) >= 34 && len(w[2]) == 65 && hex.EncodeToString(w[2][1:33]) == "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0", "unexpected control block")
	pub := w[1][len(w[1])-33 : len(w[1])-1]
	leaf, err := txscript.NewScriptBuilder().AddInt64(int64(i.Height)).AddOp(txscript.OP_CHECKLOCKTIMEVERIFY).AddOp(txscript.OP_DROP).AddData(pub).AddOp(txscript.OP_CHECKSIG).Script()
	check(err == nil && bytes.Equal(leaf, w[1]), "unexpected refund leaf")
	check(validSpend(refund, prev), "refund failed native Pearl VM")
	if quote || plan {
		q := feeQuote{Txid: refund.TxHash().String(), FeeGrains: refundFee, Vsize: vsize(refund)}
		if plan {
			child := verifyChild(refund, &recipient, childFee)
			q.ChildTxid, q.ChildFeeGrains, q.ChildVsize = child.TxHash().String(), childFee, vsize(child)
		}
		err := json.NewEncoder(os.Stdout).Encode(q)
		check(err == nil, "cannot write verified fee quote")
		return
	}
	fmt.Println(refund.TxHash().String())
}
