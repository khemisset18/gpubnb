#!/bin/sh
set -eu
test "$(id -u)" -ne 0
command -v blender >/dev/null
blender -b --factory-startup --python-expr 'import bpy; print(bpy.app.version_string)' >/dev/null
