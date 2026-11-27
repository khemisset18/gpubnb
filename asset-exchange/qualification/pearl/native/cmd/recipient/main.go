// recipient is a lab-only, one-shot process. It never receives an HTLC key.
// It supplies a fresh public P2TR destination and preauthorizes a payment
// from each agreed refund output to a second fresh public destination.
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"

	"github.com/pearl-research-labs/pearl/node/btcec"
	"github.com/pearl-research-labs/pearl/node/txscript"
	"github.com/pearl-research-labs/pearl/node/wire"
)

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

func require(ok bool, reason string) {
	if !ok {
		panic(reason)
	}
}

func decodeRefund(encoded string) *wire.MsgTx {
	raw := bytes.NewReader(must(hex.DecodeString(encoded)))
	var refund wire.MsgTx
	require(refund.Deserialize(raw) == nil && raw.Len() == 0 && refund.Version == 2 && len(refund.TxIn) == 1 && len(refund.TxOut) == 1, "malformed presigned refund")
	return &refund
}

func signPayment(key *btcec.PrivateKey, receive, next []byte, refund *wire.MsgTx, amount, fee int64) map[string]string {
	prev := refund.TxOut[0]
	require(bytes.Equal(receive, prev.PkScript) && prev.Value == amount, "refund does not pay the agreed lab recipient")
	tx := wire.NewMsgTx(2)
	point := wire.OutPoint{Hash: refund.TxHash(), Index: 0}
	input := wire.NewTxIn(&point, nil, nil)
	input.Sequence = 0xfffffffe
	tx.AddTxIn(input)
	tx.AddTxOut(wire.NewTxOut(amount-fee, next))
	fetch := txscript.NewCannedPrevOutputFetcher(receive, amount)
	hashes := txscript.NewTxSigHashes(tx, fetch)
	input.SetWitness(must(txscript.TaprootWitnessSignature(tx, hashes, 0, amount, receive, txscript.SigHashAll, key)))
	vm := must(txscript.NewEngine(receive, tx, 0, txscript.StandardVerifyFlags, nil, hashes, amount, fetch))
	require(vm.Execute() == nil, "recipient payment failed native VM")
	var encoded bytes.Buffer
	if err := tx.Serialize(&encoded); err != nil {
		panic(err)
	}
	return map[string]string{"raw": hex.EncodeToString(encoded.Bytes()), "txid": tx.TxHash().String()}
}

func main() {
	key := must(btcec.NewPrivateKey())
	receive := must(txscript.PayToTaprootScript(txscript.ComputeTaprootKeyNoScript(key.PubKey())))
	nextKey := must(btcec.NewPrivateKey())
	next := must(txscript.PayToTaprootScript(txscript.ComputeTaprootKeyNoScript(nextKey.PubKey())))
	output := json.NewEncoder(os.Stdout)
	if err := output.Encode(map[string]string{"recipientScript": hex.EncodeToString(receive), "nextScript": hex.EncodeToString(next)}); err != nil {
		panic(err)
	}

	var request struct {
		Network, Refund string
		RefundOptions   []string
	}
	data := must(io.ReadAll(io.LimitReader(os.Stdin, 8193)))
	require(len(data) <= 8192, "oversize recipient request")
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	require(decoder.Decode(&request) == nil && decoder.Decode(new(any)) == io.EOF, "malformed recipient request")
	require(request.Network == "regtest" || request.Network == "simnet", "private network required")
	if request.RefundOptions == nil {
		payment := signPayment(key, receive, next, decodeRefund(request.Refund), 998500, 2000)
		if err := output.Encode(payment); err != nil {
			panic(err)
		}
		return
	}
	require(request.Refund == "" && len(request.RefundOptions) == 3, "expected one complete fee plan")
	var payments []map[string]string
	var outpoint wire.OutPoint
	for i, fee := range []int64{1500, 2000, 3000} {
		refund := decodeRefund(request.RefundOptions[i])
		require(refund.LockTime == 104 && refund.TxIn[0].Sequence == 0xfffffffd, "unexpected fee-plan lock")
		if i == 0 {
			outpoint = refund.TxIn[0].PreviousOutPoint
		}
		require(refund.TxIn[0].PreviousOutPoint == outpoint && outpoint.Index == 0, "inconsistent fee-plan outpoint")
		childFee := int64(3000)
		if i == 0 {
			childFee = 2000
		}
		payments = append(payments, signPayment(key, receive, next, refund, 1000000-fee, childFee))
	}
	if err := output.Encode(payments); err != nil {
		panic(err)
	}
}
