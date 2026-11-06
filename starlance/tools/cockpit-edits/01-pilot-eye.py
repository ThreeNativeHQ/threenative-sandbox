# Pilot view = the game's cockpit eye (glTF (0, 2.8, 6.5) -> Blender (0, -6.5, 2.8)), level, wider lens.
import bpy, math
cam = bpy.data.objects["Pilot view"]
cam.location = (0.0, -6.5, 2.8)
cam.rotation_euler = (math.radians(90), 0.0, 0.0)
cam.data.sensor_fit = "VERTICAL"
cam.data.angle_y = math.radians(55)
scene = bpy.context.scene
scene.camera = cam
scene.render.resolution_x, scene.render.resolution_y = 1600, 900
