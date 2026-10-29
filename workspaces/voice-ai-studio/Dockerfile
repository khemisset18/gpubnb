# A real Whisper transcription service; TTS is NOT yet shipped or claimed.
FROM quay.io/jupyter/pytorch-notebook@sha256:de7e7da7ba3e66cd2720ff9e72c93c43d24cb83478a032862acb7520fa8b2200
USER root
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN python -m pip install --no-cache-dir openai-whisper==20250625
# Model fetched during image build, not at renter runtime (network-isolated).
RUN install -d -o jovyan -g users /opt/gpubnb-whisper /workspace \
 && python - <<'PY'
import whisper
whisper.load_model("tiny", download_root="/opt/gpubnb-whisper")
PY
COPY server.py /opt/gpubnb-voice/server.py
COPY --chmod=755 healthcheck.sh /usr/local/bin/gpubnb-voice-healthcheck
USER jovyan
WORKDIR /workspace
ENV GPUBNB_WHISPER_MODEL=/opt/gpubnb-whisper PYTHONUNBUFFERED=1
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 CMD ["/usr/local/bin/gpubnb-voice-healthcheck"]
CMD ["python", "/opt/gpubnb-voice/server.py"]
