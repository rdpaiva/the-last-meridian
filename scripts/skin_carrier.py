"""
skin_carrier.py — reusable Blender helpers for the PLANAR top-down deck-skin
workflow (docs/RECIPES.md → "Apply a top-down deck skin to a carrier").

This is the code half of the recipe so the Blender Python isn't re-derived each
time. It runs INSIDE Blender (needs `bpy`/`numpy`), driven from the Blender MCP
`execute_blender_code` tool or pasted into Blender's Python console. It does NOT
run standalone with `python`.

Typical use (Bastion shown; pass the Choirship's prefix/collection/footprint for
that ship):

    import sys; sys.path.append("/abs/path/space-duel/scripts")
    import importlib, skin_carrier as sc; importlib.reload(sc)

    img  = sc.load_image("/abs/.../art/textures/choirship_skin.png")
    fp   = sc.footprint("Choir")                 # (minX,maxX,minY,maxY,minZ,maxZ)
    rect = sc.detect_ship_uv_rect(img)           # (uL,uR,vBot,vTop)
    skin = sc.make_skin_material("Choir_Skin", img)
    sc.skin_top_faces("Choir", skin, fp, rect)   # planar-project onto deck tops
    sc.recolor_unskinned("Choir", sc.sample_hull_color(img))   # match the flanks
    sc.hide_and_unskin(["Choir_SpineCell", "Choir_..."])       # procedural detail
    # ...emblem-vs-step fixes (move_world / extend_face) then reproject(obj, ...)
    sc.export_glb_jpeg("/abs/.../public/models/choirship.glb", "Choirship")

Then verify with `node scripts/measure-carrier-footprint.mjs` and check the GLB
still has the launch.* markers + the skin baseColorTexture.
"""

import bpy
import mathutils
import numpy as np


# Object-name substrings whose TOP faces must NOT get the skin (they stay
# emissive / get their own treatment). Lowercase, matched with `in`.
DEFAULT_EXCLUDE = (
    "engine", "window", "viewport", "runlight", "bay",
    "spine", "cheek", "groove", "light", "glow",
)


def load_image(path, name=None):
    """Load (or fetch) the skin PNG as an sRGB image datablock."""
    img = bpy.data.images.get(name or "") or bpy.data.images.load(path)
    if name:
        img.name = name
    img.colorspace_settings.name = "sRGB"
    return img


def footprint(prefix):
    """World-space bbox of all `<prefix>*` meshes → (minX,maxX,minY,maxY,minZ,maxZ).
    Bow is +Y by convention."""
    mn = mathutils.Vector((1e9,) * 3)
    mx = mathutils.Vector((-1e9,) * 3)
    for o in bpy.data.objects:
        if o.type != "MESH" or not o.name.startswith(prefix):
            continue
        for c in o.bound_box:
            w = o.matrix_world @ mathutils.Vector(c)
            for i in range(3):
                mn[i] = min(mn[i], w[i])
                mx[i] = max(mx[i], w[i])
    return (mn.x, mx.x, mn.y, mx.y, mn.z, mx.z)


def detect_ship_uv_rect(img, bg_thresh=0.10, row_frac=0.02, col_frac=0.02):
    """Find the ship inside the image's dark margin → UV sub-rect (uL,uR,vBot,vTop).

    Background is sampled from a corner; pixels differing from it form the mask.
    NOTE: `img.pixels` is bottom-row-first, so image-bottom (=stern) is low V.
    """
    w, h = img.size
    px = np.empty(len(img.pixels), dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)[:, :, :3]
    bg = px[2, 2]
    mask = np.abs(px - bg).sum(axis=2) > bg_thresh
    cols = np.where(mask.sum(axis=0) > row_frac * h)[0]
    rows = np.where(mask.sum(axis=1) > col_frac * w)[0]
    return (cols.min() / w, cols.max() / w, rows.min() / h, rows.max() / h)


def make_skin_material(name, img, metallic=0.0, roughness=0.85):
    """Matte material with the skin image straight into Base Color. Matte on
    purpose: high metallic reflects the markings away from the top-down camera."""
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        nt.links.new(bsdf.outputs[0], out.inputs[0])
    for n in [x for x in nt.nodes if x.type == "TEX_IMAGE"]:
        nt.nodes.remove(n)
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    # Linear (bilinear) — exports a LINEAR sampler so Babylon smooths the
    # texture. "Closest" (nearest) makes painted text/markings look blocky and
    # pixelated up close; only use it for hard-edged tile patterns.
    tex.interpolation = "Linear"
    tex.extension = "CLIP"
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    return m


def _uv(wp, fp, rect):
    minX, maxX, minY, maxY = fp[0], fp[1], fp[2], fp[3]
    uL, uR, vBot, vTop = rect
    u = uL + (wp.x - minX) / (maxX - minX) * (uR - uL)
    v = vBot + (wp.y - minY) / (maxY - minY) * (vTop - vBot)
    return (u, v)


def skin_top_faces(prefix, skin_mat, fp, rect, exclude=DEFAULT_EXCLUDE, z_thresh=0.5):
    """Assign `skin_mat` to the TOP faces (world-normal.z>z_thresh) of every
    structural `<prefix>*` mesh and planar-project their UVs. Returns count."""
    n = 0
    for o in bpy.data.objects:
        if o.type != "MESH" or not o.name.startswith(prefix):
            continue
        if any(k in o.name.lower() for k in exclude):
            continue
        me = o.data
        si = len(me.materials)
        me.materials.append(skin_mat)
        if not me.uv_layers:
            me.uv_layers.new(name="UVMap")
        uvl = me.uv_layers.active.data
        n3 = o.matrix_world.to_3x3()
        for poly in me.polygons:
            if (n3 @ poly.normal).normalized().z <= z_thresh:
                continue
            poly.material_index = si
            for li in poly.loop_indices:
                wp = o.matrix_world @ me.vertices[me.loops[li].vertex_index].co
                uvl[li].uv = _uv(wp, fp, rect)
        n += 1
    return n


def skin_bottom_faces(prefix, skin_mat, fp, rect, exclude=(), z_thresh=0.5,
                      flip_u=False, flip_v=False):
    """Like skin_top_faces but for the BELLY: assign `skin_mat` to the DOWN faces
    (world-normal.z < -z_thresh) and planar-project their UVs. Used to put an
    "…-underneath" render on a wreck so its belly reads when it tumbles (pitch).

    Defaults to NO flips — the underneath renders are "see-through" belly diagrams
    framed bow-up just like the top render, so the belly maps exactly like the
    deck (world X,Y → U,V), keeping bow↔stern and port↔stbd aligned with the hull.
    (An earlier flip_v=True reversed it: the belly's nose landed at the tail. If a
    future render is shot from a true below-camera it'll be mirrored — flip then,
    and verify IN-GAME, since the wreck's full transform stack, not a lone pitch,
    decides it.) `exclude` defaults to () — skin the whole belly, dead emitters
    included."""
    n = 0
    for o in bpy.data.objects:
        if o.type != "MESH" or not o.name.startswith(prefix):
            continue
        if any(k in o.name.lower() for k in exclude):
            continue
        me = o.data
        # Reuse an existing slot if this material is already on the mesh, so
        # re-running the wreck build doesn't pile up duplicate slots.
        si = next((i for i, m in enumerate(me.materials) if m == skin_mat), None)
        if si is None:
            si = len(me.materials)
            me.materials.append(skin_mat)
        if not me.uv_layers:
            me.uv_layers.new(name="UVMap")
        uvl = me.uv_layers.active.data
        n3 = o.matrix_world.to_3x3()
        for poly in me.polygons:
            if (n3 @ poly.normal).normalized().z >= -z_thresh:
                continue
            poly.material_index = si
            for li in poly.loop_indices:
                wp = o.matrix_world @ me.vertices[me.loops[li].vertex_index].co
                u, v = _uv(wp, fp, rect)
                uvl[li].uv = (1.0 - u if flip_u else u, 1.0 - v if flip_v else v)
        n += 1
    return n


def reproject(obj, skin_mat, fp, rect):
    """Re-planar-project the skin UVs of one object from its CURRENT world XY.
    Call after moving/extending geometry (move_world / extend_face) so the
    texture follows the new positions."""
    me = obj.data
    si = next((i for i, s in enumerate(obj.material_slots) if s.material == skin_mat), None)
    if si is None:
        return 0
    uvl = me.uv_layers.active.data
    cnt = 0
    for poly in me.polygons:
        if poly.material_index != si:
            continue
        for li in poly.loop_indices:
            wp = obj.matrix_world @ me.vertices[me.loops[li].vertex_index].co
            uvl[li].uv = _uv(wp, fp, rect)
        cnt += 1
    return cnt


def sample_hull_color(img, lo=0.06, hi=0.30):
    """Median (sRGB→linear) of the mid-dark hull pixels in the ship region —
    use it to recolor the un-skinned flanks so they match the livery."""
    w, h = img.size
    px = np.empty(len(img.pixels), dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)[:, :, :3]
    bg = px[2, 2]
    mask = np.abs(px - bg).sum(axis=2) > 0.10
    ys, xs = np.where(mask)
    region = px[ys.min():ys.max(), xs.min():xs.max()].reshape(-1, 3)
    lum = region.mean(axis=1)
    keep = region[(lum > lo) & (lum < hi)]
    med = np.median(keep, axis=0)
    lin = np.where(med <= 0.04045, med / 12.92, ((med + 0.055) / 1.055) ** 2.4)
    return tuple(float(x) for x in lin)


def set_material(name, base=None, metallic=None, roughness=None, emission=None):
    """Tweak a Principled material (recolor flanks, shift emitters to the livery
    accent, etc.). Any arg left None is untouched."""
    m = bpy.data.materials.get(name)
    if not m:
        return None
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    if base is not None:
        b.inputs["Base Color"].default_value = (*base, 1)
    if metallic is not None:
        b.inputs["Metallic"].default_value = metallic
    if roughness is not None:
        b.inputs["Roughness"].default_value = roughness
    if emission is not None:
        b.inputs["Emission Color"].default_value = (*emission, 1)
    return name


def hide_and_unskin(names):
    """Hide procedural top detail the skin now paints (spine ladder, grooves)
    so it's excluded from the render and the export selection."""
    for nm in names:
        for o in bpy.data.objects:
            if o.name == nm or o.name.startswith(nm):
                o.hide_render = True


def move_world(obj, delta):
    """Translate every vertex by a WORLD-space delta (origin stays put). Use to
    relocate an obstacle (e.g. a turret) off an emblem; then reproject(obj,...)."""
    mw = obj.matrix_world
    inv = mw.inverted()
    dv = mathutils.Vector(delta)
    for v in obj.data.vertices:
        v.co = inv @ ((mw @ v.co) + dv)


def extend_face(obj, axis, side, new_world):
    """Move the verts on one extreme face to extend a deck under an emblem.
    axis: 0/1/2 (x/y/z); side: 'max' or 'min'; new_world: target world coord.
    e.g. extend a deck's forward (+Y) edge: extend_face(o, 1, 'max', 6.9)."""
    mw = obj.matrix_world
    inv = mw.inverted()
    vals = [(mw @ v.co)[axis] for v in obj.data.vertices]
    edge = max(vals) if side == "max" else min(vals)
    moved = 0
    for v in obj.data.vertices:
        w = mw @ v.co
        if (w[axis] > edge - 0.05) if side == "max" else (w[axis] < edge + 0.05):
            w[axis] = new_world
            v.co = inv @ w
            moved += 1
    return moved


def export_glb_jpeg(filepath, collection_name, quality=90, yup=True,
                    long_edge=768, image=None):
    """Export the carrier GLB: select the collection MINUS hidden objects,
    JPEG-encode + optionally downscale the texture (huge size win), +Y up,
    apply modifiers. Keep the lossless PNG master on disk separately."""
    if image is not None and long_edge:
        w, h = image.size
        if max(w, h) > long_edge:
            s = long_edge / max(w, h)
            image.scale(int(w * s), int(h * s))
    bpy.ops.object.select_all(action="DESELECT")
    n = 0
    for o in bpy.data.collections[collection_name].objects:
        if o.hide_render:
            continue
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        n += 1
    bpy.ops.export_scene.gltf(
        filepath=filepath, export_format="GLB", use_selection=True,
        export_yup=yup, export_apply=True,
        export_image_format="JPEG", export_image_quality=quality,
        export_jpeg_quality=quality,
    )
    return n
