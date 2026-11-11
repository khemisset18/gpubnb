// GPUbnb diagnostic tests against unmodified Dogecoin v1.14.9 implementations.
// Test-only ephemeral keys, private Regtest, no wallet/RPC/P2P threads.
#include "chainparams.h"
#include "coins.h"
#include "consensus/consensus.h"
#include "consensus/validation.h"
#include "policy/policy.h"
#include "script/interpreter.h"
#include "script/standard.h"
#include "test/test_bitcoin.h"
#include "utiltime.h"
#include "validation.h"
#include "versionbits.h"
#include <boost/test/unit_test.hpp>

namespace {
const unsigned int d3ConsensusFlags = SCRIPT_VERIFY_P2SH | SCRIPT_VERIFY_DERSIG
    | SCRIPT_VERIFY_CHECKLOCKTIMEVERIFY;

CScript d3Sign(const CKey& key, const CScript& scriptCode, const CMutableTransaction& tx,
    int hashType = SIGHASH_ALL)
{
    std::vector<unsigned char> signature;
    BOOST_REQUIRE(key.Sign(SignatureHash(scriptCode, tx, 0, hashType, 0, SIGVERSION_BASE), signature));
    signature.push_back(hashType);
    return CScript() << signature;
}

// No witness input is created. Avoid indexing an empty witness vector.
bool d3VerifyLegacy(const CMutableTransaction& tx, const CScript& scriptPubKey,
    unsigned int flags = d3ConsensusFlags, CAmount amount = 0)
{
    const CTransaction immutable(tx);
    ScriptError error = SCRIPT_ERR_UNKNOWN_ERROR;
    const CScriptWitness emptyWitness;
    return VerifyScript(tx.vin[0].scriptSig, scriptPubKey, &emptyWitness,
        flags, TransactionSignatureChecker(&immutable, 0, amount), &error);
}

struct D3BasicSetup : BasicTestingSetup {
    D3BasicSetup() : BasicTestingSetup(CBaseChainParams::REGTEST) {}
};

struct D3RestoreStandard {
    bool previous;
    D3RestoreStandard() : previous(fRequireStandard) { fRequireStandard = true; }
    ~D3RestoreStandard() { fRequireStandard = previous; mempool.clear(); }
};

void d3MineTo(TestChain240Setup& setup, const CScript& minerScript, int target)
{
    BOOST_REQUIRE(target >= chainActive.Height() && target <= 1352);
    for (int next = chainActive.Height() + 1; next <= target; ++next) {
        setup.CreateAndProcessBlock({}, minerScript);
        BOOST_REQUIRE_EQUAL(chainActive.Height(), next);
    }
}
}

BOOST_AUTO_TEST_SUITE(gpubnb_d3)

BOOST_FIXTURE_TEST_CASE(bip65_block_activation_differs_from_mempool_policy, TestChain240Setup)
{
    BOOST_REQUIRE_EQUAL(Params().NetworkIDString(), "regtest");
    LOCK(cs_main);
    D3RestoreStandard standard;
    const int previousThreads = nScriptCheckThreads;
    struct RestoreThreads { int old; ~RestoreThreads() { nScriptCheckThreads = old; } } restoreThreads{previousThreads};
    // Inline checks preserve the actual script error in CValidationState.
    nScriptCheckThreads = 0;
    CTxMemPool pool(incrementalRelayFee);
    const CScript minerScript = coinbaseTxns[0].vout[0].scriptPubKey;
    const int activation = Params().GetConsensus(0).BIP65Height;
    BOOST_REQUIRE_EQUAL(activation, 1351);
    d3MineTo(*this, minerScript, activation - 3);
    CKey refundKey; refundKey.MakeNewKey(true);
    const CScript badRedeem = CScript() << OP_1NEGATE << OP_CHECKLOCKTIMEVERIFY << OP_DROP
        << ToByteVector(refundKey.GetPubKey()) << OP_CHECKSIG;
    const CScript goodRedeem = CScript() << activation - 1 << OP_CHECKLOCKTIMEVERIFY << OP_DROP
        << ToByteVector(refundKey.GetPubKey()) << OP_CHECKSIG;
    const CScript badOutput = GetScriptForDestination(CScriptID(badRedeem));
    const CScript goodOutput = GetScriptForDestination(CScriptID(goodRedeem));
    const CScript destination = GetScriptForDestination(refundKey.GetPubKey().GetID());
    CMutableTransaction funding;
    funding.vin.emplace_back(COutPoint(coinbaseTxns[0].GetHash(), 0));
    funding.vout.emplace_back(100 * COIN, badOutput);
    funding.vout.emplace_back(100 * COIN, badOutput);
    funding.vout.emplace_back(100 * COIN, goodOutput);
    funding.vout.emplace_back(coinbaseTxns[0].vout[0].nValue - 301 * COIN,
        GetScriptForDestination(coinbaseKey.GetPubKey().GetID()));
    funding.vin[0].scriptSig = d3Sign(coinbaseKey, minerScript, funding);
    bool missing = false; CValidationState fundingState;
    BOOST_REQUIRE(AcceptToMemoryPool(pool, fundingState, MakeTransactionRef(funding), false,
        &missing, nullptr, false, 0));
    BOOST_REQUIRE(!missing);
    CreateAndProcessBlock({funding}, minerScript);
    BOOST_REQUIRE_EQUAL(chainActive.Height(), activation - 2);
    pool.removeRecursive(CTransaction(funding));
    auto spend = [&](unsigned int vout, const CScript& redeem, uint32_t lock) {
        CMutableTransaction tx;
        tx.nLockTime = lock;
        tx.vin.emplace_back(COutPoint(funding.GetHash(), vout), CScript(), 0xfffffffe);
        tx.vout.emplace_back(99 * COIN, destination);
        tx.vin[0].scriptSig = d3Sign(refundKey, redeem, tx);
        tx.vin[0].scriptSig << std::vector<unsigned char>(redeem.begin(), redeem.end());
        return tx;
    };
    const CMutableTransaction before = spend(0, badRedeem, 0);
    BOOST_REQUIRE(d3VerifyLegacy(before, badOutput, SCRIPT_VERIFY_P2SH | SCRIPT_VERIFY_DERSIG));
    BOOST_REQUIRE(!d3VerifyLegacy(before, badOutput));
    CValidationState policyBefore;
    BOOST_REQUIRE(!AcceptToMemoryPool(pool, policyBefore, MakeTransactionRef(before), false,
        &missing, nullptr, false, 0));
    BOOST_REQUIRE(!missing);
    BOOST_REQUIRE(policyBefore.GetRejectReason().find("Negative locktime") != std::string::npos);
    // Actual pre-activation block consensus still treats NOP2 as a NOP.
    CreateAndProcessBlock({before}, minerScript);
    BOOST_REQUIRE_EQUAL(chainActive.Height(), activation - 1);
    const CCoins* beforeCoins = pcoinsTip->AccessCoins(before.GetHash());
    BOOST_REQUIRE(beforeCoins && beforeCoins->IsAvailable(0));
    const CMutableTransaction afterInvalid = spend(1, badRedeem, 0);
    const uint256 priorTip = chainActive.Tip()->GetBlockHash();
    const CBlock invalidBlock = CreateAndProcessBlock({afterInvalid}, minerScript);
    BOOST_REQUIRE_EQUAL(chainActive.Height(), activation - 1);
    BOOST_REQUIRE(chainActive.Tip()->GetBlockHash() == priorTip);
    CValidationState consensusAfter;
    BOOST_REQUIRE(!TestBlockValidity(consensusAfter, Params(), invalidBlock, chainActive.Tip(), true, true));
    BOOST_REQUIRE(consensusAfter.GetRejectReason().find("Negative locktime") != std::string::npos);
    BOOST_REQUIRE(pcoinsTip->AccessCoins(funding.GetHash())->IsAvailable(1));
    const CMutableTransaction afterValid = spend(2, goodRedeem, activation - 1);
    BOOST_REQUIRE(d3VerifyLegacy(afterValid, goodOutput));
    CreateAndProcessBlock({afterValid}, minerScript);
    BOOST_REQUIRE_EQUAL(chainActive.Height(), activation);
    const CCoins* afterCoins = pcoinsTip->AccessCoins(afterValid.GetHash());
    BOOST_REQUIRE(afterCoins && afterCoins->IsAvailable(0));
    BOOST_TEST_MESSAGE("d3-activation before-height=" << activation - 1 << " after-height=" << activation
        << " policy-reject=" << policyBefore.GetRejectReason()
        << " consensus-reject=" << consensusAfter.GetRejectReason());
}

BOOST_FIXTURE_TEST_CASE(timestamp_mtp_finality_and_height_domain, TestChain240Setup)
{
    BOOST_REQUIRE_EQUAL(Params().NetworkIDString(), "regtest");
    LOCK(cs_main);
    D3RestoreStandard standard;
    CTxMemPool pool(incrementalRelayFee);
    const int64_t previousMockTime = GetMockTime();
    struct RestoreTime { int64_t old; ~RestoreTime() { SetMockTime(old); } } restoreTime{previousMockTime};
    const CScript minerScript = coinbaseTxns[0].vout[0].scriptPubKey;
    d3MineTo(*this, minerScript, 1352);
    BOOST_REQUIRE_GE(chainActive.Height(), Params().GetConsensus(0).BIP65Height);
    const uint32_t lock = chainActive.Tip()->GetMedianTimePast() + 100;
    BOOST_REQUIRE_GE(lock, LOCKTIME_THRESHOLD);
    CKey refundKey; refundKey.MakeNewKey(true);
    const CScript redeem = CScript() << lock << OP_CHECKLOCKTIMEVERIFY << OP_DROP
        << ToByteVector(refundKey.GetPubKey()) << OP_CHECKSIG;
    const CScript output = GetScriptForDestination(CScriptID(redeem));
    const CScript destination = GetScriptForDestination(refundKey.GetPubKey().GetID());
    CMutableTransaction funding;
    funding.vin.emplace_back(COutPoint(coinbaseTxns[0].GetHash(), 0));
    funding.vout.emplace_back(100 * COIN, output);
    funding.vout.emplace_back(coinbaseTxns[0].vout[0].nValue - 101 * COIN,
        GetScriptForDestination(coinbaseKey.GetPubKey().GetID()));
    funding.vin[0].scriptSig = d3Sign(coinbaseKey, minerScript, funding);
    CreateAndProcessBlock({funding}, minerScript);
    BOOST_REQUIRE_EQUAL(chainActive.Height(), 1353);
    BOOST_REQUIRE_EQUAL(pcoinsTip->GetOutputFor(CTxIn(COutPoint(funding.GetHash(), 0))).nValue, 100 * COIN);
    CMutableTransaction refund;
    refund.nLockTime = lock;
    refund.vin.emplace_back(COutPoint(funding.GetHash(), 0), CScript(), 0xfffffffe);
    refund.vout.emplace_back(99 * COIN, destination);
    refund.vin[0].scriptSig = d3Sign(refundKey, redeem, refund);
    refund.vin[0].scriptSig << std::vector<unsigned char>(redeem.begin(), redeem.end());
    BOOST_REQUIRE(d3VerifyLegacy(refund, output));
    BOOST_REQUIRE(!IsFinalTx(CTransaction(refund), 1354, lock - 1));
    BOOST_REQUIRE(!IsFinalTx(CTransaction(refund), 1354, lock));
    BOOST_REQUIRE(IsFinalTx(CTransaction(refund), 1354, lock + 1));
    CMutableTransaction heightDomain(refund); heightDomain.nLockTime = 1351;
    heightDomain.vin[0].scriptSig = d3Sign(refundKey, redeem, heightDomain);
    heightDomain.vin[0].scriptSig << std::vector<unsigned char>(redeem.begin(), redeem.end());
    BOOST_REQUIRE(!d3VerifyLegacy(heightDomain, output));
    CMutableTransaction finalSequence(refund); finalSequence.vin[0].nSequence = CTxIn::SEQUENCE_FINAL;
    finalSequence.vin[0].scriptSig = d3Sign(refundKey, redeem, finalSequence);
    finalSequence.vin[0].scriptSig << std::vector<unsigned char>(redeem.begin(), redeem.end());
    BOOST_REQUIRE(IsFinalTx(CTransaction(finalSequence), 1354, lock - 1));
    BOOST_REQUIRE(!d3VerifyLegacy(finalSequence, output));
    const int64_t mtp = chainActive.Tip()->GetMedianTimePast();
    BOOST_REQUIRE_LT(mtp, lock);
    SetMockTime(lock + 30);
    BOOST_REQUIRE(CheckFinalTx(CTransaction(refund), 0));
    BOOST_REQUIRE(!CheckFinalTx(CTransaction(refund), LOCKTIME_MEDIAN_TIME_PAST));
    bool missing = false; CValidationState mempoolState;
    BOOST_REQUIRE(!AcceptToMemoryPool(pool, mempoolState, MakeTransactionRef(refund), false,
        &missing, nullptr, false, 0));
    BOOST_REQUIRE(!missing);
    BOOST_REQUIRE_EQUAL(mempoolState.GetRejectReason(), "non-final");
    const Consensus::Params& consensus = Params().GetConsensus(chainActive.Height());
    BOOST_REQUIRE(VersionBitsState(chainActive.Tip(), consensus, Consensus::DEPLOYMENT_CSV,
        versionbitscache) != THRESHOLD_ACTIVE);
    // Before CSV/BIP113 activation, block consensus uses the block timestamp.
    const CBlock confirmed = CreateAndProcessBlock({refund}, minerScript);
    BOOST_REQUIRE_GT(confirmed.GetBlockTime(), lock);
    BOOST_REQUIRE_EQUAL(chainActive.Height(), 1354);
    const CCoins* recovered = pcoinsTip->AccessCoins(refund.GetHash());
    BOOST_REQUIRE(recovered && recovered->IsAvailable(0));
    BOOST_REQUIRE_EQUAL(recovered->vout[0].nValue, 99 * COIN);
    BOOST_TEST_MESSAGE("d3-finality lock=" << lock << " mtp=" << mtp
        << " block-time=" << confirmed.GetBlockTime() << " mempool-reject=" << mempoolState.GetRejectReason()
        << " csv-active=false blocks=" << chainActive.Height());
}

BOOST_FIXTURE_TEST_CASE(signed_legacy_sighash_mutation_matrix, D3BasicSetup)
{
    CKey key; key.MakeNewKey(true);
    const CScript script = CScript() << ToByteVector(key.GetPubKey()) << OP_CHECKSIG;
    const CScript destination = GetScriptForDestination(key.GetPubKey().GetID());
    CMutableTransaction original;
    original.nLockTime = 1351;
    original.vin.emplace_back(COutPoint(uint256S("01"), 0), CScript(), 0xfffffffe);
    original.vin.emplace_back(COutPoint(uint256S("02"), 1), CScript(), 0xfffffffe);
    original.vout.emplace_back(10 * COIN, destination);
    original.vout.emplace_back(20 * COIN, destination);
    for (int hashType : {int(SIGHASH_ALL), int(SIGHASH_NONE), int(SIGHASH_SINGLE),
            int(SIGHASH_ALL | SIGHASH_ANYONECANPAY), int(SIGHASH_NONE | SIGHASH_ANYONECANPAY),
            int(SIGHASH_SINGLE | SIGHASH_ANYONECANPAY)}) {
        const int base = hashType & 0x1f;
        const bool anyone = hashType & SIGHASH_ANYONECANPAY;
        CMutableTransaction signedTx(original);
        signedTx.vin[0].scriptSig = d3Sign(key, script, signedTx, hashType);
        BOOST_REQUIRE(d3VerifyLegacy(signedTx, script));
        CMutableTransaction mutation(signedTx); mutation.vin[0].prevout.n++;
        BOOST_CHECK(!d3VerifyLegacy(mutation, script));
        mutation = signedTx; mutation.nVersion++;
        BOOST_CHECK(!d3VerifyLegacy(mutation, script));
        mutation = signedTx; mutation.nLockTime++;
        BOOST_CHECK(!d3VerifyLegacy(mutation, script));
        mutation = signedTx; mutation.vin[0].nSequence--;
        BOOST_CHECK(!d3VerifyLegacy(mutation, script));
        mutation = signedTx; mutation.vout[0].nValue--;
        BOOST_CHECK_EQUAL(d3VerifyLegacy(mutation, script), base == SIGHASH_NONE);
        mutation = signedTx; mutation.vout[1].nValue--;
        BOOST_CHECK_EQUAL(d3VerifyLegacy(mutation, script), base != SIGHASH_ALL);
        mutation = signedTx; mutation.vin[1].prevout.n++;
        BOOST_CHECK_EQUAL(d3VerifyLegacy(mutation, script), anyone);
        mutation = signedTx; mutation.vin[1].nSequence--;
        BOOST_CHECK_EQUAL(d3VerifyLegacy(mutation, script), anyone || base != SIGHASH_ALL);
        // Legacy signatures do not commit to the spent input amount.
        BOOST_CHECK(d3VerifyLegacy(signedTx, script, d3ConsensusFlags, 123 * COIN));
        BOOST_TEST_MESSAGE("d3-sighash type=" << hashType << " signed-mutations=9 checked-input=0");
    }
    CMutableTransaction outOfRange(original); outOfRange.vout.clear();
    const uint256 one = uint256S("01");
    BOOST_REQUIRE(SignatureHash(script, outOfRange, 0, SIGHASH_SINGLE, 0, SIGVERSION_BASE) == one);
    outOfRange.vin[0].scriptSig = d3Sign(key, script, outOfRange, SIGHASH_SINGLE);
    BOOST_REQUIRE(d3VerifyLegacy(outOfRange, script));
    CMutableTransaction altered(outOfRange); altered.vin[0].prevout.n++;
    BOOST_REQUIRE(d3VerifyLegacy(altered, script));
    BOOST_TEST_MESSAGE("d3-single-out-of-range constant-one=true profile-must-reject=true");
}

BOOST_FIXTURE_TEST_CASE(legacy_scriptsig_malleability_changes_funding_txid, D3BasicSetup)
{
    CKey key; key.MakeNewKey(true);
    const CScript redeem = CScript() << ToByteVector(key.GetPubKey()) << OP_CHECKSIG;
    const CScript output = GetScriptForDestination(CScriptID(redeem));
    CMutableTransaction funding;
    funding.vin.emplace_back(COutPoint(uint256S("03"), 0), CScript(), 0xfffffffe);
    funding.vout.emplace_back(100 * COIN, GetScriptForDestination(key.GetPubKey().GetID()));
    funding.vin[0].scriptSig = d3Sign(key, redeem, funding);
    funding.vin[0].scriptSig << std::vector<unsigned char>(redeem.begin(), redeem.end());
    BOOST_REQUIRE(d3VerifyLegacy(funding, output));
    BOOST_REQUIRE(d3VerifyLegacy(funding, output, STANDARD_SCRIPT_VERIFY_FLAGS));
    CMutableTransaction mutated(funding);
    const CScript& canonical = funding.vin[0].scriptSig;
    BOOST_REQUIRE(canonical[0] > 0 && canonical[0] < OP_PUSHDATA1);
    CScript nonminimal;
    nonminimal.push_back(OP_PUSHDATA1);
    nonminimal.insert(nonminimal.end(), canonical.begin(), canonical.end());
    mutated.vin[0].scriptSig = nonminimal;
    BOOST_REQUIRE(d3VerifyLegacy(mutated, output));
    BOOST_REQUIRE(!d3VerifyLegacy(mutated, output, STANDARD_SCRIPT_VERIFY_FLAGS));
    BOOST_REQUIRE(mutated.GetHash() != funding.GetHash());
    BOOST_REQUIRE(mutated.vout[0].nValue == funding.vout[0].nValue);
    BOOST_REQUIRE(mutated.vout[0].scriptPubKey == funding.vout[0].scriptPubKey);
    CMutableTransaction presignedRefund;
    presignedRefund.vin.emplace_back(COutPoint(funding.GetHash(), 0), CScript(), 0xfffffffe);
    presignedRefund.vout.emplace_back(99 * COIN, GetScriptForDestination(key.GetPubKey().GetID()));
    presignedRefund.vin[0].scriptSig = d3Sign(key, funding.vout[0].scriptPubKey, presignedRefund);
    presignedRefund.vin[0].scriptSig << ToByteVector(key.GetPubKey());
    BOOST_REQUIRE(d3VerifyLegacy(presignedRefund, funding.vout[0].scriptPubKey));
    BOOST_REQUIRE(presignedRefund.vin[0].prevout.hash != mutated.GetHash());
    BOOST_TEST_MESSAGE("d3-malleability script-consensus-valid=true standard-script=false txid-changed=true child-prevout-stale=true");
}

BOOST_AUTO_TEST_SUITE_END()
