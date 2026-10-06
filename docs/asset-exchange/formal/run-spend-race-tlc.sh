#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL="${ROOT_DIR}/AssetExchangeSpendRaceV1.tla"
TLA_JAR="${TLA2TOOLS_JAR:-${ROOT_DIR}/tla2tools.jar}"
EVIDENCE_DIR="${ROOT_DIR}/evidence"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CONFIGS=("AssetExchangeSpendRaceV1.cfg" "AssetExchangeSpendRaceV1.race.cfg")
FINAL_STATUS=0

mkdir -p "${EVIDENCE_DIR}"
[[ -f "${TLA_JAR}" ]] || { echo "ERROR: tla2tools.jar not found"; exit 2; }
[[ -f "${MODEL}" ]] || { echo "ERROR: spend-race model missing"; exit 2; }

for config in "${CONFIGS[@]}"; do
  [[ -f "${ROOT_DIR}/${config}" ]] || { echo "ERROR: missing ${config}"; exit 2; }
  label="${config#AssetExchangeSpendRaceV1.}"
  label="${label%.cfg}"
  [[ "${config}" == "AssetExchangeSpendRaceV1.cfg" ]] && label="spend-race-safety"
  OUT="${EVIDENCE_DIR}/tlc-${label}-${STAMP}.log"

  {
    echo "gpu.k.p2p spend-race verification evidence"
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
    java -XX:+UseParallelGC -cp "${TLA_JAR}" tlc2.TLC       -config "${config}"       -workers auto       AssetExchangeSpendRaceV1.tla
  ) 2>&1 | tee -a "${OUT}"
  STATUS=${PIPESTATUS[0]}
  set -e

  echo "exit_status=${STATUS}" | tee -a "${OUT}"
  if [[ ${STATUS} -ne 0 ]]; then FINAL_STATUS=${STATUS}; fi
done

exit "${FINAL_STATUS}"
