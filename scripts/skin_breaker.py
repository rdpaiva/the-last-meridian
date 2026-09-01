"""Apply the lightweight Breaker armor skin and export its runtime GLB.

Run inside Blender, either from the scripting workspace or in background mode:

    Blender --background art/breaker.blend --python scripts/skin_breaker.py

The script deliberately keeps every mesh object and gameplay marker intact.
Structural hull faces share one repeating 1024px texture; canopy and gunmetal
parts retain their authored materials.  UVs use world-space box projection so
separate breakup pieces have consistent texel density without being joined.
"""

from pathlib import Path

import bpy


ROOT = Path(__file__).resolve().parents[1]
BLEND_PATH = ROOT / "art" / "breaker.blend"
TEXTURE_PATH = ROOT / "art" / "textures" / "breaker_armor.png"
GLB_PATH = ROOT / "client" / "public" / "models" / "breaker.glb"

COLLECTION_NAME = "Breaker"
SKIN_MATERIAL_NAME = "Breaker_ArmorSkin"
SKINNED_MATERIALS = {"tan", "tanLight", "hullDark", "hullMid"}
TILE_WORLD_SIZE = 5.5


def load_texture() -> bpy.types.Image:
    image = bpy.data.images.get("breaker_armor")
    if image is None:
        image = bpy.data.images.load(str(TEXTURE_PATH), check_existing=True)
    image.name = "breaker_armor"
    image.colorspace_settings.name = "sRGB"
    image.pack()
    return image


def make_skin_material(image: bpy.types.Image) -> bpy.types.Material:
    material = bpy.data.materials.get(SKIN_MATERIAL_NAME)
    if material is None:
        material = bpy.data.materials.new(SKIN_MATERIAL_NAME)
    material.use_nodes = True

    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()

    output = nodes.new("ShaderNodeOutputMaterial")
    output.location = (360, 0)
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (80, 0)
    texture = nodes.new("ShaderNodeTexImage")
    texture.location = (-260, 40)
    texture.image = image
    texture.interpolation = "Linear"
    texture.extension = "REPEAT"

    # Painted military alloy: enough metallic response to catch the game's IBL,
    # but rough enough that the color pattern stays legible from above.
    bsdf.inputs["Metallic"].default_value = 0.52
    bsdf.inputs["Roughness"].default_value = 0.66
    links.new(texture.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
    return material


def project_uv(mesh_object: bpy.types.Object) -> None:
    """World-space box projection with a stable scale across all mesh parts."""
    mesh = mesh_object.data
    uv_layer = mesh.uv_layers.get("UVMap") or mesh.uv_layers.new(name="UVMap")
    mesh.uv_layers.active = uv_layer
    normal_matrix = mesh_object.matrix_world.to_3x3()

    for polygon in mesh.polygons:
        world_normal = (normal_matrix @ polygon.normal).normalized()
        dominant_axis = max(range(3), key=lambda axis: abs(world_normal[axis]))
        for loop_index in polygon.loop_indices:
            vertex = mesh.vertices[mesh.loops[loop_index].vertex_index]
            world = mesh_object.matrix_world @ vertex.co
            if dominant_axis == 2:  # deck/belly: X/Y
                u, v = world.x, world.y
            elif dominant_axis == 0:  # port/starboard flank: Y/Z
                u, v = world.y, world.z
            else:  # bow/stern face: X/Z
                u, v = world.x, world.z
            uv_layer.data[loop_index].uv = (u / TILE_WORLD_SIZE, v / TILE_WORLD_SIZE)
    mesh.update()


def apply_skin(material: bpy.types.Material) -> dict[str, int]:
    mesh_count = 0
    face_count = 0
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue

        project_uv(obj)
        mesh = obj.data
        original_names = [slot.name if slot else "" for slot in mesh.materials]
        target_indices = {
            index for index, name in enumerate(original_names) if name in SKINNED_MATERIALS
        }
        if not target_indices:
            continue

        skin_index = next(
            (index for index, slot in enumerate(mesh.materials) if slot == material),
            None,
        )
        if skin_index is None:
            skin_index = len(mesh.materials)
            mesh.materials.append(material)

        changed = 0
        for polygon in mesh.polygons:
            if polygon.material_index in target_indices:
                polygon.material_index = skin_index
                changed += 1
        if changed:
            mesh_count += 1
            face_count += changed
            mesh.update()
    return {"meshes": mesh_count, "faces": face_count}


def select_export_collection() -> int:
    collection = bpy.data.collections.get(COLLECTION_NAME)
    if collection is None:
        raise RuntimeError(f"Missing collection: {COLLECTION_NAME}")

    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    selected = 0
    for obj in collection.all_objects:
        if obj.hide_render:
            continue
        obj.hide_set(False)
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        selected += 1
    return selected


def export_glb() -> int:
    selected = select_export_collection()
    bpy.ops.export_scene.gltf(
        filepath=str(GLB_PATH),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_image_format="JPEG",
        export_image_quality=84,
        export_jpeg_quality=84,
    )
    return selected


def main() -> None:
    if not TEXTURE_PATH.exists():
        raise FileNotFoundError(TEXTURE_PATH)

    image = load_texture()
    material = make_skin_material(image)
    changed = apply_skin(material)

    # Do not overwrite the user's .blend1 backup when saving the updated source.
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH), check_existing=False)
    selected = export_glb()

    markers = sorted(
        obj.name
        for obj in bpy.data.objects
        if obj.type == "EMPTY" and obj.name != "Breaker_Gunship"
    )
    print(
        "BREAKER_SKIN_RESULT",
        {
            **changed,
            "selected_objects": selected,
            "markers": markers,
            "texture": str(TEXTURE_PATH),
            "blend": str(BLEND_PATH),
            "glb": str(GLB_PATH),
        },
    )


if __name__ == "__main__":
    main()
