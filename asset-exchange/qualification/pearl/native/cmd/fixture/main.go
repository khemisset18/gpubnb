// Package main is a one-shot fixture signer for the two private Pearl networks.
// It generates contract keys in memory, waits for its own synthetic coinbase,
// verifies the prepared refund in Pearl's VM and exits before funding is submitted.
package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"

	"github.com/pearl-research-labs/pearl/node/btcec"
	"github.com/pearl-research-labs/pearl/node/btcec/schnorr"
	"github.com/pearl-research-labs/pearl/node/btcutil"
	"github.com/pearl-research-labs/pearl/node/chaincfg"
	"github.com/pearl-research-labs/pearl/node/chaincfg/chainhash"
	"github.com/pearl-research-labs/pearl/node/txscript"
	"github.com/pearl-research-labs/pearl/node/wire"
)

const contractValue int64 = 1_000_000

type fixtureInput struct {
	Network         string
	Txid            string
	Output          uint32
	Value           int64
	Height          uint32
	Script          string
	RecipientScript string
}

func must[T any](value T, err error) T {
	if err != nil {
		panic(err)
	}
	return value
}

func encode(tx *wire.MsgTx) string {
	var b bytes.Buffer
	if err := tx.Serialize(&b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b.Bytes())
}

func emit(v any) {
	if err := json.NewEncoder(os.Stdout).Encode(v); err != nil {
		panic(err)
	}
}

func payment(point wire.OutPoint, value int64, destination []byte, locktime uint32) *wire.MsgTx {
	tx := wire.NewMsgTx(2)
	in := wire.NewTxIn(&point, nil, nil)
	in.Sequence = 0xfffffffe
	tx.AddTxIn(in)
	tx.AddTxOut(wire.NewTxOut(value, destination))
	tx.LockTime = locktime
	return tx
}

func verify(tx *wire.MsgTx, prev *wire.TxOut) error {
	fetch := txscript.NewCannedPrevOutputFetcher(prev.PkScript, prev.Value)
	hashes := txscript.NewTxSigHashes(tx, fetch)
	vm, err := txscript.NewEngine(prev.PkScript, tx, 0, txscript.StandardVerifyFlags, nil, hashes, prev.Value, fetch)
	if err != nil {
		return err
	}
	return vm.Execute()
}

func checked(tx *wire.MsgTx, prev *wire.TxOut) string {
	if err := verify(tx, prev); err != nil {
		panic(err)
	}
	return encode(tx)
}

func main() {
	miner := must(btcec.NewPrivateKey())
	sourceKey := txscript.ComputeTaprootKeyNoScript(miner.PubKey())
	source := must(txscript.PayToTaprootScript(sourceKey))
	addr := must(btcutil.NewAddressTaproot(schnorr.SerializePubKey(sourceKey), &chaincfg.RegressionNetParams))
	emit(map[string]string{"payout": addr.EncodeAddress(), "script": hex.EncodeToString(source)})

	var p fixtureInput
	if err := json.NewDecoder(os.Stdin).Decode(&p); err != nil {
		panic(err)
	}
	if (p.Network != "regtest" && p.Network != "simnet") || len(p.Txid) != 64 ||
		p.Script != hex.EncodeToString(source) || p.Value <= contractValue+5000 ||
		p.Height < 2 || p.Height >= 500000000 {
		panic("invalid private-chain fixture")
	}

	claimKey := must(btcec.NewPrivateKey())
	refundKey := must(btcec.NewPrivateKey())
	var dest []byte
	if p.RecipientScript == "" {
		beneficiary := must(btcec.NewPrivateKey())
		dest = must(txscript.PayToTaprootScript(txscript.ComputeTaprootKeyNoScript(beneficiary.PubKey())))
	} else {
		dest = must(hex.DecodeString(p.RecipientScript))
		if len(dest) != 34 || !txscript.IsPayToTaproot(dest) {
			panic("invalid public beneficiary script")
		}
		_ = must(schnorr.ParsePubKey(dest[2:]))
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		panic(err)
	}
	digest := sha256.Sum256(secret)
	claimLeaf := txscript.NewBaseTapLeaf(must(txscript.NewScriptBuilder().
		AddOp(txscript.OP_SIZE).AddInt64(32).AddOp(txscript.OP_EQUALVERIFY).
		AddOp(txscript.OP_SHA256).AddData(digest[:]).AddOp(txscript.OP_EQUALVERIFY).
		AddData(schnorr.SerializePubKey(claimKey.PubKey())).AddOp(txscript.OP_CHECKSIG).Script()))
	refundLeaf := txscript.NewBaseTapLeaf(must(txscript.NewScriptBuilder().
		AddInt64(int64(p.Height)).AddOp(txscript.OP_CHECKLOCKTIMEVERIFY).AddOp(txscript.OP_DROP).
		AddData(schnorr.SerializePubKey(refundKey.PubKey())).AddOp(txscript.OP_CHECKSIG).Script()))
	// BIP341's published NUMS point. Neither test party controls a key path.
	nums := must(schnorr.ParsePubKey(must(hex.DecodeString("50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0"))))
	tree := txscript.AssembleTaprootScriptTree(claimLeaf, refundLeaf)
	root := tree.RootNode.TapHash()
	contract := must(txscript.PayToTaprootScript(txscript.ComputeTaprootOutputKey(nums, root[:])))
	parent := payment(wire.OutPoint{Hash: *must(chainhash.NewHashFromStr(p.Txid)), Index: p.Output}, contractValue, contract, 0)
	parent.AddTxOut(wire.NewTxOut(p.Value-contractValue-2000, source))
	prev := wire.NewTxOut(p.Value, source)
	cache := txscript.NewTxSigHashes(parent, txscript.NewCannedPrevOutputFetcher(source, p.Value))
	parent.TxIn[0].SetWitness(must(txscript.TaprootWitnessSignature(parent, cache, 0, p.Value, source, txscript.SigHashAll, miner)))
	parentHex := checked(parent, prev)
	point := wire.OutPoint{Hash: parent.TxHash(), Index: 0}
	buildSpend := func(leaf txscript.TapLeaf, key *btcec.PrivateKey, lock uint32, value int64, hashlock bool, sequence uint32) *wire.MsgTx {
		tx := payment(point, value, dest, lock)
		tx.TxIn[0].Sequence = sequence
		hashes := txscript.NewTxSigHashes(tx, txscript.NewCannedPrevOutputFetcher(contract, contractValue))
		sig := must(txscript.RawTxInTapscriptSignature(tx, hashes, 0, contractValue, contract, leaf, txscript.SigHashAll, key))
		proof := tree.LeafMerkleProofs[tree.LeafProofIndex[leaf.TapHash()]].ToControlBlock(nums)
		w := wire.TxWitness{sig}
		if hashlock {
			w = append(w, secret)
		}
		tx.TxIn[0].SetWitness(append(w, leaf.Script, must(proof.ToBytes())))
		return tx
	}
	refund := buildSpend(refundLeaf, refundKey, p.Height, contractValue-1500, false, 0xfffffffe)
	claim := buildSpend(claimLeaf, claimKey, 0, contractValue-1500, true, 0xfffffffe)
	badSecret := claim.Copy()
	witness := badSecret.TxIn[0].DecodeWitness()
	witness[1] = bytes.Clone(witness[1])
	witness[1][0] ^= 1
	badSecret.TxIn[0].SetWitness(witness)
	wrongDestination := refund.Copy()
	wrongDestination.TxOut[0].PkScript = source
	badTimelock := buildSpend(refundLeaf, refundKey, p.Height-1, contractValue-1500, false, 0xfffffffe)
	fundingOut := parent.TxOut[0]
	// At the pinned node's default 1,000 grains/kvB policy the fee in
	// grains equals vsize for this fixed-size witness. P2TR output dust
	// uses three times output size plus the discounted spend estimate.
	base := claim.SerializeSizeStripped()
	feeFloor := int64(base + (claim.SerializeSize()-base+3)/4)
	dustFloor := 3 * int64(claim.TxOut[0].SerializeSize()+41+(107+3)/4)
	claimWithValue := func(value int64) string {
		return checked(buildSpend(claimLeaf, claimKey, 0, value, true, 0xfffffffe), fundingOut)
	}
	for name, tx := range map[string]*wire.MsgTx{"wrong-secret": badSecret, "changed-destination": wrongDestination, "short-lock": badTimelock} {
		if verify(tx, fundingOut) == nil {
			panic(fmt.Sprintf("VM accepted %s", name))
		}
	}
	emit(map[string]any{
		"funding": parentHex, "fundingTxid": parent.TxHash().String(), "contractScript": hex.EncodeToString(contract),
		"destination": hex.EncodeToString(dest), "refund": checked(refund, fundingOut), "refundTxid": refund.TxHash().String(),
		"claim": checked(claim, fundingOut), "claimTxid": claim.TxHash().String(), "badSecret": encode(badSecret),
		"badDestination": encode(wrongDestination), "shortLock": encode(badTimelock),
		"rbfBase":        checked(buildSpend(claimLeaf, claimKey, 0, contractValue-500, true, 0xfffffffd), fundingOut),
		"rbfLower":       checked(buildSpend(claimLeaf, claimKey, 0, contractValue-400, true, 0xfffffffd), fundingOut),
		"rbfHigher":      checked(buildSpend(claimLeaf, claimKey, 0, contractValue-4000, true, 0xfffffffd), fundingOut),
		"dust":           checked(buildSpend(claimLeaf, claimKey, 0, 1, true, 0xfffffffe), fundingOut),
		"zeroFee":        checked(buildSpend(claimLeaf, claimKey, 0, contractValue, true, 0xfffffffe), fundingOut),
		"feeFloorGrains": feeFloor, "dustFloorGrains": dustFloor,
		"belowFee": claimWithValue(contractValue - feeFloor + 1), "atFee": claimWithValue(contractValue - feeFloor),
		"belowDust": claimWithValue(dustFloor - 1), "atDust": claimWithValue(dustFloor),
	})
}
