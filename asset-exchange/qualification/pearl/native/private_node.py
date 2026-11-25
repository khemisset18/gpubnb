"""Own a pinned pearld and an isolated data directory. RPC accepts only loopback."""
import base64
import hashlib
import http.client
import json
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import time
from decimal import Decimal
from contextlib import contextmanager

GENESIS = "78d0ab27df6a51a8e9dbbdefffca1ebbbeb3818cb083ce2c2f43b047247e5832"
MAGIC = {"regtest": 0x50524C52, "simnet": 0x50524C53}
DAEMON = "bd025be5b17dbe9b1f224f5bd5aadd1bd74406073e956a7847dc9d07782bcca9"


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def record(case, **fields):
    print(json.dumps({"case": case, **fields}, sort_keys=True), flush=True)


class RpcError(Exception):
    pass


class Node:
    def __init__(self, process, port, password):
        self.proc = process
        self.port = port
        self.auth = base64.b64encode(("lab:" + password).encode()).decode()

    def rpc(self, method, *params, timeout=40):
        require(self.proc.poll() is None, "owned pearld has exited")
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        try:
            conn.request("POST", "/", json.dumps({"jsonrpc": "1.0", "id": 1, "method": method,
                         "params": params}), {"Content-Type": "application/json",
                         "Authorization": "Basic " + self.auth})
            result = json.loads(conn.getresponse().read(), parse_float=Decimal)
        finally:
            conn.close()
        if result["error"]:
            raise RpcError(result["error"])
        return result["result"]


@contextmanager
def private_node(binary, directory, network, payout, *, existing=False, standard=True, relay_grains_per_kvb=1_000):
    require(network in MAGIC, "only private lab networks supported")
    require(relay_grains_per_kvb in (1_000, 11_000, 20_000), "unsupported lab relay policy")
    with Path(binary).open("rb") as binary_file:
        require(hashlib.file_digest(binary_file, "sha256").hexdigest() == DAEMON, "unverified pearld")
    if not existing:
        directory.mkdir(mode=0o700)
    secret = secrets.token_hex(32)
    with socket.socket() as reserved, socket.socket() as port_probe:
        # Keep this local port bound and non-listening for the entire test. With
        # --connect set, it is the only possible outbound P2P destination.
        reserved.bind(("127.0.0.1", 0))
        port_probe.bind(("127.0.0.1", 0))
        port = port_probe.getsockname()[1]
        port_probe.close()
        config = directory / "node.conf"
        config.write_text("rpcuser=lab\nrpcpass=" + secret + "\n")
        config.chmod(0o600)
        cmd = [str(Path(binary).resolve()), "--" + network, "--configfile=" + str(config),
               "--datadir=" + str(directory / "data"), "--logdir=" + str(directory / "logs"),
               "--rpclisten=127.0.0.1:" + str(port), "--notls", "--nolisten", "--noonion",
               "--nodnsseed", "--connect=127.0.0.1:" + str(reserved.getsockname()[1]),
               "--txindex", "--miningaddr=" + payout]
        if standard:
            cmd.append("--rejectnonstd")
        if relay_grains_per_kvb != 1_000:
            cmd.append(f"--minrelaytxfee={Decimal(relay_grains_per_kvb)/100_000_000:.8f}")
        clean_env = {"HOME": str(directory), "LC_ALL": "C", "RAYON_NUM_THREADS": "6",
                     "GOMAXPROCS": "2", "TMPDIR": str(directory)}
        with (directory / "console.log").open("a") as log:
            proc = subprocess.Popen(cmd, stdout=log, stderr=log, env=clean_env, cwd=directory)
            client = Node(proc, port, secret)
            try:
                for _ in range(300):
                    if proc.poll() is not None:
                        raise RuntimeError((directory / "console.log").read_text()[-2000:])
                    try:
                        info = client.rpc("getblockchaininfo")
                        break
                    except (ConnectionError, OSError, http.client.HTTPException):
                        time.sleep(.1)
                else:
                    raise RuntimeError("RPC startup deadline")
                magic = client.rpc("getcurrentnet")
                genesis = client.rpc("getblockhash", 0)
                peers = client.rpc("getconnectioncount")
                require((info["chain"], magic, genesis, peers) == (network, MAGIC[network], GENESIS, 0),
                        f"network identity mismatch {info['chain']} {magic} {genesis} {peers}")
                require(existing or info["blocks"] == 0, "fresh node has unexpected state")
                record("identity", network=network, magic=hex(magic), genesis=genesis,
                       height=info["blocks"], peers=peers, restart=existing, rejectnonstd=standard)
                yield client
            finally:
                if proc.poll() is None:
                    proc.send_signal(signal.SIGINT)
                    try:
                        proc.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait()
                record("node-stopped", network=network, exit=proc.returncode)
