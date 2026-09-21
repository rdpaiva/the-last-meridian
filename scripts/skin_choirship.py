"""Texture the Choirship's hull and launch tunnels and normalize bay seams.

    Blender --background art/choirship.blend --python scripts/skin_choirship.py

The original deck UVs and emissive fixtures remain intact. Four horizontal
atlas strips provide armor, underside panels, hangar walls, and launch flooring.
"""

from collections import Counter
from math import atan2, pi
from pathlib import Path
import json

import bpy

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "art/choirship.blend"
ATLAS = ROOT / "art/textures/choirship_hull_atlas.png"
EXPORT = ROOT / "client/public/models/choirship.glb"
STRUCTURAL = {"Choir_Hull", "Choir_HullLight", "Choir_Accent", "Choir_HullWrap", "Choir_HangarSkin"}
STRIPS = {"side": (0.756, 0.994), "belly": (0.506, 0.744),
          "wall": (0.256, 0.494), "floor": (0.006, 0.244)}


def fix_bay_zfight():
    """Keep intersecting bay boxes from exporting exactly coplanar faces.

    The roof/floor originally spanned the full outer wall width, so each long
    side face occupied the same depth plane as a wall face. The mouth rims and
    back wall repeated the pattern. At the launch camera's shallow angle those
    equal-depth fragments flickered. Small, hidden overlaps preserve a sealed
    shell while ensuring every face has an unambiguous depth.
    """
    for side, center_x in (("Port", -3.9), ("Stbd", 3.9)):
        roof = bpy.data.objects[f"Choir_BayRoof_{side}"]
        # Assign the vector atomically: setting x and then y separately makes
        # Blender recompute scale from stale evaluated dimensions and can undo x.
        roof.dimensions = (2.12, 4.12, roof.dimensions.z)
        roof.location.y = 2.07

        floor = bpy.data.objects[f"Choir_BayFloor_{side}"]
        floor.dimensions.x = 2.12

        for wall_name in ("WallIn", "WallOut"):
            wall = bpy.data.objects[f"Choir_Bay{wall_name}_{side}"]
            wall.dimensions = (wall.dimensions.x, 4.18, wall.dimensions.z)
            wall.location.y = 2.11

        back = bpy.data.objects[f"Choir_BayBack_{side}"]
        back.dimensions.x = 1.08

        inner = bpy.data.objects[f"Choir_BayRim_In_{side}"]
        outer = bpy.data.objects[f"Choir_BayRim_Out_{side}"]
        inner.location.x = center_x + (-0.45 if center_x > 0 else 0.45)
        outer.location.x = center_x + (0.45 if center_x > 0 else -0.45)

        top = bpy.data.objects[f"Choir_BayRim_Top_{side}"]
        top.dimensions.x = 0.90

    bpy.context.view_layer.update()


def bounds(points):
    return [(min(p[i] for p in points), max(p[i] for p in points)) for i in range(3)]


def bay_region(obj, points, normal):
    """Only inward wall/roof faces receive the hangar material."""
    if obj.name.startswith("Choir_BayBack_"):
        return "wall"
    if obj.name.startswith("Choir_BayFloor_") and normal.z > 0.5:
        return "floor"
    if obj.name.startswith("Choir_BayRoof_") and normal.z < -0.5:
        return "wall"
    if obj.name.startswith("Choir_BayWall") and abs(normal.x) > 0.9:
        # The clear channel is |X|=3.4..4.4. Outer structural faces retain
        # exterior armor; the cyan rim and guide rails are separate objects.
        if any(all(abs(abs(p.x) - edge) < 0.002 for p in points) for edge in (3.4, 4.4)):
            return "wall"
    return None


def material(name, image, interior=False):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    output.location = (440, 0)
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (120, 0)
    tex = nodes.new("ShaderNodeTexImage")
    tex.location = (-240, 0)
    tex.image = image
    tex.interpolation = "Linear"
    tex.extension = "REPEAT"
    bsdf.inputs["Metallic"].default_value = 0.12 if interior else 0.16
    bsdf.inputs["Roughness"].default_value = 0.75 if interior else 0.70
    # Low albedo-colored emission preserves detail against the starfield and
    # inside the tunnels. Existing dedicated cyan lights still provide glow.
    bsdf.inputs["Emission Strength"].default_value = 0.30 if interior else 0.06
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
    return mat


def slot(mesh, mat):
    index = next((i for i, m in enumerate(mesh.materials) if m == mat), None)
    if index is None:
        index = len(mesh.materials)
        mesh.materials.append(mat)
    return index


def uv_for(point, normal, face_bounds, object_bounds, region, obj):
    low, high = STRIPS[region]
    center_x = -3.9 if obj.name.endswith("Port") else 3.9
    if region == "floor":
        # The floor includes the existing full-width projecting apron.
        # Both ports share forward (+Y) chevrons; never mirror the U axis.
        u = (point.y + 0.1) / 5.0
        across = 0.5 + (point.x - center_x) / 2.2
    elif obj.name in {"Choir_Nacelle_Port", "Choir_Nacelle_Stbd"} and abs(normal.y) < 0.1:
        # A continuous cylindrical unwrap across the exposed lower 240°
        # avoids seams between the twelve-sided engine housing's facets.
        center_x = (object_bounds[0][0] + object_bounds[0][1]) / 2
        theta = atan2(point.z - 0.6, point.x - center_x)
        if theta > pi / 6 + 0.001:
            theta -= 2 * pi
        across = (theta + 7 * pi / 6) / (4 * pi / 3)
        arc_length = 0.65 * 4 * pi / 3
        u = (point.y + 6.25) / (4 * arc_length)
    elif abs(normal.z) > 0.5:
        width = max(object_bounds[0][1] - object_bounds[0][0], 1.1)
        center_x = (object_bounds[0][0] + object_bounds[0][1]) / 2
        u = (point.y + 7.0) / (4 * width)
        across = 0.5 + (point.x - center_x) / width
    else:
        height = max(face_bounds[2][1] - face_bounds[2][0], 0.85)
        center_z = (face_bounds[2][0] + face_bounds[2][1]) / 2
        along = point.y if abs(normal.x) > abs(normal.y) else point.x
        u = (along + (0 if region == "wall" else 7.0)) / (4 * height)
        across = 0.5 + (point.z - center_z) / height
    return (u, low + max(0, min(1, across)) * (high - low))


def geometry_snapshot(objects):
    return {
        o.name: {
            "matrix": tuple(tuple(row) for row in o.matrix_world),
            "vertices": tuple(tuple(v.co) for v in o.data.vertices) if o.type == "MESH" else (),
            "polygons": tuple(tuple(p.vertices) for p in o.data.polygons) if o.type == "MESH" else (),
            "hidden": o.hide_render,
        } for o in objects
    }


def deck_snapshot(objects):
    result = {}
    for obj in objects:
        if obj.type != "MESH" or not obj.data.uv_layers:
            continue
        for poly in obj.data.polygons:
            mat = obj.data.materials[poly.material_index]
            points = [obj.matrix_world @ obj.data.vertices[i].co for i in poly.vertices]
            normal = (obj.matrix_world.to_3x3().inverted().transposed() @ poly.normal).normalized()
            if mat and mat.name == "Choir_Skin" and not bay_region(obj, points, normal):
                result[(obj.name, poly.index)] = tuple(tuple(obj.data.uv_layers.active.data[i].uv)
                                                      for i in poly.loop_indices)
    return result


def main():
    if Path(bpy.data.filepath).resolve() != SOURCE.resolve():
        raise RuntimeError("Open art/choirship.blend before running this script.")
    if bpy.context.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    objects = list(bpy.data.collections["Choirship"].all_objects)
    fix_bay_zfight()
    before_geometry = geometry_snapshot(objects)
    before_deck = deck_snapshot(objects)
    markers = {o.name: tuple(o.matrix_world.translation) for o in objects if o.name.startswith("launch.")}
    assert set(markers) == {"launch.0", "launch.1"}, "Both launch markers are required"
    image = bpy.data.images.get("choirship_hull_atlas")
    if image is None:
        image = bpy.data.images.load(str(ATLAS), check_existing=True)
        image.name = "choirship_hull_atlas"
    image.colorspace_settings.name = "sRGB"
    image.pack()
    exterior = material("Choir_HullWrap", image)
    interior = material("Choir_HangarSkin", image, interior=True)
    counts = Counter()
    for obj in objects:
        if obj.type != "MESH" or obj.hide_render:
            continue
        mesh = obj.data
        object_bounds = bounds([obj.matrix_world @ v.co for v in mesh.vertices])
        if not mesh.uv_layers:
            mesh.uv_layers.new(name="UVMap")
        normal_matrix = obj.matrix_world.to_3x3().inverted().transposed()
        for poly in mesh.polygons:
            old = mesh.materials[poly.material_index]
            points = [obj.matrix_world @ mesh.vertices[i].co for i in poly.vertices]
            normal = (normal_matrix @ poly.normal).normalized()
            region = bay_region(obj, points, normal)
            is_bay = region is not None
            if not is_bay:
                if not old or old.name not in STRUCTURAL:
                    continue
                region = "belly" if normal.z < -0.5 else "side"
                if obj.name in {"Choir_Nacelle_Port", "Choir_Nacelle_Stbd"} and abs(normal.y) < 0.1:
                    region = "side"
            poly.material_index = slot(mesh, interior if is_bay else exterior)
            for li in poly.loop_indices:
                point = obj.matrix_world @ mesh.vertices[mesh.loops[li].vertex_index].co
                mesh.uv_layers.active.data[li].uv = uv_for(point, normal, bounds(points), object_bounds, region, obj)
            counts[region] += 1

    assert geometry_snapshot(objects) == before_geometry, "Texture pass changed geometry"
    assert deck_snapshot(objects) == before_deck, "Texture pass changed exterior deck UVs"
    for img in bpy.data.images:
        if img.source == "FILE":
            local = ROOT / "art/textures" / Path(bpy.path.abspath(img.filepath)).name
            if local.exists():
                img.filepath = bpy.path.relpath(str(local), start=str(SOURCE.parent))
                if not img.packed_file:
                    img.pack()
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE))
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        if not obj.hide_render:
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=str(EXPORT), export_format="GLB", use_selection=True,
        export_yup=True, export_apply=True, export_image_format="JPEG",
        export_image_quality=90, export_jpeg_quality=90,
    )
    print(json.dumps({"textured_faces": dict(counts), "launch_markers": markers,
                      "preserved_deck_faces": len(before_deck),
                      "atlas_size": list(image.size), "export_bytes": EXPORT.stat().st_size}))


if __name__ == "__main__":
    main()
