"""Run the Pearl SQL campaign against a cluster created and destroyed by this process."""
import argparse
import hashlib
import os
from pathlib import Path
import secrets
import signal
import shutil
import socket
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]


def run(argv, env, **options):
    return subprocess.run(argv, env=env, cwd=ROOT, text=True, check=True, **options)


def migration_replay_cases(env):
    cli = ["psql", "-XwAtq", "-v", "ON_ERROR_STOP=1"]
    catalogue = """
      SELECT pg_get_functiondef(oid) FROM pg_proc WHERE pronamespace='asset_exchange'::regnamespace ORDER BY oid;
      SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid IN
        (SELECT oid FROM pg_class WHERE relnamespace='asset_exchange'::regnamespace) ORDER BY oid;
      SELECT to_jsonb(o) FROM asset_exchange.offers o ORDER BY offer_id;
      SELECT to_jsonb(t) FROM asset_exchange.trades t ORDER BY trade_id;
      SELECT to_jsonb(e) FROM asset_exchange.trade_events e ORDER BY event_id;
      SELECT to_jsonb(i) FROM asset_exchange.idempotency_records i ORDER BY scope,idempotency_key;"""
    before = run(cli, env, input=catalogue, capture_output=True).stdout
    migrations = ROOT / "asset-exchange/db/migrations"
    once = next(migrations.glob("010_*.sql"))
    repeat = subprocess.run([*cli, "-v", "VERBOSITY=verbose", "-f", once], env=env, cwd=ROOT,
                            text=True, capture_output=True)
    if repeat.returncode != 3 or "42723:" not in repeat.stderr:
        raise RuntimeError("unexpected result repeating one-time migration 010")
    for prefix in ("011", "012"):
        run([*cli, "-f", next(migrations.glob(prefix + "_*.sql"))], env, stdout=subprocess.DEVNULL)
    after = run(cli, env, input=catalogue, capture_output=True).stdout
    if before != after:
        raise RuntimeError("repeating the migrations changed the catalogue or fixture rows")
    print("PASS 010 repeat rejected atomically (42723); 011 and 012 replay; catalogue/row SHA256=" +
          hashlib.sha256(after.encode()).hexdigest(), flush=True)


def client_loss_cases(env):
    """Kill a client inside a transaction, then retry a committed request from a new session."""
    cli = ["psql", "-XwAtq", "-v", "ON_ERROR_STOP=1"]
    run([*cli, "-f", "asset-exchange/db/test/fixture.sql"], env, stdout=subprocess.DEVNULL)
    accept = """SELECT * FROM asset_exchange.accept_offer_atomic('ae-test-01',
        'offer-00000001','loss-trade-001','taker:loss',repeat('a',64),7,
        repeat('c',64),decode('aa','hex'),'client-loss-retry-01',repeat('b',64));"""
    client = subprocess.Popen(cli, env=env, cwd=ROOT, text=True, stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE)
    try:
        client.stdin.write("BEGIN;\n" + accept + "\n")
        client.stdin.flush()
        if client.stdout.readline().strip() != "CONSUMED|loss-trade-001":
            raise RuntimeError("uncommitted acceptance did not execute")
    finally:
        client.kill()
        client.wait(timeout=10)
        client.stdin.close()
        client.stdout.close()
    check = run(cli, env, input="""SELECT state FROM asset_exchange.offers
        WHERE offer_id='offer-00000001' FOR UPDATE;
        SELECT count(*) FROM asset_exchange.trades;
        SELECT count(*) FROM asset_exchange.trade_events;
        SELECT count(*) FROM asset_exchange.idempotency_records;""", capture_output=True)
    if check.stdout.splitlines() != ["OPEN", "0", "0", "0"]:
        raise RuntimeError("client loss left partial acceptance")
    # The application discards the first committed response, as after response loss.
    run(cli, env, input=accept, stdout=subprocess.DEVNULL)
    check = run(cli, env, input=accept + """
        SELECT count(*) FROM asset_exchange.trades;
        SELECT count(*) FROM asset_exchange.trade_events;
        SELECT count(*) FROM asset_exchange.idempotency_records;""", capture_output=True)
    if check.stdout.splitlines() != ["CONSUMED|loss-trade-001", "1", "1", "1"]:
        raise RuntimeError("post-commit retry lost or duplicated durable evidence")
    print("PASS client loss before COMMIT and retry after discarded committed reply", flush=True)


def campaign(bindir, work, driver=None):
    data = work / "data"
    password = secrets.token_hex(32)
    pwfile = work / "bootstrap-password"
    pwfile.write_text(password)
    pwfile.chmod(0o600)
    role = "prl_lab_owner"
    database = "prl_scratch_" + secrets.token_hex(8)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = str(sock.getsockname()[1])
    env = {"PATH": str(bindir) + os.pathsep + os.defpath, "LC_ALL": "C", "TMPDIR": str(work),
           "PGHOST": "127.0.0.1", "PGPORT": port, "PGUSER": "prl_bootstrap",
           "PGDATABASE": "postgres", "PGCONNECT_TIMEOUT": "3", "PGSSLMODE": "disable",
           "PGPASSWORD": password}
    version = run(["postgres", "--version"], env, capture_output=True).stdout.strip()
    if int(version.split()[-1].split(".")[0]) < 16:
        raise RuntimeError("requires PostgreSQL 16+")
    run(["initdb", "-D", data, "-U", env["PGUSER"], "--pwfile", pwfile, "--auth=scram-sha-256",
         "--no-locale", "--encoding=UTF8"], env, stdout=subprocess.DEVNULL)
    pwfile.unlink()
    control = run(["pg_controldata", data], env, capture_output=True).stdout.splitlines()
    system_id = next(line.split(":")[1].strip() for line in control
                     if line.startswith("Database system identifier:"))
    def api_phase(phase):
        if driver is not None:
            node = shutil.which("node")
            if not node:
                raise RuntimeError("Node.js is required for the optional API bridge")
            run([node, "asset-exchange/db/test/prl_api_postgres.mjs", driver, phase, work, system_id], env)

    print(f"initdb {version} system_identifier={system_id} database={database} mode={work.stat().st_mode & 0o777:o}", flush=True)
    def query(sql):
        return run(["psql", "-XwAtq", "-v", "ON_ERROR_STOP=1"], env,
                   input=sql, capture_output=True).stdout.strip()
    with (work / "postgres.log").open("w") as log:
        proc = subprocess.Popen([bindir / "postgres", "-D", data, "-h", "127.0.0.1", "-p", port,
                                 "-c", "unix_socket_directories=", "-c", "cluster_name=prl_lab_" + system_id, "-c", "log_statement=none"],
                                env=env, stdout=log, stderr=log)
        try:
            pidfile = data / "postmaster.pid"
            for _ in range(300):
                if proc.poll() is not None:
                    raise RuntimeError((work / "postgres.log").read_text()[-2500:])
                if pidfile.exists():
                    lines = pidfile.read_text().splitlines()
                    if len(lines) >= 8 and lines[0] == str(proc.pid) and lines[7].strip() == "ready":
                        break
                time.sleep(.1)
            else:
                raise RuntimeError("owned postmaster never became ready")
            identity = query("""SELECT current_setting('data_directory'), system_identifier,
                host(inet_server_addr()), current_setting('listen_addresses'),
                current_setting('unix_socket_directories') FROM pg_control_system()""")
            if identity != f"{data}|{system_id}|127.0.0.1|127.0.0.1|":
                raise RuntimeError("cluster identity mismatch")
            owner_password = secrets.token_hex(32)
            query(f"CREATE ROLE {role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '{owner_password}';")
            query(f"CREATE DATABASE {database} OWNER {role} TEMPLATE template0;")
            query(f"CREATE ROLE prl_lab_reader NOLOGIN; GRANT prl_lab_reader TO {role};")
            env.update(PGDATABASE=database, PGUSER=role, PGPASSWORD=owner_password)
            if query("""SELECT current_database(),current_user,rolsuper,rolcreaterole,rolcreatedb,
                (SELECT count(*) FROM pg_namespace WHERE nspname NOT IN
                ('public','pg_catalog','pg_toast','information_schema')),
                (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace)
                FROM pg_roles WHERE rolname=current_user""") != f"{database}|{role}|f|f|f|0|0":
                raise RuntimeError("unexpected database, privileges or pre-existing objects")
            print("Owned loopback + SCRAM; empty template0 database; non-superuser schema owner", flush=True)
            run(["bash", "-euc", """
                source asset-exchange/db/test/prl_scratch_replay_run.sh
                psql_scratch() { psql -Xw -v ON_ERROR_STOP=1 "$@"; }
                run_replay_cases
                psql_scratch -f asset-exchange/db/test/prl_lab_privileges.sql
            """], env)
            api_phase("historical")
            run(["bash", "-euc", """
                source asset-exchange/db/test/concurrency.sh
                psql_ci() { psql -Xw -v ON_ERROR_STOP=1 "$@"; }
                run_concurrency_cases
            """], env)
            migration_replay_cases(env)
            client_loss_cases(env)
            api_phase("controls")
            api_phase("restarted")
        finally:
            if proc.poll() is None:
                proc.send_signal(signal.SIGINT)
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                    raise RuntimeError("postmaster needed forced shutdown")
            print("postmaster stopped, exit=" + str(proc.returncode), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pg-bin", required=True, type=Path)
    parser.add_argument("--node-pg-driver", type=Path, help="optional pinned node-postgres lib/index.js for API integration")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="prl-fresh-") as directory:
        work = Path(directory).resolve()
        try:
            campaign(args.pg_bin.resolve(strict=True), work,
                     args.node_pg_driver.resolve(strict=True) if args.node_pg_driver else None)
        finally:
            print("disposing owned temporary directory " + work.name, flush=True)
    if work.exists():
        raise RuntimeError("cleanup incomplete")
    print("PASS private cluster and synthetic credentials removed")
