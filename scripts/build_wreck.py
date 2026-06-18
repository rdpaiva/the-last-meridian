"""
build_wreck.py — build a derelict-WRECK GLB by reskinning the intact carrier
geometry with a battle-damaged top-down render (arena hulk hazard, slice 5b;
docs/ARENA-MAPS.md). Drives public/models/aegis_wreck.glb (humans / Bastion) and
choirship_wreck.glb (machines / Choirship).

WHY reskin the real hull (not a flat card): the game camera is tilted ~38° off
vertical, so a flat textured card reads as a 2-D decal spinning in space — no
depth. Reusing the actual carrier mesh gives genuine 3-D relief (spire, pods,
sponsons) that the scene lights shade for free.

This is the deck-skin recipe (docs/RECIPES.md → "Apply a top-down deck skin to a
carrier") applied to a wreck, leaning on scripts/skin_carrier.py. The carrier
.blend ALREADY has its deck skin planar-projected, and each destroyed render
shares the intact livery's top-view framing (measured: ship-rects match to ~2 px),
so building a wreck is just:

  1. swap the carrier's skin image → the destroyed render,
  2. reproject the skin UVs to the destroyed render's ship-rect (scale-invariant,
     so it's robust even right after an append),
  3. BURN the materials: darken the hull, kill EVERY emitter (run-lights, bay
     glow, viewports, spine/cheek cells, engines) so it reads as a dead husk lit
     only by the scene — a small self-emission keeps it off pure black,
  4. export meshes-only (skip the .blend's lights/empties).

Orientation/scale: the wreck IS the carrier geometry, exported +Y up the same
way, so GameConfig.hulk.model's rotY=π + scale 10.6 correction lands it exactly
like the live carrier — on the rotation-invariant collision circles. Babylon's
glTF import PRESERVES the Blender UV orientation (verified in-game), so the deck
text reads forward — do NOT pre-mirror.

Runs INSIDE Blender (needs bpy/numpy) via the MCP execute_blender_code tool or
the Python console — NOT standalone. scripts/ must be on sys.path so
`skin_carrier` imports.

Call sequence (the Bastion hull is usually already open as bastion_carrier.blend;
the Choirship is appended from its .blend, then removed):

    import sys; sys.path.append("/abs/.../space-duel/scripts")
    import importlib, build_wreck as bw; importlib.reload(bw)
    T="/abs/.../art/textures/"; M="/abs/.../public/models/"

    # Bastion / Aegis (geometry already in the open session):
    r = bw.reskin_wreck("Bastion", "Bastion_Skin", T+"aegis-destroyed-top.jpeg",
        hull_mats=["Bastion_Hull","Bastion_Plate","Bastion_Recess","Bastion_BayBack"],
        emitter_mats=["Bastion_BayGlow","Bastion_RunLight","Bastion_Viewport",
                      "Bastion_SpineCell","Bastion_Window","Bastion_Engine"],
        accent_mats=["Bastion_Accent"])
    bw.export_wreck("Bastion_Carrier", M+"aegis_wreck.glb", r["img"])

    # Choirship (append, build, export, then remove the appended collection):
    bw.append_collection("/abs/.../art/choirship.blend", "Choirship")
    r = bw.reskin_wreck("Choir", "Choir_Skin", T+"choirship-destroyed-top.jpeg",
        hull_mats=["Choir_Hull","Choir_BayBack"],
        emitter_mats=["Choir_Viewport","Choir_SpineCell","Choir_RunLight",
                      "Choir_RedLamp","Choir_HullLight","Choir_Engine","Choir_BayGlow"],
        accent_mats=["Choir_Accent"])
    bw.export_wreck("Choirship", M+"choirship_wreck.glb", r["img"])
    bw.remove_collection("Choirship")

NOTE the underneath/"-underneath" renders are NOT used: under yaw rotation on a
top-down camera the belly is never seen, and the real geometry already gives the
hull a proper (dark) underside. Keep the files for a future free-camera.
"""

import importlib

import bpy

import skin_carrier as sc


def _wreck_emission(mat, emission):
    """Drive a material's image through emission at `emission` strength so the
    dead husk never crushes to pure black while the SCENE lights do the shading."""
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    tex = next(n for n in mat.node_tree.nodes if n.type == "TEX_IMAGE")
    bsdf.inputs["Roughness"].default_value = 0.95
    bsdf.inputs["Metallic"].default_value = 0.0
    if not bsdf.inputs["Emission Color"].is_linked:
        mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = emission


def reskin_wreck(prefix, skin_mat_name, top_render, hull_mats, emitter_mats,
                 accent_mats=(), underneath_render=None, emission=0.18, hull_dim=0.6):
    """Swap `top_render` into the carrier's skin material, reproject the skin UVs,
    project `underneath_render` (if given) onto the BELLY faces, and burn the rest
    into a dead husk. Returns a dict incl. the loaded image (pass to export_wreck)
    and the reprojected-face count."""
    importlib.reload(sc)
    dimg = sc.load_image(top_render, name=prefix.lower() + "_wreck_skin")
    skin = bpy.data.materials[skin_mat_name]
    tex = next(n for n in skin.node_tree.nodes if n.type == "TEX_IMAGE")
    tex.image = dimg
    tex.interpolation = "Linear"
    tex.extension = "CLIP"

    # Make sure matrix_world is current — footprint/reproject read it, and an
    # object freshly appended from another .blend has a stale transform until the
    # view layer updates (its parent scale wouldn't be baked in → wrong bbox).
    bpy.context.view_layer.update()
    fp = sc.footprint(prefix)
    rect = sc.detect_ship_uv_rect(dimg)
    objs = [o for o in bpy.data.objects if o.type == "MESH"
            and any(s.material and s.material.name == skin_mat_name for s in o.material_slots)]
    reproj = sum(sc.reproject(o, skin, fp, rect) for o in objs)
    _wreck_emission(skin, emission)

    # Belly: the wreck tumbles (pitchRate), so the underneath render goes on the
    # DOWN faces (V-flipped so bow↔stern line up after the pitch — see skin_carrier).
    bottom = None
    if underneath_render:
        bimg = sc.load_image(underneath_render, name=prefix.lower() + "_wreck_under")
        # export_glb_jpeg only downscales the ONE image it's handed (the top); do
        # the belly here so it doesn't ship at full render res.
        bw, bh = bimg.size
        if max(bw, bh) > 768:
            s = 768 / max(bw, bh)
            bimg.scale(int(bw * s), int(bh * s))
        bottom = sc.make_skin_material(prefix + "_WreckBelly", bimg)
        _wreck_emission(bottom, emission)
        brect = sc.detect_ship_uv_rect(bimg)
        sc.skin_bottom_faces(prefix, bottom, fp, brect)

    burnt = sc.sample_hull_color(dimg)  # dark burnt grey, sampled from the render
    for m in hull_mats:
        sc.set_material(m, base=tuple(c * hull_dim for c in burnt),
                        metallic=0.0, roughness=0.95, emission=(0, 0, 0))
    for m in accent_mats:
        sc.set_material(m, base=(0.02, 0.02, 0.025), emission=(0, 0, 0))
    for m in emitter_mats:  # every running light / glow goes dark — it's dead
        sc.set_material(m, base=(0.015, 0.015, 0.02), emission=(0, 0, 0))

    return {"fp": fp, "rect": rect, "reproj": reproj, "img": dimg}


def append_collection(blend, name):
    """Append a carrier collection from another .blend into the open scene (so
    its meshes + skin material + UVs come along) and link it for export."""
    with bpy.data.libraries.load(blend, link=False) as (_src, dst):
        dst.collections = [name]
    coll = bpy.data.collections[name]
    if name not in [c.name for c in bpy.context.scene.collection.children]:
        bpy.context.scene.collection.children.link(coll)
    return coll


def export_wreck(collection, out, image):
    """Export the wreck: meshes only (hide the .blend's lights/cameras/empties),
    JPEG-encoded + downscaled texture, +Y up — same settings as the carrier."""
    for o in bpy.data.collections[collection].objects:
        if o.type != "MESH":
            o.hide_render = True
    return sc.export_glb_jpeg(out, collection, quality=85, image=image, long_edge=768)


def remove_collection(name):
    """Tear down an appended collection (objects + collection) so the host
    .blend session is left as it was — do NOT save over the carrier source."""
    coll = bpy.data.collections.get(name)
    if not coll:
        return
    for o in list(coll.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.data.collections.remove(coll)
