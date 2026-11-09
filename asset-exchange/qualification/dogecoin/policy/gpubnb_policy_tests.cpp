// Diagnostic tests only, compiled against pinned Dogecoin source.
// No production implementation is replaced. No RPC or P2P listener is started.
#include "consensus/validation.h"
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

BOOST_AUTO_TEST_SUITE_END()
