from pathlib import Path
import atexit


def normalize_generated_transport() -> None:
    path = Path("services/edge/src/transport.rs")
    if not path.exists():
        return
    text = path.read_text(encoding="utf-8")
    redundant = "        assert!(STREAM_CREDIT_REPLENISHMENT_RESERVE > MAX_BIDI_STREAMS / 8);\n"
    if redundant in text:
        path.write_text(text.replace(redundant, "", 1), encoding="utf-8")


atexit.register(normalize_generated_transport)
