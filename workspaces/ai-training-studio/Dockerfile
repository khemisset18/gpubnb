# GPU training candidate: no external dataset/model downloads during rentals.
FROM quay.io/jupyter/pytorch-notebook@sha256:de7e7da7ba3e66cd2720ff9e72c93c43d24cb83478a032862acb7520fa8b2200
USER root
RUN python -m pip install --no-cache-dir \
  "transformers==4.56.2" "accelerate==1.10.1" "peft==0.17.1"
COPY lora-smoke.py /opt/gpubnb-training/lora-smoke.py
COPY --chmod=755 entrypoint.sh /usr/local/bin/gpubnb-training-entrypoint
COPY --chmod=755 healthcheck.sh /usr/local/bin/gpubnb-training-healthcheck
RUN install -d -o jovyan -g users -m 0750 /workspace
USER jovyan
WORKDIR /workspace
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 CMD ["/usr/local/bin/gpubnb-training-healthcheck"]
ENTRYPOINT ["/usr/local/bin/gpubnb-training-entrypoint"]
