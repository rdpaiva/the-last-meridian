# blender -b --factory-startup --python decimate.py -- in.glb out.glb ratio
import bpy, sys
a = sys.argv[sys.argv.index('--') + 1:]
src, out, ratio = a[0], a[1], float(a[2])
SMOOTH = float(a[3]) if len(a) > 3 else 0
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
# Film files carry animations (e.g. carrier launch doors). The importer poses animated nodes at frame 0;
# drop the animation and put those nodes back to their static glTF pose (glTF Y-up quat → Blender Z-up).
import json, struct
with open(src, 'rb') as fh:
    fh.seek(12); ln, _ = struct.unpack('<II', fh.read(8)); gj = json.loads(fh.read(ln))
static = {n.get('name'): n for n in gj.get('nodes', [])}
for ob in bpy.context.scene.objects:
    if not ob.animation_data: continue
    ob.animation_data_clear()
    n = static.get(ob.name)
    if n and 'rotation' in n:
        x, y, z, w = n['rotation']; ob.rotation_mode = 'QUATERNION'; ob.rotation_quaternion = (w, x, -z, y)
        print(f'  restored static pose of {ob.name}')
for act in list(bpy.data.actions): bpy.data.actions.remove(act)
before = after = 0
for ob in [o for o in bpy.context.scene.objects if o.type == 'MESH']:
    me = ob.data
    def glows(mat):
        if not mat or not mat.use_nodes: return False
        for nd in mat.node_tree.nodes:
            if nd.type == 'BSDF_PRINCIPLED':
                c = nd.inputs['Emission Color'].default_value; st = nd.inputs['Emission Strength'].default_value
                if st > 0 and max(c[0], c[1], c[2]) > 0.1: return True
            if nd.type == 'EMISSION': return True
        return False
    glow = any(glows(sl.material) for sl in ob.material_slots)
    if (glow and len(me.polygons) < 3000) or 'canopy' in ob.name.lower() or len(me.polygons) < 600:  # glow planes, canopy and small parts: keep full detail
        n = sum(len(p.vertices) - 2 for p in me.polygons); before += n; after += n; continue
    before += sum(len(p.vertices) - 2 for p in me.polygons)
    bpy.context.view_layer.objects.active = ob
    for o in bpy.context.selected_objects: o.select_set(False)
    ob.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=0.0005)   # UVs live on loops, so welding keeps them
    bpy.ops.object.mode_set(mode='OBJECT')
    import mathutils
    def span(o): return [max(v.co[i] for v in o.data.vertices) - min(v.co[i] for v in o.data.vertices) for i in range(3)]
    s0 = span(ob); src_mesh = ob.data.copy()
    for r in (ratio, ratio * 2, ratio * 4, ratio * 8, 1.0):   # collapse can throw spikes on thin/non-manifold parts: retry gentler
        if r >= 1.0: break
        m = ob.modifiers.new('dec', 'DECIMATE'); m.decimate_type = 'COLLAPSE'; m.ratio = r; m.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier='dec')
        if all(a <= b * 1.005 + 1e-4 for a, b in zip(span(ob), s0)): break
        print(f'  spike on {ob.name} at ratio {r:.3f}, retrying'); ob.data = src_mesh.copy()
    if SMOOTH:
        try: bpy.ops.object.shade_auto_smooth(angle=SMOOTH)
        except Exception: pass
    else: bpy.ops.object.shade_flat()   # faceted armour reads like the film's hard panels
    after += len(ob.data.polygons)
print(f'DECIMATE {before} -> {after} tris')
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_tangents=False, export_yup=True)
