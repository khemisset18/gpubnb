# Security Lab

A real, isolated defensive-security analysis environment: packet-capture
analysis, malware/file pattern matching, and binary reverse-engineering, in
the same code-server terminal/editor as Developer Workspace.

## What this is

- `tshark` (Wireshark's CLI, real, GPL) - inspect `.pcap`/`.pcapng` capture
  files you bring in.
- `yara` (real, BSD) - write and run YARA rules against files for
  malware/pattern analysis.
- `radare2` (`r2`, real, GPL) - disassemble and analyze binaries, CTF
  challenge reverse-engineering.
- A full VS Code editor and terminal, exactly like Developer Workspace.

## What this is not

- **Not an offensive pentesting toolkit.** No `nmap`, `sqlmap`, `hydra`, or
  Metasploit - this session's network is isolated from the public internet
  exactly like every other GPUbnb workspace, so a live-attack tool would
  have no reachable target anyway. This is an analysis lab: you bring in a
  capture file, a sample, or a binary, and inspect it.
- **No live packet capture.** `tshark` here reads files you provide, it
  cannot capture from a network interface (no capability grant, and no live
  network to capture from either).
- **No Burp Suite.** Its Community Edition license does not permit bundling
  it into a redistributable image.
- **No live network access** inside this session (same isolation as every
  GPUbnb workspace) - you cannot `apt install` a new tool or download an
  updated YARA ruleset live. Bring what you need into `/workspace`, or say
  so if you need a different tool pre-installed.
