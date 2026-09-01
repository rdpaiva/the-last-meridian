"""Build the Commonwealth Spitfire Mk II and export its runtime GLB.

Run with:

    Blender --background --factory-startup --python scripts/build_spitfire.py

The model is authored nose-along Blender +Y so the existing runtime
`rotY = Math.PI` correction remains valid.  It deliberately uses a modest
number of flat-shaded pieces and one shared 1024px hull texture.
"""

from math import cos, pi, sin
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
BLEND_PATH = ROOT / "art" / "spitfire.blend"
TEXTURE_PATH = ROOT / "art" / "textures" / "spitfire_armor.png"
GLB_PATH = ROOT / "client" / "public" / "models" / "spitfire.glb"
PREVIEW_PATH = ROOT / "art" / "pictures" / "spitfire_mk2_preview.png"

SHIP_COLLECTION = "Spitfire"
TILE_WORLD_SIZE = 2.7


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials,
                       bpy.data.cameras, bpy.data.lights):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)


def new_collection(name, parent=None):
    collection = bpy.data.collections.new(name)
    (parent or bpy.context.scene.collection).children.link(collection)
    return collection


def link_object(obj, collection):
    for existing in list(obj.users_collection):
        existing.objects.unlink(obj)
    collection.objects.link(obj)


def principled_material(name, color, metallic, roughness, emission=None):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = 0.18
    if emission:
        emission_socket = "Emission Color" if "Emission Color" in bsdf.inputs else "Emission"
        bsdf.inputs[emission_socket].default_value = (*emission[0], 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission[1]
    return material


def textured_material():
    image = bpy.data.images.load(str(TEXTURE_PATH), check_existing=False)
    image.name = "spitfire_armor"
    image.colorspace_settings.name = "sRGB"
    image.pack()

    material = bpy.data.materials.new("Spitfire_ArmorSkin")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    output.location = (420, 0)
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (120, 0)
    tex = nodes.new("ShaderNodeTexImage")
    tex.location = (-260, 20)
    tex.image = image
    tex.interpolation = "Linear"
    tex.extension = "REPEAT"
    # A dark metallic hull mainly reflects the black environment and vanishes
    # at gameplay scale. Keep the warm gunmetal color, but let diffuse light
    # carry it and give the albedo a very low emissive floor. The armor mesh is
    # not registered with the GlowLayer, so this improves readability without
    # producing a halo or an extra draw call/texture.
    bsdf.inputs["Metallic"].default_value = 0.14
    bsdf.inputs["Roughness"].default_value = 0.60
    emission_socket = "Emission Color" if "Emission Color" in bsdf.inputs else "Emission"
    bsdf.inputs["Emission Strength"].default_value = 0.14
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = 0.16
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(tex.outputs["Color"], bsdf.inputs[emission_socket])
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
    return material


def mesh_object(name, vertices, faces, material, collection, root):
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.parent = root
    obj.data.materials.append(material)
    for polygon in mesh.polygons:
        polygon.use_smooth = False
    return obj


def polygon_prism(name, polygon, z_bottom, z_top, material, collection, root):
    count = len(polygon)
    vertices = [(x, y, z_bottom) for x, y in polygon]
    vertices += [(x, y, z_top) for x, y in polygon]
    faces = [tuple(range(count - 1, -1, -1)), tuple(range(count, count * 2))]
    for index in range(count):
        nxt = (index + 1) % count
        faces.append((index, nxt, count + nxt, count + index))
    return mesh_object(name, vertices, faces, material, collection, root)


def x_prism(name, yz_polygon, x_center, thickness, material, collection, root):
    count = len(yz_polygon)
    left, right = x_center - thickness / 2, x_center + thickness / 2
    vertices = [(left, y, z) for y, z in yz_polygon]
    vertices += [(right, y, z) for y, z in yz_polygon]
    faces = [tuple(range(count - 1, -1, -1)), tuple(range(count, count * 2))]
    for index in range(count):
        nxt = (index + 1) % count
        faces.append((index, nxt, count + nxt, count + index))
    return mesh_object(name, vertices, faces, material, collection, root)


def loft(name, sections, material, collection, root, sides=8):
    vertices = []
    for y, width, z_bottom, z_top in sections:
        center = (z_top + z_bottom) / 2
        radius_z = (z_top - z_bottom) / 2
        for index in range(sides):
            angle = 2 * pi * index / sides
            vertices.append((width * cos(angle), y, center + radius_z * sin(angle)))
    faces = [tuple(range(sides - 1, -1, -1))]
    for section in range(len(sections) - 1):
        first = section * sides
        second = (section + 1) * sides
        for index in range(sides):
            nxt = (index + 1) % sides
            faces.append((first + index, first + nxt, second + nxt, second + index))
    last = (len(sections) - 1) * sides
    faces.append(tuple(last + index for index in range(sides)))
    return mesh_object(name, vertices, faces, material, collection, root)


def canopy(name, sections, material, collection, root):
    vertices = []
    arc_points = 5
    for y, width, base, top in sections:
        vertices.extend([
            (-width, y, base),
            (-width * 0.62, y, base + (top - base) * 0.70),
            (0, y, top),
            (width * 0.62, y, base + (top - base) * 0.70),
            (width, y, base),
        ])
    faces = []
    for section in range(len(sections) - 1):
        first = section * arc_points
        second = (section + 1) * arc_points
        for index in range(arc_points - 1):
            faces.append((first + index, first + index + 1,
                          second + index + 1, second + index))
        faces.append((first, second, second + 4, first + 4))
    faces.append(tuple(range(arc_points - 1, -1, -1)))
    last = (len(sections) - 1) * arc_points
    faces.append(tuple(last + index for index in range(arc_points)))
    return mesh_object(name, vertices, faces, material, collection, root)


def cube_part(name, location, scale, material, collection, root, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = (scale[0] / 2, scale[1] / 2, scale[2] / 2)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        modifier = obj.modifiers.new("Edge chamfers", "BEVEL")
        modifier.width = bevel
        modifier.segments = 1
        modifier.affect = "EDGES"
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    link_object(obj, collection)
    obj.parent = root
    obj.data.materials.append(material)
    return obj


def cylinder_part(name, location, radius, depth, material, collection, root,
                  vertices=10, rotation=(pi / 2, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices, radius=radius, depth=depth, location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    link_object(obj, collection)
    obj.parent = root
    obj.data.materials.append(material)
    return obj


def project_uv(obj):
    mesh = obj.data
    uv = mesh.uv_layers.get("UVMap") or mesh.uv_layers.new(name="UVMap")
    normal_matrix = obj.matrix_world.to_3x3()
    for polygon in mesh.polygons:
        normal = (normal_matrix @ polygon.normal).normalized()
        axis = max(range(3), key=lambda value: abs(normal[value]))
        for loop_index in polygon.loop_indices:
            vertex = mesh.vertices[mesh.loops[loop_index].vertex_index]
            world = obj.matrix_world @ vertex.co
            if axis == 2:
                u, v = world.x, world.y
            elif axis == 0:
                u, v = world.y, world.z
            else:
                u, v = world.x, world.z
            uv.data[loop_index].uv = (u / TILE_WORLD_SIZE + 0.5,
                                      v / TILE_WORLD_SIZE + 0.5)
    mesh.update()


def look_at(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def marker(name, location, collection, root):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "PLAIN_AXES"
    obj.empty_display_size = 0.08
    obj.location = location
    collection.objects.link(obj)
    obj.parent = root
    return obj


def consolidate_material_batches(collection):
    """Join decorative pieces by material to keep per-fighter draw calls low."""
    batch_names = {
        "Spitfire_ArmorSkin": "Spitfire_Armor",
        "Spitfire_Gunmetal": "Spitfire_GunmetalParts",
        "Spitfire_Red": "Spitfire_RedPanels",
        "Spitfire_Canopy": "Spitfire_Canopy",
        "Spitfire_EngineGlow": "Spitfire_EngineGlow",
    }
    groups = {}
    for obj in collection.all_objects:
        if obj.type != "MESH" or not obj.data.materials:
            continue
        groups.setdefault(obj.data.materials[0].name, []).append(obj)

    for material_name, objects in groups.items():
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        active = objects[0]
        bpy.context.view_layer.objects.active = active
        if len(objects) > 1:
            bpy.ops.object.join()
        active.name = batch_names.get(material_name, f"Spitfire_{material_name}")
        active.data.name = f"{active.name}_Mesh"


def build_ship():
    if not TEXTURE_PATH.exists():
        raise FileNotFoundError(TEXTURE_PATH)

    reset_scene()
    ship = new_collection(SHIP_COLLECTION)
    preview = new_collection("Spitfire_Preview")

    root = bpy.data.objects.new("Spitfire_MkII", None)
    root.empty_display_type = "PLAIN_AXES"
    ship.objects.link(root)

    skin = textured_material()
    dark_metal = principled_material("Spitfire_Gunmetal", (0.12, 0.095, 0.075), 0.38, 0.56)
    red = principled_material("Spitfire_Red", (0.34, 0.025, 0.018), 0.42, 0.48)
    glass = principled_material("Spitfire_Canopy", (0.015, 0.026, 0.035), 0.55, 0.19)
    orange = principled_material("Spitfire_EngineGlow", (0.16, 0.028, 0.005), 0.1, 0.34,
                                 emission=((1.0, 0.12, 0.015), 2.6))

    loft("Spitfire_Fuselage", [
        (2.18, 0.035, -0.03, 0.04),
        (1.62, 0.27, -0.17, 0.20),
        (0.86, 0.44, -0.24, 0.33),
        (0.12, 0.55, -0.27, 0.39),
        (-0.66, 0.46, -0.25, 0.31),
        (-1.38, 0.31, -0.19, 0.23),
        (-1.67, 0.18, -0.12, 0.14),
    ], skin, ship, root)

    canopy("Spitfire_Canopy", [
        (1.18, 0.14, 0.20, 0.30),
        (0.72, 0.31, 0.30, 0.56),
        (0.12, 0.35, 0.37, 0.64),
        (-0.28, 0.22, 0.31, 0.48),
    ], glass, ship, root)

    wing = [
        (0.34, 0.58), (0.62, 0.40), (2.04, -0.08),
        (2.06, -0.32), (1.86, -0.54), (0.42, -0.98),
    ]
    red_panel = [
        (0.70, 0.20), (1.70, -0.10), (1.67, -0.25),
        (1.47, -0.38), (0.66, -0.27),
    ]
    clipped_tip = [
        (1.78, 0.00), (2.04, -0.08), (2.06, -0.32),
        (1.86, -0.54), (1.72, -0.44),
    ]
    for side, suffix in ((1, "R"), (-1, "L")):
        polygon_prism(
            f"Spitfire_Wing_{suffix}", [(side * x, y) for x, y in wing],
            -0.12, 0.075, skin, ship, root,
        )
        polygon_prism(
            f"Spitfire_RedWing_{suffix}", [(side * x, y) for x, y in red_panel],
            0.077, 0.091, red, ship, root,
        )
        polygon_prism(
            f"Spitfire_ClippedTip_{suffix}", [(side * x, y) for x, y in clipped_tip],
            0.077, 0.093, dark_metal, ship, root,
        )
        cube_part(f"Spitfire_Shoulder_{suffix}", (side * 0.55, -0.24, 0.13),
                  (0.38, 1.04, 0.32), skin, ship, root, bevel=0.07)
        cube_part(f"Spitfire_Engine_{suffix}", (side * 0.61, -1.18, 0.03),
                  (0.44, 0.88, 0.38), dark_metal, ship, root, bevel=0.035)
        cube_part(f"Spitfire_NacelleArmor_{suffix}", (side * 0.61, -1.02, 0.03),
                  (0.56, 0.62, 0.52), skin, ship, root, bevel=0.045)
        cube_part(f"Spitfire_Nozzle_{suffix}", (side * 0.61, -1.64, 0.03),
                  (0.29, 0.045, 0.23), orange, ship, root, bevel=0.018)
        cylinder_part(f"Spitfire_WingGun_{suffix}", (side * 1.25, 0.25, -0.02),
                      0.075, 0.64, dark_metal, ship, root, vertices=8)
        cube_part(f"Spitfire_GunFairing_{suffix}", (side * 1.25, 0.06, -0.005),
                  (0.20, 0.48, 0.19), skin, ship, root, bevel=0.035)
        x_prism(
            f"Spitfire_Intake_{suffix}",
            [(0.57, 0.03), (0.18, 0.08), (-0.25, 0.08), (-0.34, 0.22), (0.34, 0.25)],
            side * 0.565, 0.025, dark_metal, ship, root,
        )
        x_prism(
            f"Spitfire_Fin_{suffix}",
            [(-1.53, 0.10), (-0.73, 0.13), (-1.03, 0.57), (-1.45, 0.48)],
            side * 0.69, 0.09, skin, ship, root,
        )

    polygon_prism("Spitfire_DorsalRed", [(-0.13, 0.25), (0.13, 0.25),
                                         (0.11, -0.72), (-0.11, -0.72)],
                  0.395, 0.414, red, ship, root)
    polygon_prism("Spitfire_NoseChin", [(-0.19, 1.65), (0.19, 1.65),
                                        (0.28, 1.20), (-0.28, 1.20)],
                  -0.205, -0.175, dark_metal, ship, root)
    cube_part("Spitfire_CanopySpine", (0, 0.36, 0.55), (0.035, 0.92, 0.045),
              dark_metal, ship, root, bevel=0.008)

    # Gameplay markers. Existing ship correction (scale .7, rotY pi) converts
    # these Blender +Y-forward points to the game's +Z-forward local frame.
    marker("muzzle.L", (1.25, 0.59, -0.02), ship, root)
    marker("muzzle.R", (-1.25, 0.59, -0.02), ship, root)
    marker("thruster.L", (0.61, -1.68, 0.03), ship, root)
    marker("thruster.R", (-0.61, -1.68, 0.03), ship, root)
    marker("rcs.nose", (0, 1.52, 0.0), ship, root)
    marker("rcs.port", (1.54, -0.32, 0.0), ship, root)
    marker("rcs.stbd", (-1.54, -0.32, 0.0), ship, root)

    for obj in ship.all_objects:
        if obj.type == "MESH" and obj.data.materials and obj.data.materials[0] == skin:
            project_uv(obj)

    consolidate_material_batches(ship)

    # Preview rig is intentionally outside the export collection.
    bpy.ops.object.camera_add(location=(4.8, 5.4, 3.9))
    camera = bpy.context.object
    camera.name = "Spitfire_PreviewCamera"
    link_object(camera, preview)
    camera.data.lens = 58
    look_at(camera, (0, 0.15, 0.0))
    bpy.context.scene.camera = camera

    for name, location, energy, size, color in (
        ("Key", (3.4, 4.1, 6.2), 1150, 4.0, (1.0, 0.84, 0.70)),
        ("Fill", (-4.5, 1.0, 3.4), 900, 4.0, (0.40, 0.57, 1.0)),
        ("Rim", (0.0, -4.5, 4.8), 1250, 3.0, (0.80, 0.90, 1.0)),
    ):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = size
        data.color = color
        light = bpy.data.objects.new(name, data)
        light.location = location
        preview.objects.link(light)
        look_at(light, (0, 0, 0))

    return ship


def save_export_render(ship):
    scene = bpy.context.scene
    # Blender 5.1 exposes the Eevee-next renderer under the legacy enum name.
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 960
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(PREVIEW_PATH)
    scene.render.film_transparent = False
    scene.world.color = (0.003, 0.006, 0.012)
    scene.view_settings.look = "AgX - Medium High Contrast"

    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH), check_existing=False)

    bpy.ops.object.select_all(action="DESELECT")
    for obj in ship.all_objects:
        obj.hide_set(False)
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=str(GLB_PATH), export_format="GLB", use_selection=True,
        export_yup=True, export_apply=True, export_image_format="JPEG",
        export_image_quality=84, export_jpeg_quality=84,
    )
    bpy.ops.render.render(write_still=True)


def main():
    ship = build_ship()
    save_export_render(ship)
    meshes = [obj for obj in ship.all_objects if obj.type == "MESH"]
    triangles = sum(len(poly.vertices) - 2 for obj in meshes for poly in obj.data.polygons)
    print("SPITFIRE_BUILD_RESULT", {
        "meshes": len(meshes), "triangles": triangles,
        "blend": str(BLEND_PATH), "glb": str(GLB_PATH),
        "preview": str(PREVIEW_PATH), "texture": str(TEXTURE_PATH),
    })


if __name__ == "__main__":
    main()
