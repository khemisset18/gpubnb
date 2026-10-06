#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL="${ROOT_DIR}/AssetExchangeFaultsV1.tla"
TLA_JAR="${TLA2TOOLS_JAR:-${ROOT_DIR}/tla2tools.jar}"
EVIDENCE_DIR="${ROOT_DIR}/evidence"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CONFIGS=("AssetExchangeFaultsV1.cfg" "AssetExchangeFaultsV1.crash.cfg")
FINAL_STATUS=0

mkdir -p "${EVIDENCE_DIR}"
[[ -f "${TLA_JAR}" ]] || { echo "ERROR: tla2tools.jar not found"; exit 2; }
[[ -f "${MODEL}" ]] || { echo "ERROR: fault model missing"; exit 2; }

for config in "${CONFIGS[@]}"; do
  [[ -f "${ROOT_DIR}/${config}" ]] || { echo "ERROR: missing ${config}"; exit 2; }
  label="${config#AssetExchangeFaultsV1.}"
  label="${label%.cfg}"
  [[ "${config}" == "AssetExchangeFaultsV1.cfg" ]] && label="fault-safety"
  OUT="${EVIDENCE_DIR}/tlc-${label}-${STAMP}.log"
  {
    echo "gpu.k.p2p fault-model verification evidence"
    echo "timestamp_utc=${STAMP}"
    echo "scenario=${label}"
    echo "tla2tools_sha256=$(sha256sum "${TLA_JAR}" | awk '{print $1}')"
    echo "model_sha256=$(sha256sum "${MODEL}" | awk '{print $1}')"
    echo "config_sha256=$(sha256sum "${ROOT_DIR}/${config}" | awk '{print $1}')"
    echo "--- TLC OUTPUT ---"
  } | tee "${OUT}"

  set +e
  (
    cd "${ROOT_DIR}"
    java -XX:+UseParallelGC -cp "${TLA_JAR}" tlc2.TLC       -config "${config}"       -workers auto       AssetExchangeFaultsV1.tla
  ) 2>&1 | tee -a "${OUT}"
  STATUS=${PIPESTATUS[0]}
  set -e

  echo "exit_status=${STATUS}" | tee -a "${OUT}"
  if [[ ${STATUS} -ne 0 ]]; then FINAL_STATUS=${STATUS}; fi
done

exit "${FINAL_STATUS}"
