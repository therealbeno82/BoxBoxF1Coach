# Bakes the two car assets the T-cam needs out of the Formula 2 model:
#
#   public/tcam-ego.png   the ego overlay — the bodywork you see from the onboard
#                         camera, rendered from that exact camera
#   public/tcam-car.glb   the ghost car — the OTHER car, drawn live in WebGL
#
# WHY THE EGO IS A BAKED IMAGE. The onboard camera is rigidly bolted to the car, so
# that geometry does not move in frame — ever. Rendering it live would recompute an
# identical transform 60 times a second. tcamScene's paintEgo already exploited that
# by drawing a halo hoop in SCREEN space; this replaces those strokes with the real
# car at the same zero runtime cost. The ghost car is the opposite case: it turns
# independently of the camera, so it has to be real geometry.
#
# Run headless (Blender is not on PATH; it's the Steam build):
#   "F:\Programs\Steam\steamapps\common\Blender\blender.exe" -b -P scripts/render-tcam-ego.py -- public
#
# Optional one-off framing test, which writes nothing else:
#   ... -- <out-dir> <setback-metres> <pitch-degrees>
#
# CAMERA. Every number here is read from src/lib/tcamProjection.js and must stay in
# step with it — if CAM_HEIGHT, CAM_SETBACK, CAM_PITCH, FOV_H or FOV_V_MAX change
# there, this render is stale and the car will no longer sit on the road.
import bpy, sys, os, math
import mathutils
from mathutils import Vector

CAM_HEIGHT  = 1.25   # m above the road
CAM_SETBACK = 0.35   # m behind the car's reference point (its centre)
CAM_PITCH   = 14.0   # degrees down
FOV_H       = 78.0   # degrees horizontal
FOV_V_MAX   = 68.0   # degrees vertical cap

# Cover the FULL vertical cap, not just a typical pane. The app anchors on horizontal
# FOV but takes whichever of the two constraints bites harder, so a tall narrow pane
# can legitimately ask for 68° of vertical — and an image rendered any shorter would
# run out partway down and cut the car off with a hard horizontal edge. Rendering the
# cap makes every pane shape a CROP of this one image.
RES_X = 1600
FOCAL_PX = (RES_X / 2) / math.tan(math.radians(FOV_H) / 2)
RES_Y = int(round(2 * FOCAL_PX * math.tan(math.radians(FOV_V_MAX) / 2)))

# ...but PREVIEW at what a real pane sees, which is much less. A 900x520 T-Cam pane
# takes the horizontal constraint, giving 2·atan(260/555.7) = 50.1° of vertical — so
# the bottom sixth of the shipped image is outside the view. Judging a camera
# position on the full 68° frame overstates how much of the car ends up on screen,
# which is exactly the mistake that hid the halo the first time round.
PANE_W, PANE_H = 900, 520
_pane_focal = max((PANE_W / 2) / math.tan(math.radians(FOV_H) / 2),
                  (PANE_H / 2) / math.tan(math.radians(FOV_V_MAX) / 2))
PREVIEW_VFOV = 2 * math.degrees(math.atan((PANE_H / 2) / _pane_focal))

# MODEL. "Formula 2 Car High Poly.blend" — Blender-native Z-up, X = length with the
# NOSE AT +X (measured: the 0.37 m front wing is at the +x end, the 0.91 m rear wing
# at −x). A −90° turn about Z aims the nose down −Y, which is both what the camera
# below expects and what the glTF exporter turns into +Z — the forward axis
# tcamCarLayer's modelYaw assumes.
#
# 1 unit = 0.5588 m, agreed three ways: overall width 3.40 u → 1.90 m (the regulated
# maximum), tyre diameter 1.19 u → 0.665 m, overall length 9.26 u → 5.18 m.
#
# Its geometry is driven by Geometry Nodes modifiers, so nothing here may read the
# base mesh — every count and bound has to come through the depsgraph, and the glTF
# export needs export_apply to bake them.
SCALE = 0.5588
BODY_MATERIAL = "Body"  # the one material that carries the lap colour, in both the
                        # ego mask below and tcamCarLayer's ghost tint
GHOST_DECIMATE = 0.15   # 96k tris → ~14k. The ghost never draws nearer than
                        # OTHER_MIN_Z = 8 m, where the car spans ~130 px on a 900 px
                        # pane; decimation artefacts cannot resolve at that size, and
                        # it takes the .glb from 2.8 MB to under 450 KB.

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLEND = os.path.join(HERE, "public", "Car Models", "Formula 2 Car High Poly.blend")

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[0] if argv else os.path.join(HERE, "public")
os.makedirs(OUT, exist_ok=True)
OVERRIDE = (float(argv[1]), float(argv[2])) if len(argv) >= 3 else None


def load_car():
    """Open the model and put it in ROAD coordinates: metres, nose along −Y, wheels
    on z = 0, origin between them. The camera and the ghost's placement are both
    expressed in those terms, so the model has to agree about where the road is."""
    bpy.ops.wm.open_mainfile(filepath=BLEND)
    # The file ships its own studio rig; we light and frame it ourselves.
    for o in [o for o in bpy.context.scene.objects if o.type in ('CAMERA', 'LIGHT')]:
        bpy.data.objects.remove(o, do_unlink=True)

    M = mathutils.Matrix.Rotation(math.radians(-90), 4, 'Z') @ mathutils.Matrix.Scale(SCALE, 4)
    for o in bpy.context.scene.objects:
        if o.parent is None:
            o.matrix_world = M @ o.matrix_world
    bpy.context.view_layer.update()

    lo = Vector((1e9,) * 3); hi = Vector((-1e9,) * 3)
    for o in bpy.context.scene.objects:
        if o.type != 'MESH':
            continue
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector((min(lo[i], w[i]) for i in range(3)))
            hi = Vector((max(hi[i], w[i]) for i in range(3)))
    shift = Vector((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z))
    for o in bpy.context.scene.objects:
        if o.parent is None:
            o.location += shift
    bpy.context.view_layer.update()
    return tuple(round(hi[i] - lo[i], 3) for i in range(3))


def tri_count():
    deps = bpy.context.evaluated_depsgraph_get()
    n = 0
    for o in bpy.context.scene.objects:
        if o.type != 'MESH':
            continue
        oe = o.evaluated_get(deps)
        me = oe.to_mesh()
        me.calc_loop_triangles()
        n += len(me.loop_triangles)
        oe.to_mesh_clear()
    return n


# ── The ego overlay ───────────────────────────────────────────────────────────
size = load_car()
print(f"[tcam-ego] model {size} m, {tri_count()} tris")

# Lighting aimed at a READABLE SILHOUETTE, not realism: this sits over a near-black
# road (#171d29), so the car needs enough light to separate from it without going so
# bright it competes with the racing line for attention.
world = bpy.data.worlds.new("W"); bpy.context.scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.12, 0.15, 0.22, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 1.1
sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", 'SUN'))
sun.data.energy = 4.0
sun.rotation_euler = (math.radians(52), 0, math.radians(35))
bpy.context.scene.collection.objects.link(sun)
fill = bpy.data.objects.new("Fill", bpy.data.lights.new("Fill", 'AREA'))
fill.data.energy = 300; fill.data.size = 6
fill.location = (-3.5, 3.0, 3.0)
fill.rotation_euler = (math.radians(55), 0, math.radians(-55))
bpy.context.scene.collection.objects.link(fill)

cam_data = bpy.data.cameras.new("TCam")
cam_data.sensor_fit = 'HORIZONTAL'
cam_data.angle = math.radians(FOV_H)
cam_data.clip_start = 0.05
cam = bpy.data.objects.new("TCam", cam_data)
bpy.context.scene.collection.objects.link(cam)
bpy.context.scene.camera = cam

scene = bpy.context.scene
for engine in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'CYCLES'):
    try:
        scene.render.engine = engine
        break
    except TypeError:
        continue
if scene.render.engine == 'CYCLES':
    scene.cycles.samples = 64
scene.render.film_transparent = True          # the app composites this over its road
scene.render.resolution_x = RES_X
scene.render.resolution_y = RES_Y
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.image_settings.compression = 100  # this ships; Blender's default is 15
scene.view_settings.view_transform = 'Standard'  # no filmic roll-off; this is UI art

setback, pitch = OVERRIDE if OVERRIDE else (CAM_SETBACK, CAM_PITCH)
if OVERRIDE:
    scene.render.resolution_y = int(round(2 * FOCAL_PX * math.tan(math.radians(PREVIEW_VFOV) / 2)))
    print(f"[tcam-ego] PREVIEW at pane FOV {FOV_H}x{PREVIEW_VFOV:.1f}° "
          f"({RES_X}x{scene.render.resolution_y}) — this is what a {PANE_W}x{PANE_H} pane shows")
# The car faces −Y, so "behind the reference point" is +Y. A Blender camera looks down
# its own −Z; (90°, 0, 180°) turns that to face −Y with +Z up, and taking the pitch
# off the first angle tips it toward the road.
cam.location = (0.0, setback, CAM_HEIGHT)
cam.rotation_euler = (math.radians(90 - pitch), 0, math.radians(180))
scene.render.filepath = os.path.join(OUT, "tcam-ego" if not OVERRIDE else
                                     f"tcam-ego-set{round(setback*100):02d}-p{pitch:g}")
bpy.ops.render.render(write_still=True)
print(f"[tcam-ego] ego overlay {RES_X}x{RES_Y}, focal {FOCAL_PX:.1f}px, "
      f"setback {setback:.2f} m, pitch {pitch}°")

if OVERRIDE:
    print("[tcam-ego] override render only — skipping the mask and ghost export")
    sys.exit(0)

# ── The body mask ─────────────────────────────────────────────────────────────
# A second pass over the SAME camera whose alpha channel is "this pixel is bodywork".
# The app multiplies the accent through it, which is the only way to confine the lap
# colour to the body: the overlay is a flat image, so without this it has no idea
# which pixels are paintwork and which are rubber. A luminance-based tint was tried
# first and washes blue over the whole car, tyres included.
#
# Body becomes a plain white emission — no lighting, so the mask is a clean cutout
# rather than a shaded one. Everything else becomes a HOLDOUT, which is the load-
# bearing choice: holdout punches alpha to zero while still writing depth, so a
# wishbone crossing in front of the sidepod correctly masks the body behind it.
# Making those materials merely transparent would let the body show through and tint
# the wishbone's own pixels.
for mat in bpy.data.materials:
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    if mat.name == BODY_MATERIAL:
        n = nt.nodes.new('ShaderNodeEmission')
        n.inputs['Color'].default_value = (1, 1, 1, 1)
        n.inputs['Strength'].default_value = 1.0
    else:
        n = nt.nodes.new('ShaderNodeHoldout')
    nt.links.new(n.outputs[0], out.inputs['Surface'])

scene.render.filepath = os.path.join(OUT, "tcam-ego-mask")
bpy.ops.render.render(write_still=True)
print(f"[tcam-ego] body mask written (material '{BODY_MATERIAL}' white, rest holdout)")

# ── The ghost car ─────────────────────────────────────────────────────────────
# Reload clean: the ego pass added lights and a camera, and export_lights/cameras
# being off would drop them anyway, but a fresh file keeps the two independent.
load_car()
for o in bpy.context.scene.objects:
    if o.type != 'MESH':
        continue
    d = o.modifiers.new(name="ghost-decimate", type='DECIMATE')
    d.ratio = GHOST_DECIMATE
glb = os.path.join(OUT, "tcam-car.glb")
bpy.ops.export_scene.gltf(
    filepath=glb, export_format='GLB',
    export_apply=True,               # bakes Geometry Nodes AND the decimate above
    export_materials='EXPORT',
    export_cameras=False, export_lights=False,
)
print(f"[tcam-ego] ghost car {tri_count()} tris, {os.path.getsize(glb)/1024:.1f} KB → {glb}")
