#!/usr/bin/env python3
"""Synthetic GTK3/GObject interface probe only; no GUI, event loop, wallet or service."""
import ctypes as C,hashlib,json
from pathlib import Path
# Explicit typed bindings to public GTK3/GObject ABI. No arbitrary symbol calls.
gtk=C.CDLL('/usr/lib/x86_64-linux-gnu/libgtk-3.so.0');gobject=C.CDLL('/usr/lib/x86_64-linux-gnu/libgobject-2.0.so.0')
for name in ['gtk_get_major_version','gtk_get_minor_version','gtk_get_micro_version']:
 f=getattr(gtk,name);f.argtypes=[];f.restype=C.c_uint
new=gtk.gtk_adjustment_new;new.argtypes=[C.c_double]*6;new.restype=C.c_void_p
get=gtk.gtk_adjustment_get_value;get.argtypes=[C.c_void_p];get.restype=C.c_double
setvalue=gtk.gtk_adjustment_set_value;setvalue.argtypes=[C.c_void_p,C.c_double];setvalue.restype=None
sink=gobject.g_object_ref_sink;sink.argtypes=[C.c_void_p];sink.restype=C.c_void_p
unref=gobject.g_object_unref;unref.argtypes=[C.c_void_p];unref.restype=None
obj=new(1,0,10,1,2,0)
if not obj:raise RuntimeError('GTK adjustment construction failed')
sink(obj)
try:
 assert get(obj)==1
 setvalue(obj,7);assert get(obj)==7
 setvalue(obj,99);assert get(obj)==10
 setvalue(obj,-99);assert get(obj)==0
finally:unref(obj)
libraries={}
for name in ['libgtk-3.so.0','libglib-2.0.so.0','libgobject-2.0.so.0']:
 p=Path('/usr/lib/x86_64-linux-gnu')/name;libraries[name]={'resolved':str(p.resolve()),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
print(json.dumps({'status':'PASS_NATIVE_COMPONENT_ONLY','gtkVersion':[getattr(gtk,n)() for n in ['gtk_get_major_version','gtk_get_minor_version','gtk_get_micro_version']],'checks':4,'libraries':libraries,'notTested':['Rust GTK wrapper','Tauri/Wry/WebKit event loop','GUI','native packaging','Windows']},indent=2))
