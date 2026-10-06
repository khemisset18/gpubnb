#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL="${ROOT_DIR}/AssetExchangeV1.tla"
CONFIG="${ROOT_DIR}/AssetExchangeV1.cfg"
TLA_JAR="${TLA2TOOLS_JAR:-${ROOT_DIR}/tla2tools.jar}"
EVIDENCE_DIR="${ROOT_DIR}/evidence"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${EVIDENCE_DIR}/tlc-${STAMP}.log"

mkdir -p "${EVIDENCE_DIR}"

if [[ ! -f "${TLA_JAR}" ]]; then
  echo "ERROR: tla2tools.jar not found."
  echo "Set TLA2TOOLS_JAR=/absolute/path/to/tla2tools.jar or place a pinned copy next to this script."
  exit 2
fi

if [[ ! -f "${MODEL}" || ! -f "${CONFIG}" ]]; then
  echo "ERROR: model/config missing."
  exit 2
fi

JAVA_VERSION="$(java -version 2>&1 | head -n 1)"
JAR_SHA256="$(sha256sum "${TLA_JAR}" | awk '{print $1}')"
MODEL_SHA256="$(sha256sum "${MODEL}" | awk '{print $1}')"
CONFIG_SHA256="$(sha256sum "${CONFIG}" | awk '{print $1}')"

{
  echo "gpu.k.p2p formal verification evidence"
  echo "timestamp_utc=${STAMP}"
  echo "java=${JAVA_VERSION}"
  echo "tla2tools_sha256=${JAR_SHA256}"
  echo "model_sha256=${MODEL_SHA256}"
  echo "config_sha256=${CONFIG_SHA256}"
  echo "model=AssetExchangeV1.tla"
  echo "config=AssetExchangeV1.cfg"
  echo "--- TLC OUTPUT ---"
} | tee "${OUT}"

set +e
(
  cd "${ROOT_DIR}"
  java -XX:+UseParallelGC -cp "${TLA_JAR}" tlc2.TLC     -config AssetExchangeV1.cfg     -workers auto     AssetExchangeV1.tla
) 2>&1 | tee -a "${OUT}"
STATUS=${PIPESTATUS[0]}
set -e

echo "--- END TLC OUTPUT ---" | tee -a "${OUT}"
echo "exit_status=${STATUS}" | tee -a "${OUT}"

if [[ ${STATUS} -ne 0 ]]; then
  echo "TLC FAILED. Preserve this evidence and investigate the counterexample/error."
  exit "${STATUS}"
fi

echo "TLC completed successfully. This is bounded-model evidence, not production authorization."
