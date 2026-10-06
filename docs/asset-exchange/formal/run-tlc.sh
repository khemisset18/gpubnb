#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL="${ROOT_DIR}/AssetExchangeV1.tla"
TLA_JAR="${TLA2TOOLS_JAR:-${ROOT_DIR}/tla2tools.jar}"
EVIDENCE_DIR="${ROOT_DIR}/evidence"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CONFIGS=(
  "AssetExchangeV1.cfg"
  "AssetExchangeV1.cooperative.cfg"
  "AssetExchangeV1.recovery.cfg"
  "AssetExchangeV1.transition.cfg"
)

mkdir -p "${EVIDENCE_DIR}"

if [[ ! -f "${TLA_JAR}" ]]; then
  echo "ERROR: tla2tools.jar not found."
  exit 2
fi
if [[ ! -f "${MODEL}" ]]; then
  echo "ERROR: model missing."
  exit 2
fi
for config in "${CONFIGS[@]}"; do
  [[ -f "${ROOT_DIR}/${config}" ]] || { echo "ERROR: missing ${config}"; exit 2; }
done

JAVA_VERSION="$(java -version 2>&1 | head -n 1)"
JAR_SHA256="$(sha256sum "${TLA_JAR}" | awk '{print $1}')"
MODEL_SHA256="$(sha256sum "${MODEL}" | awk '{print $1}')"
FINAL_STATUS=0

for config in "${CONFIGS[@]}"; do
  label="${config#AssetExchangeV1.}"
  label="${label%.cfg}"
  [[ "${config}" == "AssetExchangeV1.cfg" ]] && label="safety"
  CONFIG_SHA256="$(sha256sum "${ROOT_DIR}/${config}" | awk '{print $1}')"
  OUT="${EVIDENCE_DIR}/tlc-${label}-${STAMP}.log"

  {
    echo "gpu.k.p2p formal verification evidence"
    echo "timestamp_utc=${STAMP}"
    echo "scenario=${label}"
    echo "java=${JAVA_VERSION}"
    echo "tla2tools_sha256=${JAR_SHA256}"
    echo "model_sha256=${MODEL_SHA256}"
    echo "config_sha256=${CONFIG_SHA256}"
    echo "model=AssetExchangeV1.tla"
    echo "config=${config}"
    echo "--- TLC OUTPUT ---"
  } | tee "${OUT}"

  set +e
  (
    cd "${ROOT_DIR}"
    java -XX:+UseParallelGC -cp "${TLA_JAR}" tlc2.TLC       -config "${config}"       -workers auto       AssetExchangeV1.tla
  ) 2>&1 | tee -a "${OUT}"
  STATUS=${PIPESTATUS[0]}
  set -e

  echo "--- END TLC OUTPUT ---" | tee -a "${OUT}"
  echo "exit_status=${STATUS}" | tee -a "${OUT}"

  if [[ ${STATUS} -ne 0 ]]; then
    FINAL_STATUS=${STATUS}
    echo "TLC scenario ${label} FAILED."
  else
    echo "TLC scenario ${label} completed successfully."
  fi
done

if [[ ${FINAL_STATUS} -ne 0 ]]; then
  echo "One or more formal scenarios failed."
  exit "${FINAL_STATUS}"
fi

echo "All configured safety/liveness scenarios completed successfully."
echo "Bounded evidence under explicit fairness assumptions; not production authorization."
