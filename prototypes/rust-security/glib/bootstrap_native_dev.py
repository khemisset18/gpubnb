#!/usr/bin/env python3
"""Extract hash-pinned official Ubuntu build metadata; never install system packages.
The resulting linker symlinks intentionally resolve the host's real runtime.
"""
import concurrent.futures,hashlib,json,os,shlex,subprocess,sys,urllib.request
from pathlib import Path
here=Path(__file__).resolve().parent;root=Path(sys.argv[1]).resolve();root.mkdir(mode=0o700,parents=False,exist_ok=False)
records=json.loads((here.parent/'evidence/ubuntu-native-development-packages.json').read_text())
def fetch(v):
 p=root/Path(v['Filename']).name;urllib.request.urlretrieve('https://archive.ubuntu.com/ubuntu/'+v['Filename'],p)
 if hashlib.sha256(p.read_bytes()).hexdigest()!=v['SHA256']:raise RuntimeError('Ubuntu package digest mismatch: '+v['Package'])
 subprocess.run(['dpkg-deb','-x',str(p),str(root/'prefix')],check=True)
 return v['Package']
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:print('VERIFIED_PACKAGES '+','.join(pool.map(fetch,records)))
lib=root/'prefix/usr/lib/x86_64-linux-gnu'
for name in ['glib','gobject','gio','gmodule','gthread']:
 target=Path(f'/usr/lib/x86_64-linux-gnu/lib{name}-2.0.so.0')
 if not target.is_file():raise RuntimeError('host native runtime missing: '+str(target))
 p=lib/f'lib{name}-2.0.so'
 if p.is_symlink() or p.exists():p.unlink()
 p.symlink_to(target)
with (root/'environment.sh').open('w') as f:
 f.write("export PKG_CONFIG="+shlex.quote(str(root/"prefix/usr/bin/pkgconf"))+"\n")
 f.write("export PKG_CONFIG_SYSROOT_DIR="+shlex.quote(str(root/"prefix"))+"\n")
 f.write("export PKG_CONFIG_LIBDIR="+shlex.quote(str(lib/"pkgconfig"))+"\n")
 f.write("export LD_LIBRARY_PATH="+shlex.quote(str(lib))+':"${LD_LIBRARY_PATH:-}"\n')
env=os.environ.copy();env.update({'PKG_CONFIG_SYSROOT_DIR':str(root/'prefix'),'PKG_CONFIG_LIBDIR':str(lib/'pkgconfig'),'LD_LIBRARY_PATH':str(lib)+':'+env.get('LD_LIBRARY_PATH','')})
subprocess.run([str(root/'prefix/usr/bin/pkgconf'),'--exists','glib-2.0','gobject-2.0','gio-2.0'],env=env,check=True)
print('VERIFIED_NATIVE_METADATA glib-2.0 gobject-2.0 gio-2.0')
print('Environment file: '+str(root/'environment.sh'))
