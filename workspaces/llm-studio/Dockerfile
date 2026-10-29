# Isolated inference candidate: the exact model revision must be explicitly
# supplied and its model-card license reviewed before anyone builds this.
FROM quay.io/jupyter/pytorch-notebook@sha256:de7e7da7ba3e66cd2720ff9e72c93c43d24cb83478a032862acb7520fa8b2200
USER root
ARG TRANSFORMERS_VERSION=4.56.2
ARG ACCELERATE_VERSION=1.10.1
RUN python -m pip install --no-cache-dir "transformers==$TRANSFORMERS_VERSION" "accelerate==$ACCELERATE_VERSION" "huggingface-hub==0.35.0"
ARG MODEL_REPO="HuggingFaceTB/SmolLM2-135M-Instruct"
ARG MODEL_COMMIT
RUN test -n "$MODEL_COMMIT" \
 && printf '%s' "$MODEL_COMMIT" | grep -Eq '^[a-f0-9]{40}$' \
 && MODEL_REPO="$MODEL_REPO" MODEL_COMMIT="$MODEL_COMMIT" python - <<'PY'
import os
from huggingface_hub import snapshot_download
snapshot_download(repo_id=os.environ["MODEL_REPO"], revision=os.environ["MODEL_COMMIT"],
                  local_dir="/opt/gpubnb-llm/model", allow_patterns=["*.json", "*.safetensors", "*.model", "*.txt", "*.tiktoken"])
PY
COPY server.py /opt/gpubnb-llm/server.py
COPY --chmod=755 healthcheck.sh /usr/local/bin/gpubnb-llm-healthcheck
RUN install -d -o jovyan -g users -m 0750 /workspace && chown -R jovyan:users /opt/gpubnb-llm
USER jovyan
WORKDIR /workspace
ENV GPUBNB_LLM_MODEL=/opt/gpubnb-llm/model PYTHONUNBUFFERED=1 TRANSFORMERS_OFFLINE=1 HF_HUB_OFFLINE=1
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 CMD ["/usr/local/bin/gpubnb-llm-healthcheck"]
CMD ["python", "/opt/gpubnb-llm/server.py"]
