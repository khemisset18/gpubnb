"""Blender --background --python gpu-render-smoke.py: prove Cycles CUDA output."""
import os
import bpy

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.mesh.primitive_cube_add()
bpy.ops.object.camera_add(location=(4, -6, 4))
camera = bpy.context.object
camera.rotation_euler = (0.95, 0, 0.56)
bpy.context.scene.camera = camera
bpy.ops.object.light_add(type="AREA", location=(3, -4, 5))
bpy.context.object.data.energy = 400
scene = bpy.context.scene
scene.render.engine = "CYCLES"
prefs = bpy.context.preferences.addons["cycles"].preferences
prefs.compute_device_type = "CUDA"
prefs.get_devices()
devices = [d for d in prefs.devices if d.type == "CUDA"]
if not devices:
    raise SystemExit("no_cycles_cuda_device_no_cpu_fallback")
for device in prefs.devices:
    device.use = device.type == "CUDA"
scene.cycles.device = "GPU"
scene.cycles.samples = 4
scene.render.resolution_x = 64
scene.render.resolution_y = 64
scene.render.resolution_percentage = 100
scene.render.filepath = "/workspace/output/gpubnb-cycles-gpu-proof.png"
os.makedirs("/workspace/output", exist_ok=True)
bpy.ops.render.render(write_still=True)
if os.stat(scene.render.filepath).st_size < 100:
    raise SystemExit("gpu_render_output_missing")
print("gpubnb_cycles_cuda_render_ok", [d.name for d in devices])
