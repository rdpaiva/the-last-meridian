import type { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import { Vector3, Matrix } from "@babylonjs/core/Maths/math.vector";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import { Effect } from "@babylonjs/core/Materials/effect";

import { GameConfig } from "./GameConfig";

const MAX_RIPPLES = 4;
const SHADER_NAME = "jumpRipple";

/**
 * Screen-space jump shockwave (docs/JUMP-DRIVE-AND-RESUPPLY.md → jump FX). A
 * full-screen post-process that REFRACTS the rendered scene: a wavefront
 * expands from each jump point and the area behind it ripples and settles like
 * a pond, so the starfield and ships warp THROUGH it (a solid mesh ring can't
 * do that — it just draws over the top). View-only, fired off the jumpFired
 * SimEvent.
 *
 * The post-process is detached from the camera whenever no ripple is live, so
 * it costs nothing in the common case; spawn() re-attaches it. Up to
 * MAX_RIPPLES run at once (a jump spawns two — departure + arrival).
 */
export class JumpRipple {
  private readonly pp: PostProcess;
  private attached = false;
  private readonly ripples: { world: Vector3; ageMs: number }[] = [];

  // Flattened uniform arrays (vec2 centers, vec3 params), refreshed each frame.
  private readonly centers = new Array(MAX_RIPPLES * 2).fill(0);
  private readonly params = new Array(MAX_RIPPLES * 3).fill(0);
  private rippleCount = 0;
  private aspect = 1;
  private readonly projected = new Vector3();

  constructor(
    private readonly scene: Scene,
    private readonly camera: Camera,
  ) {
    registerShader();
    this.pp = new PostProcess(
      SHADER_NAME,
      SHADER_NAME,
      ["aspect", "frequency", "trailLength", "highlight", "rippleCount", "centers", "params"],
      null,
      1.0,
      camera,
      undefined,
      scene.getEngine(),
    );
    // Constructed attached; detach until a ripple is live (zero idle cost).
    camera.detachPostProcess(this.pp);

    this.pp.onApply = (effect) => {
      const r = GameConfig.jumpFx.ripple;
      effect.setFloat("aspect", this.aspect);
      effect.setFloat("frequency", r.frequency);
      effect.setFloat("trailLength", r.trailLength);
      effect.setFloat("highlight", r.highlight);
      effect.setInt("rippleCount", this.rippleCount);
      effect.setArray2("centers", this.centers);
      effect.setArray3("params", this.params);
    };
  }

  /** Start a ripple at a world position (its screen center is tracked each frame). */
  spawn(world: Vector3): void {
    if (this.ripples.length >= MAX_RIPPLES) this.ripples.shift();
    this.ripples.push({ world: world.clone(), ageMs: 0 });
    if (!this.attached) {
      this.camera.attachPostProcess(this.pp);
      this.attached = true;
    }
  }

  update(deltaMs: number): void {
    const dur = GameConfig.jumpFx.ripple.durationMs;
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      this.ripples[i].ageMs += deltaMs;
      if (this.ripples[i].ageMs >= dur) this.ripples.splice(i, 1);
    }
    if (this.ripples.length === 0) {
      if (this.attached) {
        this.camera.detachPostProcess(this.pp);
        this.attached = false;
      }
      this.rippleCount = 0;
      return;
    }

    const engine = this.scene.getEngine();
    const w = engine.getRenderWidth();
    const h = engine.getRenderHeight();
    this.aspect = h > 0 ? w / h : 1;
    const vp = this.camera.viewport.toGlobal(w, h);
    const transform = this.scene.getTransformMatrix();
    const rcfg = GameConfig.jumpFx.ripple;

    let n = 0;
    for (const r of this.ripples) {
      const t = r.ageMs / dur; // 0..1
      Vector3.ProjectToRef(
        r.world,
        Matrix.IdentityReadOnly,
        transform,
        vp,
        this.projected,
      );
      // Project gives screen pixels, origin top-left, y down; vUV is y-up.
      this.centers[n * 2] = this.projected.x / w;
      this.centers[n * 2 + 1] = 1 - this.projected.y / h;
      const ease = 1 - (1 - t) * (1 - t); // easeOutQuad: fast then slowing
      this.params[n * 3] = rcfg.maxRadius * ease; // wavefront radius
      this.params[n * 3 + 1] = rcfg.strength * (1 - t); // refraction strength, fading
      this.params[n * 3 + 2] = rcfg.width; // wavefront band width
      n++;
    }
    // Zero the strength of any unused slots so a stale entry never refracts.
    for (let i = n; i < MAX_RIPPLES; i++) this.params[i * 3 + 1] = 0;
    this.rippleCount = n;
  }

  dispose(): void {
    if (this.attached) this.camera.detachPostProcess(this.pp);
    this.pp.dispose();
  }
}

let shaderRegistered = false;

/**
 * Register the ripple fragment shader once. For each pixel it sums every live
 * ripple's radial displacement — a sharp gaussian band at the wavefront plus a
 * trailing hump of pond ripples behind it — and samples the rendered scene at
 * the displaced UV (the refraction). A faint cool highlight rides the leading
 * edge. WebGL1-safe (constant loop bound + break).
 */
function registerShader(): void {
  if (shaderRegistered) return;
  shaderRegistered = true;
  Effect.ShadersStore[`${SHADER_NAME}FragmentShader`] = `
#ifdef GL_ES
precision highp float;
#endif
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform float aspect;
uniform float frequency;
uniform float trailLength;
uniform float highlight;
uniform int rippleCount;
uniform vec2 centers[${MAX_RIPPLES}];
uniform vec3 params[${MAX_RIPPLES}];

void main(void) {
  vec2 uv = vUV;
  vec2 disp = vec2(0.0);
  float glow = 0.0;
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    if (i >= rippleCount) { break; }
    float radius = params[i].x;
    float strength = params[i].y;
    float width = params[i].z;
    if (strength <= 0.0) { continue; }
    vec2 d = uv - centers[i];
    d.x *= aspect;                       // aspect-correct so rings stay circular
    float dist = length(d);
    float front = dist - radius;         // <0 behind the front, >0 ahead of it
    float band = exp(-(front * front) / (width * width));   // sharp leading edge
    float behind = clamp((radius - dist) / trailLength, 0.0, 1.0);
    float trail = behind * (1.0 - behind) * 4.0;            // pond ripples behind
    float osc = sin(front * frequency);
    float amount = (band + trail) * osc * strength;
    vec2 dir = dist > 0.0001 ? d / dist : vec2(0.0);
    dir.x /= aspect;                     // back to UV space for sampling
    disp += dir * amount;
    glow += band * strength * highlight;
  }
  vec3 col = texture2D(textureSampler, uv + disp).rgb;
  col += glow * vec3(0.5, 0.7, 1.0) * 40.0;
  gl_FragColor = vec4(col, 1.0);
}
`;
}
