// Diagnostic tests against unchanged Dogecoin 1.14.9 implementations.
// Strategies: pinned upstream qa/rpc-tests/replace-by-fee.py (MIT).
// Uses the native serializer, signer, interpreter, UTXO set and global mempool.
// No wallet/RPC/P2P listener. Test keys never leave this disposable process.
#include "chainparams.h"
#include "consensus/validation.h"
#include "policy/policy.h"
#include "script/interpreter.h"
#include "script/standard.h"
#include "test/test_bitcoin.h"
#include "validation.h"
#include <boost/test/unit_test.hpp>

struct RbfBoundarySetup : TestChain240Setup {
    bool previousStandard;
    CScript destination;
    unsigned int signedFixtures = 0, signatures = 0, admissions = 0;

    RbfBoundarySetup() : previousStandard(fRequireStandard),
        destination(coinbaseTxns[0].vout[0].scriptPubKey) {
        BOOST_REQUIRE_EQUAL(Params().NetworkIDString(), "regtest");
        BOOST_REQUIRE_EQUAL(chainActive.Height(), 240);
        BOOST_REQUIRE(fEnableReplacement);
        mempool.clear();
        BOOST_REQUIRE_EQUAL(mempool.GetMinFee(5000000).GetFeePerK(), 0);
        fRequireStandard = true;
    }
    ~RbfBoundarySetup() { mempool.clear(); fRequireStandard = previousStandard; }

    CMutableTransaction Spend(const std::vector<COutPoint>& inputs,
                              const std::vector<CAmount>& values, CAmount fee) {
        BOOST_REQUIRE(!inputs.empty() && inputs.size() <= 101 && inputs.size() == values.size());
        BOOST_REQUIRE(++signedFixtures <= 103);
        BOOST_REQUIRE(signatures + inputs.size() <= 302);
        signatures += inputs.size();
        BOOST_REQUIRE(fee > 0 && fee <= 202 * COIN);
        CAmount total = 0;
        CMutableTransaction tx;
        for (size_t i = 0; i < inputs.size(); ++i) {
            BOOST_REQUIRE(values[i] > 0 && MoneyRange(values[i]));
            total += values[i];
            BOOST_REQUIRE(MoneyRange(total));
            tx.vin.emplace_back(inputs[i], CScript(), 0xfffffffd);
        }
        BOOST_REQUIRE(total - fee >= COIN);
        tx.vout.emplace_back(total - fee, destination);
        for (size_t i = 0; i < inputs.size(); ++i) {
            std::vector<unsigned char> sig;
            BOOST_REQUIRE(coinbaseKey.Sign(SignatureHash(destination, tx, i,
                SIGHASH_ALL, 0, SIGVERSION_BASE), sig));
            sig.push_back(SIGHASH_ALL);
            tx.vin[i].scriptSig << sig;
        }
        // Establish script validity even when policy rejects before CheckInputs.
        const CTransaction immutable(tx);
        const CScriptWitness emptyWitness;
        for (size_t i = 0; i < inputs.size(); ++i) {
            ScriptError error = SCRIPT_ERR_UNKNOWN_ERROR;
            BOOST_REQUIRE(VerifyScript(tx.vin[i].scriptSig, destination, &emptyWitness,
                STANDARD_SCRIPT_VERIFY_FLAGS,
                TransactionSignatureChecker(&immutable, i, values[i]), &error));
            BOOST_REQUIRE_EQUAL(error, SCRIPT_ERR_OK);
        }
        return tx;
    }

    bool Admit(const CMutableTransaction& tx, CValidationState& state) {
        BOOST_REQUIRE(++admissions <= 103);
        bool missing = false;
        const bool admitted = AcceptToMemoryPool(mempool, state, MakeTransactionRef(tx),
            false, &missing, nullptr, false, 0);
        BOOST_REQUIRE(!missing);
        BOOST_REQUIRE_LE(mempool.size(), 101);
        return admitted;
    }
};

BOOST_AUTO_TEST_SUITE(gpubnb_rbf)

BOOST_FIXTURE_TEST_CASE(replacement_count_100_101, RbfBoundarySetup)
{
    LOCK(cs_main);
    std::vector<CMutableTransaction> originals;
    std::vector<COutPoint> inputs;
    std::vector<CAmount> values;
    for (unsigned int i = 0; i < 101; ++i) {
        inputs.emplace_back(coinbaseTxns[i].GetHash(), 0);
        values.push_back(coinbaseTxns[i].vout[0].nValue);
        const CTxOut& actual = pcoinsTip->GetOutputFor(CTxIn(inputs.back()));
        BOOST_REQUIRE(actual.scriptPubKey == destination);
        BOOST_REQUIRE_EQUAL(actual.nValue, values.back());
        originals.push_back(Spend({inputs.back()}, {values.back()}, COIN));
        CValidationState accepted;
        BOOST_REQUIRE(Admit(originals.back(), accepted));
    }
    BOOST_REQUIRE_EQUAL(mempool.size(), 101);
    const CMutableTransaction tooMany = Spend(inputs, values, 202 * COIN);
    CValidationState rejected;
    BOOST_REQUIRE(!Admit(tooMany, rejected));
    BOOST_REQUIRE_EQUAL(rejected.GetRejectReason(), "too many potential replacements");
    BOOST_REQUIRE_EQUAL(rejected.GetRejectCode(), REJECT_NONSTANDARD);
    BOOST_REQUIRE_EQUAL(mempool.size(), 101);
    BOOST_REQUIRE(!mempool.exists(tooMany.GetHash()));
    for (const auto& original : originals) BOOST_REQUIRE(mempool.exists(original.GetHash()));

    // Same confirmed funding family, correctly recalculated amount/signatures.
    // No oversized fees caused by merely deleting an input from old bytes.
    inputs.pop_back(); values.pop_back();
    const CMutableTransaction boundary = Spend(inputs, values, 200 * COIN);
    CValidationState accepted;
    BOOST_REQUIRE(Admit(boundary, accepted));
    BOOST_REQUIRE_EQUAL(mempool.size(), 2);
    BOOST_REQUIRE(mempool.exists(boundary.GetHash()));
    BOOST_REQUIRE(mempool.exists(originals.back().GetHash()));
    for (unsigned int i = 0; i < 100; ++i) BOOST_REQUIRE(!mempool.exists(originals[i].GetHash()));
    BOOST_TEST_MESSAGE("rbf-count rejected=101 accepted=100 native-code=" << rejected.GetRejectCode()
        << " reason=" << rejected.GetRejectReason() << " pool-after-reject=101 pool-after-accept=2"
        << " global-pool=true standardness=true blocks=" << chainActive.Height()
        << " signed-fixtures=" << signedFixtures << " signatures=" << signatures << " admissions=" << admissions);
}

BOOST_FIXTURE_TEST_CASE(new_input_unconfirmed_then_confirmed, RbfBoundarySetup)
{
    LOCK(cs_main);
    const COutPoint first(coinbaseTxns[0].GetHash(), 0), second(coinbaseTxns[1].GetHash(), 0);
    const CAmount firstValue = coinbaseTxns[0].vout[0].nValue;
    const CAmount secondValue = coinbaseTxns[1].vout[0].nValue;
    const CMutableTransaction original = Spend({first}, {firstValue}, COIN);
    const CMutableTransaction parent = Spend({second}, {secondValue}, COIN);
    const CMutableTransaction replacement = Spend({first, COutPoint(parent.GetHash(), 0)},
        {firstValue, parent.vout[0].nValue}, 4 * COIN);
    const uint256 before = replacement.GetHash();
    CValidationState originalState, parentState;
    BOOST_REQUIRE(Admit(original, originalState));
    BOOST_REQUIRE(Admit(parent, parentState));
    BOOST_REQUIRE_EQUAL(mempool.size(), 2);
    CValidationState rejected;
    BOOST_REQUIRE(!Admit(replacement, rejected));
    BOOST_REQUIRE_EQUAL(rejected.GetRejectReason(), "replacement-adds-unconfirmed");
    BOOST_REQUIRE_EQUAL(rejected.GetRejectCode(), REJECT_NONSTANDARD);
    BOOST_REQUIRE_EQUAL(mempool.size(), 2);
    BOOST_REQUIRE(mempool.exists(original.GetHash()) && mempool.exists(parent.GetHash()));

    // The fixture mines only the new parent, leaving the original pending.
    // Retry the identical already-signed candidate after its new input confirms.
    CreateAndProcessBlock({parent}, destination);
    BOOST_REQUIRE_EQUAL(chainActive.Height(), 241);
    BOOST_REQUIRE(!mempool.exists(parent.GetHash()) && mempool.exists(original.GetHash()));
    const CTxOut& confirmed = pcoinsTip->GetOutputFor(CTxIn(COutPoint(parent.GetHash(), 0)));
    BOOST_REQUIRE(confirmed.scriptPubKey == destination);
    BOOST_REQUIRE_EQUAL(confirmed.nValue, parent.vout[0].nValue);
    CValidationState accepted;
    BOOST_REQUIRE(Admit(replacement, accepted));
    BOOST_REQUIRE(replacement.GetHash() == before);
    BOOST_REQUIRE_EQUAL(mempool.size(), 1);
    BOOST_REQUIRE(mempool.exists(before) && !mempool.exists(original.GetHash()));
    BOOST_TEST_MESSAGE("rbf-new-input unconfirmed=rejected confirmed=accepted identical-signed-bytes=true"
        << " native-code=" << rejected.GetRejectCode() << " reason=" << rejected.GetRejectReason()
        << " pool-after-reject=2 pool-after-accept=1 global-pool=true standardness=true blocks="
        << chainActive.Height() << " signed-fixtures=" << signedFixtures << " signatures=" << signatures
        << " admissions=" << admissions);
}

BOOST_AUTO_TEST_SUITE_END()
