"""Build the in-house Novari Wraith Mk II and export its runtime GLB.

Run with:

    Blender --background --factory-startup --python scripts/build_wraith.py

The fighter is authored nose-along Blender -Y, matching the project's modern
fighter convention and the existing identity runtime correction.
"""

from math import cos, pi, sin
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
BLEND_PATH = ROOT / "art" / "wraith.blend"
TEXTURE_PATH = ROOT / "art" / "textures" / "wraith_armor.png"
GLB_PATH = ROOT / "client" / "public" / "models" / "wraith.glb"
PREVIEW_PATH = ROOT / "art" / "pictures" / "wraith_mk2_preview.png"

SHIP_COLLECTION = "Wraith"
TILE_WORLD_SIZE = 5.0


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.materials,
                       bpy.data.cameras, bpy.data.lights):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)


def collection(name):
    result = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(result)
    return result


def relink(obj, target):
    for existing in list(obj.users_collection):
        existing.objects.unlink(obj)
    target.objects.link(obj)


def flat_material(name, color, metallic, roughness, emission=None):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = 0.12
    if emission:
        socket = "Emission Color" if "Emission Color" in bsdf.inputs else "Emission"
        bsdf.inputs[socket].default_value = (*emission[0], 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission[1]
    return material


def armor_material():
    image = bpy.data.images.load(str(TEXTURE_PATH), check_existing=False)
    image.name = "wraith_armor"
    image.colorspace_settings.name = "sRGB"
    image.pack()

    material = bpy.data.materials.new("Wraith_ArmorSkin")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    output.location = (430, 0)
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (120, 0)
    texture = nodes.new("ShaderNodeTexImage")
    texture.location = (-260, 20)
    texture.image = image
    texture.interpolation = "Linear"
    texture.extension = "REPEAT"
    # The Wraith is intentionally a bright ceramic-metal, not a dark mirror.
    # A small texture-driven emissive floor survives ACES/starfield grading at
    # fighter scale without being added to the game's GlowLayer.
    bsdf.inputs["Metallic"].default_value = 0.16
    bsdf.inputs["Roughness"].default_value = 0.58
    emission_socket = "Emission Color" if "Emission Color" in bsdf.inputs else "Emission"
    bsdf.inputs["Emission Strength"].default_value = 0.10
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = 0.15
    links.new(texture.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(texture.outputs["Color"], bsdf.inputs[emission_socket])
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
    return material


def mesh_object(name, vertices, faces, material, target, root):
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    target.objects.link(obj)
    obj.parent = root
    obj.data.materials.append(material)
    for polygon in mesh.polygons:
        polygon.use_smooth = False
    return obj


def polygon_prism(name, polygon, z_bottom, z_top, material, target, root):
    count = len(polygon)
    vertices = [(x, y, z_bottom) for x, y in polygon]
    vertices += [(x, y, z_top) for x, y in polygon]
    faces = [tuple(range(count - 1, -1, -1)), tuple(range(count, count * 2))]
    for index in range(count):
        nxt = (index + 1) % count
        faces.append((index, nxt, count + nxt, count + index))
    return mesh_object(name, vertices, faces, material, target, root)


def x_prism(name, yz_polygon, x_center, thickness, material, target, root):
    count = len(yz_polygon)
    left, right = x_center - thickness / 2, x_center + thickness / 2
    vertices = [(left, y, z) for y, z in yz_polygon]
    vertices += [(right, y, z) for y, z in yz_polygon]
    faces = [tuple(range(count - 1, -1, -1)), tuple(range(count, count * 2))]
    for index in range(count):
        nxt = (index + 1) % count
        faces.append((index, nxt, count + nxt, count + index))
    return mesh_object(name, vertices, faces, material, target, root)


def loft(name, sections, material, target, root, sides=8):
    vertices = []
    for y, width, z_bottom, z_top in sections:
        center = (z_top + z_bottom) / 2
        radius_z = (z_top - z_bottom) / 2
        for index in range(sides):
            angle = 2 * pi * index / sides
            vertices.append((width * cos(angle), y,
                             center + radius_z * sin(angle)))
    faces = [tuple(range(sides - 1, -1, -1))]
    for section in range(len(sections) - 1):
        first, second = section * sides, (section + 1) * sides
        for index in range(sides):
            nxt = (index + 1) % sides
            faces.append((first + index, first + nxt,
                          second + nxt, second + index))
    last = (len(sections) - 1) * sides
    faces.append(tuple(last + index for index in range(sides)))
    return mesh_object(name, vertices, faces, material, target, root)


def canopy(name, sections, material, target, root):
    vertices = []
    for y, width, base, top in sections:
        vertices.extend([
            (-width, y, base), (-width * 0.58, y, base + (top - base) * 0.72),
            (0, y, top), (width * 0.58, y, base + (top - base) * 0.72),
            (width, y, base),
        ])
    faces = []
    for section in range(len(sections) - 1):
        first, second = section * 5, (section + 1) * 5
        for index in range(4):
            faces.append((first + index, first + index + 1,
                          second + index + 1, second + index))
        faces.append((first, second, second + 4, first + 4))
    faces.append((4, 3, 2, 1, 0))
    last = (len(sections) - 1) * 5
    faces.append(tuple(last + index for index in range(5)))
    return mesh_object(name, vertices, faces, material, target, root)


def cube_part(name, location, dimensions, material, target, root, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = tuple(value / 2 for value in dimensions)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        modifier = obj.modifiers.new("Faceted chamfers", "BEVEL")
        modifier.width = bevel
        modifier.segments = 1
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    relink(obj, target)
    obj.parent = root
    obj.data.materials.append(material)
    return obj


def cylinder(name, location, radius, depth, material, target, root, vertices=10):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices, radius=radius, depth=depth, location=location,
        rotation=(pi / 2, 0, 0),
    )
    obj = bpy.context.object
    obj.name = name
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    relink(obj, target)
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


def consolidate(target):
    names = {
        "Wraith_ArmorSkin": "Wraith_Armor",
        "Wraith_Structure": "Wraith_Structure",
        "Wraith_Canopy": "Wraith_Canopy",
        "Wraith_CyanGlow": "Wraith_CyanGlow",
    }
    groups = {}
    for obj in target.all_objects:
        if obj.type == "MESH" and obj.data.materials:
            groups.setdefault(obj.data.materials[0].name, []).append(obj)
    for material_name, objects in groups.items():
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        active = objects[0]
        bpy.context.view_layer.objects.active = active
        if len(objects) > 1:
            bpy.ops.object.join()
        active.name = names[material_name]
        active.data.name = f"{active.name}_Mesh"


def look_at(obj, point):
    obj.rotation_euler = (Vector(point) - obj.location).to_track_quat("-Z", "Y").to_euler()


def build():
    if not TEXTURE_PATH.exists():
        raise FileNotFoundError(TEXTURE_PATH)
    reset_scene()
    ship = collection(SHIP_COLLECTION)
    preview = collection("Wraith_Preview")
    root = bpy.data.objects.new("Wraith_MkII", None)
    root.empty_display_type = "PLAIN_AXES"
    ship.objects.link(root)

    armor = armor_material()
    structure = flat_material("Wraith_Structure", (0.025, 0.085, 0.09), 0.30, 0.54)
    glass = flat_material("Wraith_Canopy", (0.018, 0.075, 0.085), 0.24, 0.25,
                         emission=((0.01, 0.08, 0.09), 0.22))
    cyan = flat_material("Wraith_CyanGlow", (0.0, 0.22, 0.32), 0.08, 0.32,
                        emission=((0.0, 0.85, 1.0), 2.4))

    loft("Wraith_DaggerFuselage", [
        (-4.28, 0.04, -0.04, 0.05), (-3.48, 0.52, -0.22, 0.26),
        (-2.15, 0.86, -0.34, 0.40), (-0.48, 0.92, -0.39, 0.56),
        (1.25, 0.66, -0.30, 0.48), (2.72, 0.38, -0.20, 0.31),
        (3.42, 0.18, -0.11, 0.17),
    ], armor, ship, root)

    canopy("Wraith_CanopyShell", [
        (-2.02, 0.20, 0.28, 0.40), (-1.25, 0.54, 0.39, 0.78),
        (-0.12, 0.58, 0.53, 0.91), (0.66, 0.34, 0.46, 0.68),
    ], glass, ship, root)

    wing = [
        (0.67, -1.42), (1.20, -2.02), (3.28, -1.42),
        (3.55, -0.62), (3.10, 0.48), (1.46, 1.43), (0.72, 0.82),
    ]
    channel = [
        (1.10, -1.46), (2.98, -1.13), (3.10, -0.92),
        (1.18, -1.17),
    ]
    for side, suffix in ((1, "R"), (-1, "L")):
        polygon_prism(f"Wraith_Blade_{suffix}", [(side * x, y) for x, y in wing],
                      -0.17, 0.07, armor, ship, root)
        polygon_prism(f"Wraith_WingChannel_{suffix}",
                      [(side * x, y) for x, y in channel],
                      0.072, 0.09, cyan, ship, root)
        cylinder(f"Wraith_Nacelle_{suffix}", (side * 1.18, 1.20, 0.24),
                 0.49, 2.92, armor, ship, root, vertices=10)
        cylinder(f"Wraith_Intake_{suffix}", (side * 1.18, -0.28, 0.24),
                 0.37, 0.06, structure, ship, root, vertices=10)
        cylinder(f"Wraith_EngineCore_{suffix}", (side * 1.18, 2.69, 0.24),
                 0.34, 0.07, cyan, ship, root, vertices=10)
        cylinder(f"Wraith_WingGun_{suffix}", (side * 3.06, -1.50, -0.02),
                 0.115, 0.90, structure, ship, root, vertices=8)
        cylinder(f"Wraith_MuzzleGlow_{suffix}", (side * 3.06, -1.97, -0.02),
                 0.082, 0.035, cyan, ship, root, vertices=8)
        x_prism(f"Wraith_Fin_{suffix}",
                [(1.25, 0.30), (2.72, 0.26), (2.28, 0.91), (1.46, 0.79)],
                side * 1.18, 0.10, armor, ship, root)

    polygon_prism("Wraith_SpineChannel", [(-0.10, -1.05), (0.10, -1.05),
                                           (0.09, 1.78), (-0.09, 1.78)],
                  0.565, 0.59, cyan, ship, root)
    polygon_prism("Wraith_VentralKeel", [(-0.20, -2.76), (0.20, -2.76),
                                          (0.34, 1.62), (-0.34, 1.62)],
                  -0.45, -0.38, structure, ship, root)

    for obj in ship.all_objects:
        if obj.type == "MESH" and obj.data.materials and obj.data.materials[0] == armor:
            project_uv(obj)
    consolidate(ship)

    bpy.ops.object.camera_add(location=(8.5, -9.8, 6.7))
    camera = bpy.context.object
    camera.name = "Wraith_PreviewCamera"
    relink(camera, preview)
    camera.data.lens = 58
    look_at(camera, (0, -0.2, 0.0))
    bpy.context.scene.camera = camera

    for name, position, energy, size, color in (
        ("Key", (4.8, -5.2, 8.0), 1200, 5.0, (0.72, 0.95, 1.0)),
        ("Fill", (-5.5, -1.5, 4.5), 850, 4.0, (0.36, 0.65, 0.82)),
        ("Rim", (0.0, 6.0, 5.5), 1250, 4.0, (0.45, 1.0, 0.92)),
    ):
        data = bpy.data.lights.new(name, "AREA")
        data.energy, data.shape, data.size, data.color = energy, "DISK", size, color
        light = bpy.data.objects.new(name, data)
        light.location = position
        preview.objects.link(light)
        look_at(light, (0, 0, 0))
    return ship


def save_export_render(ship):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 960, 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(PREVIEW_PATH)
    scene.world.color = (0.002, 0.005, 0.009)
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
    ship = build()
    save_export_render(ship)
    meshes = [obj for obj in ship.all_objects if obj.type == "MESH"]
    triangles = sum(len(poly.vertices) - 2 for obj in meshes for poly in obj.data.polygons)
    print("WRAITH_BUILD_RESULT", {
        "meshes": len(meshes), "triangles": triangles,
        "blend": str(BLEND_PATH), "glb": str(GLB_PATH),
        "preview": str(PREVIEW_PATH), "texture": str(TEXTURE_PATH),
    })


if __name__ == "__main__":
    main()
