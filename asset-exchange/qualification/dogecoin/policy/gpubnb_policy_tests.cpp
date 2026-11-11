// Diagnostic tests only, compiled against pinned Dogecoin source.
// No production implementation is replaced. No RPC or P2P listener is started.
#include "consensus/validation.h"
#include "coins.h"
#include "crypto/sha256.h"
#include "dogecoin-fees.h"
#include "policy/policy.h"
#include "script/interpreter.h"
#include "script/standard.h"
#include "test/test_bitcoin.h"
#include "validation.h"
#include <boost/test/unit_test.hpp>

struct PrivatePolicySetup : TestingSetup {
    PrivatePolicySetup() : TestingSetup(CBaseChainParams::REGTEST) {}
};

BOOST_AUTO_TEST_SUITE(gpubnb_policy)

BOOST_FIXTURE_TEST_CASE(soft_dust_boundaries, PrivatePolicySetup)
{
    BOOST_REQUIRE_EQUAL(Params().NetworkIDString(), "regtest");
    const CAmount threshold = COIN / 100;
    BOOST_REQUIRE_EQUAL(DEFAULT_DUST_LIMIT, threshold);
    const CScript spendable = CScript() << OP_HASH160 << std::vector<unsigned char>(20, 1) << OP_EQUAL;
    const CScript unspendable = CScript() << OP_RETURN << std::vector<unsigned char>(8, 2);
    for (CAmount amount : {CAmount(0), threshold - 1, threshold, threshold + 1}) {
        const CAmount expected = amount < threshold ? threshold : 0;
        const CAmount observed = GetDogecoinDustFee({CTxOut(amount, spendable)}, threshold);
        BOOST_CHECK_EQUAL(observed, expected);
        BOOST_TEST_MESSAGE("soft-dust amount=" << amount << " surcharge=" << observed);
    }
    BOOST_CHECK_EQUAL(GetDogecoinDustFee({}, threshold), 0);
    BOOST_CHECK_EQUAL(GetDogecoinDustFee({CTxOut(0, unspendable)}, threshold), 0);
    BOOST_CHECK_EQUAL(GetDogecoinDustFee({CTxOut(threshold - 1, spendable),
        CTxOut(threshold - 1, spendable), CTxOut(0, unspendable), CTxOut(threshold, spendable)}, threshold), 2 * threshold);
    BOOST_TEST_MESSAGE("soft-dust aggregate=" << 2 * threshold << "; OP_RETURN exemption verified");
}

BOOST_FIXTURE_TEST_CASE(rolling_floor_rejects_previously_admissible_spend, TestChain240Setup)
{
    BOOST_REQUIRE_EQUAL(Params().NetworkIDString(), "regtest");
    BOOST_REQUIRE_EQUAL(chainActive.Height(), 240);
    LOCK(cs_main);
    mempool.clear();
    // Regtest defaults bypass standardness. Set it explicitly for this probe.
    const bool previousStandard = fRequireStandard;
    struct RestoreStandard { bool old; ~RestoreStandard() { fRequireStandard = old; mempool.clear(); } } restore{previousStandard};
    fRequireStandard = true;
    const CAmount paidFee = COIN;
    CMutableTransaction spend;
    spend.vin.resize(1);
    spend.vin[0].prevout = COutPoint(coinbaseTxns[0].GetHash(), 0);
    const CScript destination = GetScriptForDestination(coinbaseKey.GetPubKey().GetID());
    spend.vout.emplace_back(coinbaseTxns[0].vout[0].nValue - paidFee, destination);
    std::vector<unsigned char> signature;
    const uint256 digest = SignatureHash(coinbaseTxns[0].vout[0].scriptPubKey,
        spend, 0, SIGHASH_ALL, 0, SIGVERSION_BASE);
    BOOST_REQUIRE(coinbaseKey.Sign(digest, signature));
    signature.push_back(SIGHASH_ALL);
    spend.vin[0].scriptSig << signature;
    const CTransactionRef candidate = MakeTransactionRef(spend);
    bool missing = false;
    CValidationState before;
    BOOST_REQUIRE_EQUAL(mempool.GetMinFee(5000000).GetFeePerK(), 0);
    BOOST_REQUIRE(AcceptToMemoryPool(mempool, before, candidate, false, &missing, nullptr, false, 0));
    BOOST_REQUIRE(!missing);
    BOOST_REQUIRE(mempool.exists(candidate->GetHash()));
    mempool.removeRecursive(*candidate);

    // One unchecked synthetic entry supplies a deterministic eviction rate.
    // This is a native policy probe, not a realistic network-load benchmark.
    CMutableTransaction pressure;
    pressure.vin.resize(1);
    pressure.vin[0].prevout = COutPoint(uint256S("01"), 0);
    pressure.vout.emplace_back(COIN, destination);
    TestMemPoolEntryHelper entry;
    const CAmount pressureFee = 100 * COIN;
    mempool.addUnchecked(pressure.GetHash(), entry.Fee(pressureFee).FromTx(pressure, &mempool));
    const size_t occupied = mempool.DynamicMemoryUsage();
    BOOST_REQUIRE_GT(occupied, 0);
    mempool.TrimToSize(0);
    BOOST_REQUIRE_EQUAL(mempool.size(), 0);
    const CFeeRate floor = mempool.GetMinFee(5000000);
    const CAmount expectedFloor = CFeeRate(pressureFee, GetVirtualTransactionSize(pressure)).GetFeePerK()
        + incrementalRelayFee.GetFeePerK();
    BOOST_REQUIRE_EQUAL(floor.GetFeePerK(), expectedFloor);
    const CAmount requiredFee = floor.GetFee(GetVirtualTransactionSize(*candidate));
    BOOST_REQUIRE_GT(requiredFee, paidFee);
    CValidationState after;
    missing = false;
    BOOST_CHECK(!AcceptToMemoryPool(mempool, after, candidate, false, &missing, nullptr, false, 0));
    BOOST_CHECK(!missing);
    BOOST_CHECK_EQUAL(after.GetRejectReason(), "mempool min fee not met");
    BOOST_CHECK(!mempool.exists(candidate->GetHash()));
    BOOST_TEST_MESSAGE("rolling-floor paid=" << paidFee << " required=" << requiredFee
        << " floor-per-k=" << floor.GetFeePerK() << " occupied-before=" << occupied
        << " rejection=" << after.GetRejectReason());
}

BOOST_FIXTURE_TEST_CASE(bounded_refund_rebuild_after_fee_floor_rise, TestChain240Setup)
{
    BOOST_REQUIRE_EQUAL(Params().NetworkIDString(), "regtest");
    LOCK(cs_main);
    const bool previousStandard = fRequireStandard;
    struct RestoreStandard { bool old; ~RestoreStandard() { fRequireStandard = old; } } restore{previousStandard};
    fRequireStandard = true;
    // Separate pool: the preceding probe intentionally raises its own floor.
    CTxMemPool pool(incrementalRelayFee);
    const CScript minerScript = coinbaseTxns[0].vout[0].scriptPubKey;
    while (chainActive.Height() < 1352) CreateAndProcessBlock({}, minerScript);
    BOOST_REQUIRE_GE(chainActive.Height(), Params().GetConsensus(chainActive.Height()).BIP65Height);

    CKey claimKey, refundKey;
    claimKey.MakeNewKey(true); refundKey.MakeNewKey(true);
    BOOST_REQUIRE(claimKey.GetPubKey() != refundKey.GetPubKey());
    const std::vector<unsigned char> preimage(32, 7);
    std::vector<unsigned char> commitment(32);
    CSHA256().Write(preimage.data(), preimage.size()).Finalize(commitment.data());
    const CScript redeem = CScript() << OP_IF << OP_SIZE << 32 << OP_EQUALVERIFY
        << OP_SHA256 << commitment << OP_EQUALVERIFY << ToByteVector(claimKey.GetPubKey()) << OP_CHECKSIG
        << OP_ELSE << 1351 << OP_CHECKLOCKTIMEVERIFY << OP_DROP
        << ToByteVector(refundKey.GetPubKey()) << OP_CHECKSIG << OP_ENDIF;
    const CScript contract = GetScriptForDestination(CScriptID(redeem));
    const CScript destination = GetScriptForDestination(refundKey.GetPubKey().GetID());
    const CAmount inputValue = 100 * COIN, oldFee = COIN / 100, feeCap = COIN;
    CMutableTransaction funding;
    funding.vin.emplace_back(COutPoint(coinbaseTxns[0].GetHash(), 0));
    funding.vout.emplace_back(inputValue, contract);
    funding.vout.emplace_back(coinbaseTxns[0].vout[0].nValue - inputValue - COIN,
        GetScriptForDestination(coinbaseKey.GetPubKey().GetID()));
    std::vector<unsigned char> signature;
    BOOST_REQUIRE(coinbaseKey.Sign(SignatureHash(minerScript, funding, 0, SIGHASH_ALL, 0, SIGVERSION_BASE), signature));
    signature.push_back(SIGHASH_ALL); funding.vin[0].scriptSig << signature;
    bool missing = false; CValidationState fundingState;
    BOOST_REQUIRE(AcceptToMemoryPool(pool, fundingState, MakeTransactionRef(funding), false, &missing, nullptr, false, 0));
    BOOST_REQUIRE(!missing);
    CreateAndProcessBlock({funding}, minerScript);
    BOOST_REQUIRE_EQUAL(chainActive.Height(), 1353);
    pool.removeRecursive(CTransaction(funding));
    const COutPoint outpoint(funding.GetHash(), 0);
    const CTxOut& actual = pcoinsTip->GetOutputFor(CTxIn(outpoint));
    BOOST_REQUIRE_EQUAL(actual.nValue, inputValue);
    BOOST_REQUIRE(actual.scriptPubKey == contract);

    auto makeRefund = [&](CAmount fee) {
        // Reviewable test-only budget; no unbounded automatic fee escalation.
        BOOST_REQUIRE(fee > 0 && fee <= feeCap && inputValue - fee >= DEFAULT_DUST_LIMIT);
        CMutableTransaction tx;
        tx.nLockTime = 1351;
        tx.vin.emplace_back(outpoint, CScript(), 0xfffffffe);
        tx.vout.emplace_back(inputValue - fee, destination);
        std::vector<unsigned char> sig;
        BOOST_REQUIRE(refundKey.Sign(SignatureHash(redeem, tx, 0, SIGHASH_ALL, 0, SIGVERSION_BASE), sig));
        sig.push_back(SIGHASH_ALL);
        tx.vin[0].scriptSig << sig << OP_FALSE << std::vector<unsigned char>(redeem.begin(), redeem.end());
        return tx;
    };
    const CMutableTransaction original = makeRefund(oldFee);
    CValidationState originalState;
    BOOST_REQUIRE(AcceptToMemoryPool(pool, originalState, MakeTransactionRef(original), false, &missing, nullptr, false, 0));
    BOOST_REQUIRE(!missing);
    pool.removeRecursive(CTransaction(original));

    // Reuse the bounded native eviction mechanism; this is not a relay-load test.
    CMutableTransaction pressure;
    pressure.vin.emplace_back(COutPoint(uint256S("02"), 0));
    pressure.vout.emplace_back(COIN, destination);
    TestMemPoolEntryHelper entry;
    pool.addUnchecked(pressure.GetHash(), entry.Fee(COIN / 10).FromTx(pressure, &pool));
    pool.TrimToSize(0);
    const CFeeRate floor = pool.GetMinFee(5000000);
    BOOST_REQUIRE_GT(floor.GetFee(GetVirtualTransactionSize(original)), oldFee);
    CValidationState rejected;
    BOOST_REQUIRE(!AcceptToMemoryPool(pool, rejected, MakeTransactionRef(original), false, &missing, nullptr, false, 0));
    BOOST_REQUIRE(!missing);
    BOOST_REQUIRE_EQUAL(rejected.GetRejectReason(), "mempool min fee not met");
    BOOST_REQUIRE(pcoinsTip->GetOutputFor(CTxIn(outpoint)).scriptPubKey == contract);

    const CMutableTransaction rebuilt = makeRefund(feeCap);
    const CAmount required = floor.GetFee(GetVirtualTransactionSize(rebuilt));
    BOOST_REQUIRE_LE(required, feeCap);
    BOOST_REQUIRE(rebuilt.GetHash() != original.GetHash());
    BOOST_REQUIRE(rebuilt.vin[0].prevout == original.vin[0].prevout);
    BOOST_REQUIRE(rebuilt.vout[0].scriptPubKey == original.vout[0].scriptPubKey);
    BOOST_REQUIRE_EQUAL(rebuilt.nLockTime, original.nLockTime);
    BOOST_REQUIRE_EQUAL(rebuilt.vin[0].nSequence, original.vin[0].nSequence);
    CValidationState accepted;
    BOOST_REQUIRE(AcceptToMemoryPool(pool, accepted, MakeTransactionRef(rebuilt), false, &missing, nullptr, false, 0));
    BOOST_REQUIRE(!missing && pool.exists(rebuilt.GetHash()) && !pool.exists(original.GetHash()));
    CreateAndProcessBlock({rebuilt}, minerScript);
    BOOST_REQUIRE_EQUAL(chainActive.Height(), 1354);
    const CCoins* coins = pcoinsTip->AccessCoins(funding.GetHash());
    BOOST_REQUIRE(coins && !coins->IsAvailable(0));
    const CCoins* recovered = pcoinsTip->AccessCoins(rebuilt.GetHash());
    BOOST_REQUIRE(recovered && recovered->IsAvailable(0));
    BOOST_REQUIRE_EQUAL(recovered->vout[0].nValue, inputValue - feeCap);
    BOOST_REQUIRE(recovered->vout[0].scriptPubKey == destination);
    BOOST_TEST_MESSAGE("bounded-refund old-fee=" << oldFee << " required=" << required
        << " selected-fee=" << feeCap << " cap=" << feeCap << " refund=" << inputValue - feeCap
        << " blocks=" << chainActive.Height() << " rejection=" << rejected.GetRejectReason());
}

BOOST_AUTO_TEST_SUITE_END()
