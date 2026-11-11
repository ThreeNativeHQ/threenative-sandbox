"""Drives /Game/Stress in `-game`, as Stress.ts's frame callback does: the orbit camera and the body
re-drop every 8 s. Walkers move natively (RotatingMovementComponent, build_level.py). Started with
`-ExecCmds="py <abs path>/runtime.py"`; Python runs in `-game` because the editor binary is uncooked.

TN_STRESS_MODE (environment):
  measure  60 s settle, then `csvprofile start`, 15 s, `csvprofile stop`, quit (tools/run.sh)
  capture  orbit to second TN_STRESS_FREEZE (10), hold the camera and walkers, shoot 1280x720 at +3 s (bodies settled from the 8 s drop), quit
"""
import json
import math
import os
import time

import unreal

HERE = os.path.dirname(os.path.abspath(__file__))
MODE = os.environ.get("TN_STRESS_MODE", "measure")
SETTLE = float(os.environ.get("TN_STRESS_SETTLE", "60"))
PROFILE = float(os.environ.get("TN_STRESS_PROFILE", "15"))
FREEZE = float(os.environ.get("TN_STRESS_FREEZE", "10"))
ORBIT = {"radius": 70.0, "height": 24.0, "seconds": 40.0}
DROP_EVERY = 8.0
WORLD_PER_M = 100.0
LAYOUT = json.load(open(os.path.join(HERE, "layout.json")))


def log(message):
    unreal.log("TNSTRESS " + message)


class Random:
    def __init__(self, state):
        self.state = state & 0xFFFFFFFF

    def __call__(self):
        self.state = (1664525 * self.state + 1013904223) & 0xFFFFFFFF
        return self.state / 4294967296.0


def game_world():
    for camera in unreal.ObjectIterator(unreal.CameraActor):
        world = camera.get_world()
        if world is not None and camera.actor_has_tag("StressCamera"):
            return world, camera
    return None, None


class Driver:
    def __init__(self):
        self.world = None
        self.camera = None
        self.bodies = []
        self.random = Random(LAYOUT["randomState"])
        self.started = time.monotonic()
        self.since_drop = 0.0
        self.last = 0.0
        self.step = "settle"
        self.mark = 0.0
        self.handle = unreal.register_slate_post_tick_callback(self.tick)

    def command(self, text):
        log("exec " + text)
        unreal.SystemLibrary.execute_console_command(self.world, text)

    def attach(self):
        self.world, self.camera = game_world()
        if self.world is None:
            return False
        bodies = unreal.GameplayStatics.get_all_actors_with_tag(self.world, "StressBody")
        index = lambda actor: next(int(str(t)[1:]) for t in actor.tags if str(t).startswith("i"))
        self.bodies = sorted(bodies, key=index)
        log(f"attached: {len(self.bodies)} bodies")
        return True

    def drop(self):
        for i, body in enumerate(self.bodies):
            pile = i % 6
            x = math.cos(pile) * 12 + self.random() * 3
            z = math.sin(pile) * 12 + self.random() * 3
            body.set_actor_location(unreal.Vector(x * WORLD_PER_M, z * WORLD_PER_M, (4 + (i / 6) * 0.7) * WORLD_PER_M),
                                    False, True)
            component = body.static_mesh_component
            component.set_physics_linear_velocity(unreal.Vector(0, 0, 0))

    def tick(self, _delta):
        if self.world is None and not self.attach():
            return
        now = unreal.GameplayStatics.get_time_seconds(self.world)
        dt = max(0.0, now - self.last)
        self.last = now
        clock = min(now, FREEZE) if MODE == "capture" else now
        orbit = clock / ORBIT["seconds"] * math.pi * 2
        x = math.cos(orbit) * ORBIT["radius"]
        y = ORBIT["height"] + math.sin(orbit * 2) * 4
        z = math.sin(orbit) * ORBIT["radius"]
        dx, dy, dz = -x, 2 - y, -z
        self.camera.set_actor_location_and_rotation(
            unreal.Vector(x * WORLD_PER_M, z * WORLD_PER_M, y * WORLD_PER_M),
            unreal.Rotator(roll=0.0, pitch=math.degrees(math.atan2(dy, math.hypot(dx, dz))),
                           yaw=math.degrees(math.atan2(dz, dx))),
            False, True)
        self.since_drop += dt
        if self.since_drop > DROP_EVERY:
            self.since_drop = 0.0
            self.drop()
        wall = time.monotonic() - self.started
        if MODE == "measure":
            self.measure(wall)
        else:
            self.capture(now, wall)

    def measure(self, wall):
        if self.step == "settle" and wall >= SETTLE:
            self.command("csvprofile start")
            self.step, self.mark = "profile", wall
        elif self.step == "profile" and wall >= self.mark + PROFILE:
            self.command("csvprofile stop")
            self.step, self.mark = "flush", wall
        elif self.step == "flush" and wall >= self.mark + 5:
            self.finish()

    def capture(self, now, wall):
        # Stress.ts `?freezeAt`: the camera and the walkers hold; bodies, fires and animation run on.
        if self.step == "settle" and now >= FREEZE:
            for mover in unreal.ObjectIterator(unreal.RotatingMovementComponent):
                mover.set_editor_property("rotation_rate", unreal.Rotator(0.0, 0.0, 0.0))
            self.step, self.mark = "hold", wall
        elif self.step == "hold" and wall >= self.mark + 3:
            self.command("HighResShot 1")
            self.step, self.mark = "flush", wall
        elif self.step == "flush" and wall >= self.mark + 5:
            self.finish()

    def finish(self):
        self.step = "done"
        unreal.unregister_slate_post_tick_callback(self.handle)
        log("done " + MODE)
        self.command("quit")


DRIVER = Driver()
log(f"runtime.py {MODE}: settle {SETTLE} s, profile {PROFILE} s")
