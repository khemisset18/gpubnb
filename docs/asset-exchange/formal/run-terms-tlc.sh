#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL="${ROOT_DIR}/AssetExchangeTermsV1.tla"
CONFIG="${ROOT_DIR}/AssetExchangeTermsV1.cfg"
TLA_JAR="${TLA2TOOLS_JAR:-${ROOT_DIR}/tla2tools.jar}"
EVIDENCE_DIR="${ROOT_DIR}/evidence"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${EVIDENCE_DIR}/tlc-terms-immutability-${STAMP}.log"

mkdir -p "${EVIDENCE_DIR}"
[[ -f "${TLA_JAR}" ]] || { echo "ERROR: tla2tools.jar not found"; exit 2; }
[[ -f "${MODEL}" ]] || { echo "ERROR: terms model missing"; exit 2; }
[[ -f "${CONFIG}" ]] || { echo "ERROR: terms config missing"; exit 2; }

{
  echo "gpu.k.p2p terms-immutability verification evidence"
  echo "timestamp_utc=${STAMP}"
  echo "scenario=terms-immutability"
  echo "tla2tools_sha256=$(sha256sum "${TLA_JAR}" | awk '{print $1}')"
  echo "model_sha256=$(sha256sum "${MODEL}" | awk '{print $1}')"
  echo "config_sha256=$(sha256sum "${CONFIG}" | awk '{print $1}')"
  echo "--- TLC OUTPUT ---"
} | tee "${OUT}"

set +e
(
  cd "${ROOT_DIR}"
  java -XX:+UseParallelGC -cp "${TLA_JAR}" tlc2.TLC     -config "AssetExchangeTermsV1.cfg"     -workers auto     AssetExchangeTermsV1.tla
) 2>&1 | tee -a "${OUT}"
STATUS=${PIPESTATUS[0]}
set -e

echo "exit_status=${STATUS}" | tee -a "${OUT}"
exit "${STATUS}"
