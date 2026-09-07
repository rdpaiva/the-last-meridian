"""Apply the lightweight Reaver armor skin and export its runtime GLB.

Run inside Blender, either from the scripting workspace or in background mode:

    Blender --background art/reaver.blend --python scripts/skin_reaver.py

The script keeps every mesh object and gameplay marker intact. Structural hull
faces share one repeating 1024px texture; the cockpit, cyan emitters, and core
remain separate materials so the Reaver follows the Novari visual language
without washing its purple armor in bloom. UVs use world-space box projection
so the Reaver's many breakup pieces retain consistent texel density.
"""

from pathlib import Path

import bpy


ROOT = Path(__file__).resolve().parents[1]
BLEND_PATH = ROOT / "art" / "reaver.blend"
TEXTURE_PATH = ROOT / "art" / "textures" / "reaver_armor.png"
GLB_PATH = ROOT / "client" / "public" / "models" / "reaver.glb"

COLLECTION_NAME = "Reaver"
SKIN_MATERIAL_NAME = "Reaver_ArmorSkin"
CANOPY_MATERIAL_NAME = "Reaver_CanopyGlass"
GLOW_MATERIAL_NAME = "Reaver_Glow"
CORE_MATERIAL_NAME = "Reaver_GlowCore"
SKINNED_MATERIALS = {"Reaver_Hull", "Reaver_HullDark", "Reaver_Ridge"}
TILE_WORLD_SIZE = 6.5


def load_texture() -> bpy.types.Image:
    # Always reload the lossless source so replacing the PNG and re-running the
    # helper updates an already-packed .blend instead of reusing stale pixels.
    old = bpy.data.images.get("reaver_armor")
    if old is not None:
        bpy.data.images.remove(old)
    image = bpy.data.images.load(str(TEXTURE_PATH), check_existing=False)
    image.name = "reaver_armor"
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

    # True black is now part of the livery, but only on inset panels. Keep the
    # broad purple armor diffuse and give its own albedo a very low emissive
    # floor so ACES/starfield grading cannot erase the silhouette. The hull
    # meshes are not registered with the GlowLayer, so this does not add bloom.
    bsdf.inputs["Metallic"].default_value = 0.18
    bsdf.inputs["Roughness"].default_value = 0.58
    emission_socket = "Emission Color" if "Emission Color" in bsdf.inputs else "Emission"
    bsdf.inputs["Emission Strength"].default_value = 0.12
    links.new(texture.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(texture.outputs["Color"], bsdf.inputs[emission_socket])
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
    return material


def configure_flat_material(
    name: str,
    *,
    base: tuple[float, float, float],
    metallic: float,
    roughness: float,
    emission: tuple[float, float, float],
    emission_strength: float,
    coat: float = 0.0,
) -> bpy.types.Material:
    """Create or retune one lightweight Principled material in place."""
    material = bpy.data.materials.get(name)
    if material is None:
        material = bpy.data.materials.new(name)
    material.use_nodes = True

    nodes = material.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    if bsdf is None:
        nodes.clear()
        output = nodes.new("ShaderNodeOutputMaterial")
        output.location = (280, 0)
        bsdf = nodes.new("ShaderNodeBsdfPrincipled")
        material.node_tree.links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])

    bsdf.inputs["Base Color"].default_value = (*base, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    emission_socket = "Emission Color" if "Emission Color" in bsdf.inputs else "Emission"
    bsdf.inputs[emission_socket].default_value = (*emission, 1.0)
    bsdf.inputs["Emission Strength"].default_value = emission_strength
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = coat
    material.diffuse_color = (*base, 1.0)
    return material


def apply_novari_emissives() -> dict[str, int]:
    """Replace the pink glow language with restrained Novari cyan/teal."""
    canopy = configure_flat_material(
        CANOPY_MATERIAL_NAME,
        base=(0.012, 0.055, 0.070),
        metallic=0.24,
        roughness=0.24,
        emission=(0.008, 0.080, 0.095),
        emission_strength=0.24,
        coat=0.18,
    )
    configure_flat_material(
        GLOW_MATERIAL_NAME,
        base=(0.0, 0.15, 0.20),
        metallic=0.06,
        roughness=0.34,
        emission=(0.0, 0.85, 1.0),
        emission_strength=1.45,
    )
    configure_flat_material(
        CORE_MATERIAL_NAME,
        base=(0.01, 0.18, 0.22),
        metallic=0.04,
        roughness=0.30,
        emission=(0.16, 0.90, 1.0),
        emission_strength=1.80,
    )

    canopy_meshes = 0
    for obj in bpy.data.objects:
        if obj.type != "MESH" or obj.name != "Reaver_Canopy":
            continue
        for index, slot in enumerate(obj.data.materials):
            if slot and slot.name in {GLOW_MATERIAL_NAME, CANOPY_MATERIAL_NAME}:
                obj.data.materials[index] = canopy
                canopy_meshes += 1
    return {"canopy_meshes": canopy_meshes}


def project_uv(mesh_object: bpy.types.Object) -> None:
    """World-space box projection with one stable scale across every part."""
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
    target_names = SKINNED_MATERIALS | {SKIN_MATERIAL_NAME}
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue

        project_uv(obj)
        mesh = obj.data
        original_names = [slot.name if slot else "" for slot in mesh.materials]
        target_indices = {
            index for index, name in enumerate(original_names) if name in target_names
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
    emissives = apply_novari_emissives()

    # Preserve the user's existing .blend1 backup when saving the source.
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH), check_existing=False)
    selected = export_glb()

    markers = sorted(
        obj.name
        for obj in bpy.data.objects
        if obj.type == "EMPTY" and obj.name != "Reaver_Gunship"
    )
    print(
        "REAVER_SKIN_RESULT",
        {
            **changed,
            **emissives,
            "selected_objects": selected,
            "markers": markers,
            "texture": str(TEXTURE_PATH),
            "blend": str(BLEND_PATH),
            "glb": str(GLB_PATH),
        },
    )


if __name__ == "__main__":
    main()
