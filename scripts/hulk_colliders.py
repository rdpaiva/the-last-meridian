"""
hulk_colliders.py — VISUAL round-trip for authoring wreck colliders in Blender,
the companion to scripts/measure-hulk-colliders.mjs (which auto-fits from the
mesh). Run INSIDE Blender (MCP execute_blender_code or the console), with the
CARRIER .blend open (bastion_carrier.blend / choirship.blend) — author against
the source geometry's bow-+Y frame, NOT a re-imported GLB (Blender's glTF import
flips axes).

Workflow:
    import sys; sys.path.append("/abs/.../space-duel/scripts")
    import importlib, hulk_colliders as hc; importlib.reload(hc)

    # 1. seed editable boxes from the current GameConfig.mothership.colliders fit:
    hc.spawn(hc.HUMANS)          # (or hc.MACHINES; or your own [{cx,cy,cz,hx,hy,hz},...])
    # 2. in the viewport: grab (G) / scale (S) the `collider.*` boxes to hug the
    #    hull. KEEP THEM AXIS-ALIGNED (don't rotate — sections are axis-aligned
    #    to the hull; a rotated box is read as its enclosing AABB). Add/delete
    #    boxes freely (name new ones `collider.<n>`).
    # 3. read them back as a GameConfig snippet to paste:
    hc.read()

Frame: game (hullRects) coords = Blender × 10.6 with gameZ=BlenderY (keel/bow),
gameY=BlenderZ (up), gameX=BlenderX (beam) — the net of the model correction
(rotY=π, scale 10.6), verified against hullRects. The hulk's own `scale` is
applied at runtime, so these are the UNSCALED carrier-world values the config
wants.
"""

import bpy
import mathutils

SCALE = 10.6
PREFIX = "collider."

# The current fit (keep in sync with GameConfig.mothership.colliders) so `spawn`
# starts you from it instead of a blank hull. HUMANS = the 18 per-part Bastion
# boxes; MACHINES = the 31 per-part Choirship boxes (side launch-bay housings
# merged into one box per side). Each is one box per structural element.
HUMANS = [
    {"cx": 0, "cy": 0, "cz": 12.7, "hx": 17, "hy": 11.7, "hz": 127.2},      # hull
    {"cx": 0, "cy": -12.2, "cz": 7.4, "hx": 12.7, "hy": 4.8, "hz": 95.4},   # keel
    {"cx": 0, "cy": 13.2, "cz": 2.1, "hx": 5.3, "hy": 2.6, "hz": 106},      # spine
    {"cx": 0, "cy": 19.1, "cz": 5.8, "hx": 11.7, "hy": 5.3, "hz": 67.3},    # deck low
    {"cx": 0, "cy": 27, "cz": 2.1, "hx": 7.4, "hy": 4.2, "hz": 37.1},       # deck up
    {"cx": -38.2, "cy": 0, "cz": 12.7, "hx": 12.7, "hy": 7.4, "hz": 106},   # port pod
    {"cx": 38.2, "cy": 0, "cz": 12.7, "hx": 12.7, "hy": 7.4, "hz": 106},    # stbd pod
    {"cx": -38.2, "cy": -9.5, "cz": 7.4, "hx": 8.5, "hy": 2.6, "hz": 74.2}, # port pod keel
    {"cx": 38.2, "cy": -9.5, "cz": 7.4, "hx": 8.5, "hy": 2.6, "hz": 74.2},  # stbd pod keel
    {"cx": -38.2, "cy": 9.5, "cz": -9.5, "hx": 7.4, "hy": 2.6, "hz": 75.3}, # port pod ridge
    {"cx": 38.2, "cy": 9.5, "cz": -9.5, "hx": 7.4, "hy": 2.6, "hz": 75.3},  # stbd pod ridge
    {"cx": -22.3, "cy": 0, "cz": 12.7, "hx": 10.6, "hy": 3.7, "hz": 80.6},  # port neck
    {"cx": 22.3, "cy": 0, "cz": 12.7, "hx": 10.6, "hy": 3.7, "hz": 80.6},   # stbd neck
    {"cx": 0, "cy": 0, "cz": -118.7, "hx": 15.9, "hy": 13.8, "hz": 13.8},   # stern
    {"cx": 0, "cy": 0, "cz": -124, "hx": 14.8, "hy": 11.7, "hz": 6.9},      # engine mount
    {"cx": 0, "cy": 20.7, "cz": 91.2, "hx": 12.7, "hy": 7.4, "hz": 15.9},   # bridge base
    {"cx": 0, "cy": 30.2, "cz": 93.3, "hx": 9, "hy": 5.8, "hz": 11.7},      # bridge mid
    {"cx": 0, "cy": 37.6, "cz": 91.2, "hx": 5.3, "hy": 2.1, "hz": 7.9},     # bridge cap
]
MACHINES = [
    {"cx": 0, "cy": 0, "cz": -5.3, "hx": 25.4, "hy": 11.1, "hz": 68.9},      # hull
    {"cx": 0, "cy": -12.7, "cz": -10.6, "hx": 14.8, "hy": 4.2, "hz": 58.3},  # keel
    {"cx": 0, "cy": 11.1, "cz": -10.6, "hx": 10.6, "hy": 1.9, "hz": 55.6},   # spine frame
    {"cx": 0, "cy": 0, "cz": -90.1, "hx": 40.3, "hy": 10.1, "hz": 31.8},     # stern main
    {"cx": 0, "cy": 10.6, "cz": -95.4, "hx": 23.3, "hy": 2.4, "hz": 26.5},   # stern deck
    {"cx": 0, "cy": 0, "cz": -129.3, "hx": 40.3, "hy": 9, "hz": 9.5},        # stern cap
    {"cx": -32.3, "cy": 0, "cz": -128.3, "hx": 15.4, "hy": 7.9, "hz": 14.3}, # stern corner port
    {"cx": 32.3, "cy": 0, "cz": -128.3, "hx": 15.4, "hy": 7.9, "hz": 14.3},  # stern corner stbd
    {"cx": 0, "cy": 0, "cz": -139.9, "hx": 24.4, "hy": 6.9, "hz": 4.8},      # stern engine block
    {"cx": 0, "cy": 15.4, "cz": -98.6, "hx": 10.6, "hy": 3.7, "hz": 13.8},   # aft module base
    {"cx": 0, "cy": 20.7, "cz": -95.4, "hx": 5.3, "hy": 2.9, "hz": 8.5},     # aft module head
    {"cx": -41.3, "cy": 0, "cz": -37.1, "hx": 11.7, "hy": 7.9, "hz": 37.1},  # port sponson
    {"cx": 41.3, "cy": 0, "cz": -37.1, "hx": 11.7, "hy": 7.9, "hz": 37.1},   # stbd sponson
    {"cx": -42.4, "cy": 9, "cz": -47.7, "hx": 9, "hy": 2.4, "hz": 17},       # port sponson step
    {"cx": 42.4, "cy": 9, "cz": -47.7, "hx": 9, "hy": 2.4, "hz": 17},        # stbd sponson step
    {"cx": -43.4, "cy": 9.5, "cz": -19.1, "hx": 7.9, "hy": 2.1, "hz": 10.6}, # port sponson step2
    {"cx": 43.4, "cy": 9.5, "cz": -19.1, "hx": 7.9, "hy": 2.1, "hz": 10.6},  # stbd sponson step2
    {"cx": -24.9, "cy": 6.4, "cz": -26.5, "hx": 6.9, "hy": 6.9, "hz": 39.8}, # port nacelle
    {"cx": 24.9, "cy": 6.4, "cz": -26.5, "hx": 6.9, "hy": 6.9, "hz": 39.8},  # stbd nacelle
    {"cx": -24.9, "cy": 6.4, "cz": 20.7, "hx": 6.9, "hy": 6.9, "hz": 7.4},   # port nacelle nose
    {"cx": 24.9, "cy": 6.4, "cz": 20.7, "hx": 6.9, "hy": 6.9, "hz": 7.4},    # stbd nacelle nose
    {"cx": 0, "cy": 0, "cz": 59.4, "hx": 24.4, "hy": 11.7, "hz": 17},        # bridge base
    {"cx": -20.7, "cy": 9.5, "cz": 57.2, "hx": 6.9, "hy": 4.8, "hz": 13.8},  # port cheek
    {"cx": 20.7, "cy": 9.5, "cz": 57.2, "hx": 6.9, "hy": 4.8, "hz": 13.8},   # stbd cheek
    {"cx": 0, "cy": 14.3, "cz": 60.4, "hx": 8.5, "hy": 4.2, "hz": 11.7},     # head base
    {"cx": 0, "cy": 20.7, "cz": 63.6, "hx": 5.8, "hy": 2.9, "hz": 7.4},      # head cap
    {"cx": 0, "cy": 0, "cz": 94.3, "hx": 18, "hy": 10.1, "hz": 22.3},        # prow body
    {"cx": 0, "cy": 10.1, "cz": 94.3, "hx": 10.6, "hy": 2.7, "hz": 20.1},    # prow plate
    {"cx": 0, "cy": 0, "cz": 129.8, "hx": 11.7, "hy": 7.9, "hz": 16.4},      # prow tip
    {"cx": -41.3, "cy": 0, "cz": 24.9, "hx": 11.7, "hy": 8.4, "hz": 26},     # port launch bay
    {"cx": 41.3, "cy": 0, "cz": 24.9, "hx": 11.7, "hy": 8.4, "hz": 26},      # stbd launch bay
]


def _wire_material():
    m = bpy.data.materials.get("collider_wire") or bpy.data.materials.new("collider_wire")
    m.use_nodes = False
    m.diffuse_color = (0.1, 1.0, 0.2, 1.0)
    return m


# Unit cube (±0.5) — scaling the object by `dim` gives a box of exactly `dim`.
_CUBE_V = [(-0.5, -0.5, -0.5), (0.5, -0.5, -0.5), (0.5, 0.5, -0.5), (-0.5, 0.5, -0.5),
           (-0.5, -0.5, 0.5), (0.5, -0.5, 0.5), (0.5, 0.5, 0.5), (-0.5, 0.5, 0.5)]
_CUBE_F = [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2),
           (2, 6, 7, 3), (3, 7, 4, 0)]


def _make_cube(name, loc, dim, mat):
    """Build a unit-cube object via the data API (no operators → no context
    surprises) and scale it to `dim`."""
    me = bpy.data.meshes.new(name)
    me.from_pydata(_CUBE_V, [], _CUBE_F)
    me.update()
    me.materials.append(mat)
    o = bpy.data.objects.new(name, me)
    o.location = loc
    o.scale = dim
    o.display_type = "WIRE"
    o.show_in_front = True
    bpy.context.scene.collection.objects.link(o)
    return o


def spawn(boxes, clear=True):
    """Create editable wireframe cubes named `collider.N` from a game-frame OBB
    list (game → Blender). They render as green wireframes drawn in front so you
    can line them up against the hull."""
    if clear:
        for o in [o for o in bpy.data.objects if o.name.startswith(PREFIX)]:
            bpy.data.objects.remove(o, do_unlink=True)
    mat = _wire_material()
    for i, b in enumerate(boxes):
        # game (cx beam, cy up, cz keel) → Blender (X beam, Y keel, Z up)
        loc = (b["cx"] / SCALE, b["cz"] / SCALE, b["cy"] / SCALE)
        dim = (2 * b["hx"] / SCALE, 2 * b["hz"] / SCALE, 2 * b["hy"] / SCALE)
        _make_cube(f"{PREFIX}{i}", loc, dim, mat)
    return len([o for o in bpy.data.objects if o.name.startswith(PREFIX)])


def read():
    """Read every `collider.*` object's world AABB back to a GameConfig snippet
    (Blender → game). Returns the list and prints the paste-ready block."""
    bpy.context.view_layer.update()  # bake pending location/scale into matrix_world
    cols = sorted(
        [o for o in bpy.data.objects if o.name.startswith(PREFIX)],
        key=lambda o: o.name,
    )
    out = []
    for o in cols:
        mn = mathutils.Vector((1e9,) * 3)
        mx = mathutils.Vector((-1e9,) * 3)
        for c in o.bound_box:
            w = o.matrix_world @ mathutils.Vector(c)
            for i in range(3):
                mn[i] = min(mn[i], w[i])
                mx[i] = max(mx[i], w[i])
        # Blender (X beam, Y keel, Z up) → game (cx beam, cy up, cz keel)
        out.append({
            "cx": round((mn.x + mx.x) / 2 * SCALE, 1),
            "cy": round((mn.z + mx.z) / 2 * SCALE, 1),
            "cz": round((mn.y + mx.y) / 2 * SCALE, 1),
            "hx": round((mx.x - mn.x) / 2 * SCALE, 1),
            "hy": round((mx.z - mn.z) / 2 * SCALE, 1),
            "hz": round((mx.y - mn.y) / 2 * SCALE, 1),
        })
    lines = "\n".join(
        f"        {{ cx: {b['cx']}, cy: {b['cy']}, cz: {b['cz']}, "
        f"hx: {b['hx']}, hy: {b['hy']}, hz: {b['hz']} }},"
        for b in out
    )
    print(f"\n--- paste into GameConfig.mothership.colliders[faction] ---\n{lines}\n")
    return out
