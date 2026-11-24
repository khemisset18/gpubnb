"""Run the Pearl SQL campaign against a cluster created and destroyed by this process."""
import argparse
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]


def run(argv, env, **options):
    return subprocess.run(argv, env=env, cwd=ROOT, text=True, check=True, **options)


def campaign(bindir, work):
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
    print(f"initdb {version} system_identifier={system_id} database={database} mode={work.stat().st_mode & 0o777:o}", flush=True)
    def query(sql):
        return run(["psql", "-XwAtq", "-v", "ON_ERROR_STOP=1"], env,
                   input=sql, capture_output=True).stdout.strip()
    with (work / "postgres.log").open("w") as log:
        proc = subprocess.Popen([bindir / "postgres", "-D", data, "-h", "127.0.0.1", "-p", port,
                                 "-c", "unix_socket_directories=", "-c", "log_statement=none"],
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
                source asset-exchange/db/test/concurrency.sh
                psql_scratch() { psql -Xw -v ON_ERROR_STOP=1 "$@"; }
                psql_ci() { psql_scratch "$@"; }
                run_replay_cases
                psql_scratch -f asset-exchange/db/test/prl_lab_privileges.sql
                run_concurrency_cases
            """], env)
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
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="prl-fresh-") as directory:
        work = Path(directory).resolve()
        try:
            campaign(args.pg_bin.resolve(strict=True), work)
        finally:
            print("disposing owned temporary directory " + work.name, flush=True)
    if work.exists():
        raise RuntimeError("cleanup incomplete")
    print("PASS private cluster and synthetic credentials removed")
