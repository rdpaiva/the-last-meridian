"""Texture the Bastion's flanks, belly and launch tunnels, preserving its deck.

Run inside Blender, or from the repository root:
    Blender --background art/bastion_carrier.blend --python scripts/skin_bastion.py

The four horizontal atlas strips, top to bottom, are exterior armor, underside
engineering panels, hangar walls/ceiling, and launch flooring. All are sampled
through explicit UVs and export as one embedded JPEG. No geometry is changed.
"""

from collections import Counter
from pathlib import Path
import json

import bpy

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "art/bastion_carrier.blend"
ATLAS = ROOT / "art/textures/bastion_hull_atlas.png"
EXPORT = ROOT / "client/public/models/bastion_carrier.glb"
COLLECTION = "Bastion_Carrier"
STRUCTURAL = {
    "Bastion_Hull", "Bastion_Plate", "Bastion_Accent", "Bastion_Recess",
    "Bastion_HullWrap", "Bastion_HangarSkin",
}
# Inset from strip boundaries prevents adjacent rows bleeding through filtering.
STRIPS = {"side": (0.756, 0.994), "belly": (0.506, 0.744),
          "wall": (0.256, 0.494), "floor": (0.006, 0.244)}


def bounds(points):
    return [(min(p[i] for p in points), max(p[i] for p in points)) for i in range(3)]


def bay_region(obj, points, normal):
    """Identify the existing carved tunnel by position, not polygon indices."""
    if obj.name.startswith("Bastion_BayFloor_"):
        return "floor" if normal.z > 0.5 else "belly"
    if obj.name.startswith("Bastion_BayBack_"):
        return "wall"
    if obj.name not in {"Bastion_Pod_Port", "Bastion_Pod_Stbd"}:
        return None
    center = -3.6 if obj.name.endswith("Port") else 3.6
    if all(abs(p.x - center) < 0.576 and 7.19 < p.y < 11.21
           and -0.48 < p.z < 0.44 for p in points):
        return "floor" if normal.z > 0.5 else "wall"
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
    bsdf.inputs["Metallic"].default_value = 0.10 if interior else 0.14
    bsdf.inputs["Roughness"].default_value = 0.78 if interior else 0.72
    # A small albedo-colored floor keeps detail legible in the game's dark
    # environment. Only existing dedicated light meshes enter the GlowLayer.
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
    if region == "floor":
        # Every arrow points forward (+Y), including on the port-side deck.
        center = -3.6 if "Port" in obj.name else 3.6
        u = (point.y - 7.2) / 4.7
        across = (point.x - (center - 0.575)) / 1.15
    elif abs(normal.z) > 0.5:
        # Longitudinal belly/ceiling strips, with enough width to keep the
        # engineering panels square rather than stretching the top decal.
        width = max(object_bounds[0][1] - object_bounds[0][0], 1.15)
        if region == "wall":
            width = 1.15
            center = -3.6 if "Port" in obj.name else 3.6
        else:
            center = (object_bounds[0][0] + object_bounds[0][1]) / 2
        u = (point.y + 8.8) / (4 * width)
        across = 0.5 + (point.x - center) / width
    else:
        height = max(face_bounds[2][1] - face_bounds[2][0], 0.85)
        center_z = (face_bounds[2][0] + face_bounds[2][1]) / 2
        along = point.y if abs(normal.x) > abs(normal.y) else point.x
        # Align modular walls with the launch direction; exterior siding uses
        # continuous world coordinates so adjacent hull pieces retain scale.
        u = (along - (7.2 if region == "wall" else -8.8)) / (4 * height)
        across = 0.5 + (point.z - center_z) / height
    return (u, low + max(0.0, min(1.0, across)) * (high - low))


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
    deck = {}
    for obj in objects:
        if obj.type != "MESH" or not obj.data.uv_layers:
            continue
        for poly in obj.data.polygons:
            mat = obj.data.materials[poly.material_index]
            points = [obj.matrix_world @ obj.data.vertices[i].co for i in poly.vertices]
            normal = (obj.matrix_world.to_3x3().inverted().transposed() @ poly.normal).normalized()
            if mat and mat.name == "Bastion_Skin" and not bay_region(obj, points, normal):
                deck[(obj.name, poly.index)] = tuple(tuple(obj.data.uv_layers.active.data[i].uv)
                                                    for i in poly.loop_indices)
    return deck


def main():
    if Path(bpy.data.filepath).resolve() != SOURCE.resolve():
        raise RuntimeError("Open art/bastion_carrier.blend before running this script.")
    if bpy.context.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    objects = list(bpy.data.collections[COLLECTION].all_objects)
    before_geometry = geometry_snapshot(objects)
    before_deck = deck_snapshot(objects)
    markers = {o.name: tuple(o.matrix_world.translation) for o in objects
               if o.name.startswith("launch.")}
    assert set(markers) == {"launch.0", "launch.1"}, "Both launch markers are required"

    image = next((i for i in bpy.data.images if i.name == "bastion_hull_atlas"), None)
    if image is None:
        image = bpy.data.images.load(str(ATLAS), check_existing=True)
        image.name = "bastion_hull_atlas"
    image.colorspace_settings.name = "sRGB"
    image.pack()
    exterior = material("Bastion_HullWrap", image)
    interior = material("Bastion_HangarSkin", image, interior=True)
    counts = Counter()
    for obj in objects:
        if obj.type != "MESH" or obj.hide_render:
            continue
        mesh = obj.data
        object_bounds = bounds([obj.matrix_world @ v.co for v in mesh.vertices])
        if not mesh.uv_layers:
            mesh.uv_layers.new(name="UVMap")
        uvs = mesh.uv_layers.active.data
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
            poly.material_index = slot(mesh, interior if is_bay else exterior)
            face_bounds = bounds(points)
            for loop_index in poly.loop_indices:
                point = obj.matrix_world @ mesh.vertices[mesh.loops[loop_index].vertex_index].co
                uvs[loop_index].uv = uv_for(point, normal, face_bounds, object_bounds, region, obj)
            counts[region] += 1

    assert geometry_snapshot(objects) == before_geometry, "Texture pass changed geometry"
    assert deck_snapshot(objects) == before_deck, "Texture pass changed the existing deck UVs"
    # Store portable image paths in the editable source as well as packed data.
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
