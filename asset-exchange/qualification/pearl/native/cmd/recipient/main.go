// recipient is a lab-only, one-shot process. It never receives an HTLC key.
// It supplies a fresh public P2TR destination and preauthorizes one payment
// from its own exact refund output to a second fresh public destination.
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
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

func main() {
	key := must(btcec.NewPrivateKey())
	receive := must(txscript.PayToTaprootScript(txscript.ComputeTaprootKeyNoScript(key.PubKey())))
	nextKey := must(btcec.NewPrivateKey())
	next := must(txscript.PayToTaprootScript(txscript.ComputeTaprootKeyNoScript(nextKey.PubKey())))
	output := json.NewEncoder(os.Stdout)
	if err := output.Encode(map[string]string{"recipientScript": hex.EncodeToString(receive), "nextScript": hex.EncodeToString(next)}); err != nil {
		panic(err)
	}

	var request struct{ Network, Refund string }
	data := must(io.ReadAll(io.LimitReader(os.Stdin, 8193)))
	require(len(data) <= 8192, "oversize recipient request")
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	require(decoder.Decode(&request) == nil && decoder.Decode(new(any)) == io.EOF, "malformed recipient request")
	require(request.Network == "regtest" || request.Network == "simnet", "private network required")
	raw := bytes.NewReader(must(hex.DecodeString(request.Refund)))
	var refund wire.MsgTx
	require(refund.Deserialize(raw) == nil && raw.Len() == 0 && refund.Version == 2 && len(refund.TxIn) == 1 && len(refund.TxOut) == 1, "malformed presigned refund")
	prev := refund.TxOut[0]
	require(bytes.Equal(receive, prev.PkScript) && prev.Value == 998500, "refund does not pay the agreed lab recipient")
	tx := wire.NewMsgTx(2)
	point := wire.OutPoint{Hash: refund.TxHash(), Index: 0}
	input := wire.NewTxIn(&point, nil, nil)
	input.Sequence = 0xfffffffe
	tx.AddTxIn(input)
	tx.AddTxOut(wire.NewTxOut(prev.Value-2000, next))
	fetch := txscript.NewCannedPrevOutputFetcher(receive, prev.Value)
	hashes := txscript.NewTxSigHashes(tx, fetch)
	input.SetWitness(must(txscript.TaprootWitnessSignature(tx, hashes, 0, prev.Value, receive, txscript.SigHashAll, key)))
	vm := must(txscript.NewEngine(receive, tx, 0, txscript.StandardVerifyFlags, nil, hashes, prev.Value, fetch))
	require(vm.Execute() == nil, "recipient payment failed native VM")
	var encoded bytes.Buffer
	if err := tx.Serialize(&encoded); err != nil {
		panic(err)
	}
	err := output.Encode(map[string]string{"raw": hex.EncodeToString(encoded.Bytes()), "txid": tx.TxHash().String()})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
