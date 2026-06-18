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

    # 1. seed editable boxes from the current GameConfig.hulk.colliders fit:
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

# The current baked fit (keep in sync with GameConfig.hulk.colliders) so `spawn`
# starts you from it instead of a blank hull.
HUMANS = [
    {"cx": -31.3, "cy": 0, "cz": 15.9, "hx": 19.6, "hy": 12.2, "hz": 110.2},
    {"cx": 0, "cy": 17.8, "cz": 3.2, "hx": 17, "hy": 34.7, "hz": 136.7},
    {"cx": 31.3, "cy": 0, "cz": 15.9, "hx": 19.6, "hy": 12.2, "hz": 110.2},
]
MACHINES = [
    {"cx": -33.4, "cy": 2.9, "cz": -35.8, "hx": 19.6, "hy": 11.4, "hz": 106.8},
    {"cx": 0, "cy": 3.3, "cz": -0.7, "hx": 40.3, "hy": 20.3, "hz": 146.9},
    {"cx": 33.4, "cy": 2.9, "cz": -35.8, "hx": 19.6, "hy": 11.4, "hz": 106.8},
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
    print(f"\n--- paste into GameConfig.hulk.colliders[faction] ---\n{lines}\n")
    return out
