#!/usr/bin/env bash
# Build the existing diagnostic dependencies from pinned official Git sources.
# This compiles build tools/libraries only; no Dogecoin executable is run here.
set -euo pipefail
test "$#" -eq 4
boost_source="$(realpath "$1")"
event_source="$(realpath "$2")"
dependency_prefix="$(realpath -m "$3")"
evidence_directory="$(realpath "$4")"
test ! -e "$dependency_prefix"
ulimit -t 900
ulimit -v 3145728
python3 - "$boost_source" "$event_source" "$evidence_directory" <<'PY'
import hashlib,json,subprocess,sys
from pathlib import Path
boost,event,out=map(Path,sys.argv[1:])
expected=[(boost,'a7090e8ce184501cfc9e80afa6cafb5bfd3b371c','Boost1.74.0','LICENSE_1_0.txt'),
          (event,'5df3037d10556bfcb675bc73e516978b75fc7bc7','Libevent2.1.12','LICENSE')]
rows=[]
for path,commit,name,license_file in expected:
    def git(*args):return subprocess.check_output(['git','-C',str(path),*args],text=True).strip()
    assert git('rev-parse','HEAD')==commit, name+' source identity mismatch'
    assert not git('status','--porcelain','--untracked-files=no'), name+' source modified'
    modules=subprocess.check_output(['git','-C',str(path),'submodule','status','--recursive'],text=True)
    assert all(line.startswith(' ') for line in modules.splitlines()), name+' submodule mismatch'
    if path==boost:assert len(modules.splitlines())>100,'complete pinned Boost submodules required'
    rows.append({'name':name,'commit':commit,'licenseSha256':hashlib.sha256((path/license_file).read_bytes()).hexdigest(),
                 'submoduleStatusSha256':hashlib.sha256(modules.encode()).hexdigest()})
    (out/(name+'-submodules.txt')).write_text(modules)
(out/'dependency-sources.json').write_text(json.dumps(rows,indent=2)+'\n')
PY
for command_name in g++ make autoconf automake libtoolize pkg-config; do
  command -v "$command_name"
done
pkg-config --modversion openssl
mkdir "$dependency_prefix"
(
  cd "$boost_source"
  ./bootstrap.sh --without-icu --with-libraries=chrono,filesystem,program_options,system,thread,test \
    --prefix="$dependency_prefix"
  ./b2 -j2 headers
  ./b2 -j2 --layout=system variant=release link=static threading=multi \
    cxxflags=-fPIC --prefix="$dependency_prefix" install
) > "$evidence_directory/boost-build.log" 2>&1
(
  cd "$event_source"
  ./autogen.sh
  ./configure --prefix="$dependency_prefix" --disable-shared --disable-openssl \
    --disable-libevent-regress --disable-samples --with-pic
  make -j2
  make install
) > "$evidence_directory/libevent-build.log" 2>&1
find "$dependency_prefix" -type f -name '*.a' -print0 | sort -z | xargs -0 sha256sum \
  > "$evidence_directory/dependency-libraries.sha256"
