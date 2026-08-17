/**
 * Fullscreen deferred lighting pass.
 *
 * Reads the G-buffer (albedo, normal, material, emissive), an occluder mask, and the unlit
 * background, and writes one fully-opaque, already-composited colour: `mix(background, lit,
 * coverage)`. Doing the background composite here — instead of relying on GL alpha blending —
 * means this pass works identically whether the accumulation target is `RGBA8` or `RGBA16F`
 * (blending support for floating-point targets is not guaranteed everywhere `EXT_color_buffer_float`
 * is), and it keeps `GlWorldRenderer` from needing a separate blend step.
 *
 * Lighting model: ambient hemisphere tint from `normal.y` (sky above, ground below), plus up to
 * {@link MAX_LIGHTS} half-Lambert point lights with quadratic falloff to their radius. Each light
 * assumes a fixed height above the 2D plane (see {@link LightList.add}) so the dot product with a
 * flat-ish "pillow" normal is never degenerate. Shadows are a coarse ray-march against a low-detail
 * occluder mask — a handful of fixed steps from the fragment toward the light, sampling a binary
 * "is there solid geometry here" texture — which reads as soft-edged rather than a hard silhouette
 * because so few steps are taken.
 */

import { Program } from './program';
import type { CameraOffset, ViewSize } from './solidBatch';
import type { Texture } from './texture';
import { MAX_LIGHTS } from './lights';
import type { LightList } from './lights';

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

#define MAX_LIGHTS ${MAX_LIGHTS}
#define SHADOW_STEPS 8

// Fixed "sun"/key light: gives every surface (not just ones near a dynamic point light) a
// consistent direction to shade its normal map against, so rivets/bevels read as lit relief
// instead of only the ambient hemisphere's vertical term. World Y is down, so "up and toward the
// camera" (the conventional key light placement) is (+x-ish, -y, +z).
const vec3 KEY_LIGHT_DIR = vec3(0.350219, -0.525328, 0.775485); // normalize(vec3(0.35, -0.525, 0.775))
const vec3 KEY_LIGHT_COLOR = vec3(1.0, 0.98, 0.94);
const float KEY_LIGHT_INTENSITY = 0.85;

in vec2 v_uv;

uniform sampler2D u_albedo;
uniform sampler2D u_normal;
uniform sampler2D u_material;
uniform sampler2D u_emissive;
uniform sampler2D u_occluder;
uniform sampler2D u_background;

uniform vec2 u_view;
uniform vec3 u_ambientGround;
uniform vec3 u_ambientSky;
uniform float u_ambientIntensity;
uniform int u_lightCount;
uniform vec4 u_lightPosRadius[MAX_LIGHTS];
uniform vec4 u_lightColor[MAX_LIGHTS];
uniform int u_shadowsEnabled;

out vec4 outColor;

/** World/screen-space (y-down, pixels) position of the current fragment — see the module doc. */
vec2 fragScreenPos() {
  return vec2(v_uv.x * u_view.x, (1.0 - v_uv.y) * u_view.y);
}

vec2 screenToUv(vec2 p) {
  return vec2(p.x / u_view.x, 1.0 - p.y / u_view.y);
}

float shadowFactor(vec2 fragScreen, vec2 toLight) {
  float blocked = 0.0;
  for (int s = 1; s <= SHADOW_STEPS; s += 1) {
    float t = float(s) / float(SHADOW_STEPS + 1);
    vec2 sampleUv = screenToUv(fragScreen + toLight * t);
    blocked += texture(u_occluder, sampleUv).r;
  }
  return 1.0 - clamp((blocked / float(SHADOW_STEPS)) * 1.7, 0.0, 1.0);
}

void main() {
  vec4 albedoSample = texture(u_albedo, v_uv);
  vec3 normal = normalize(texture(u_normal, v_uv).rgb * 2.0 - 1.0);
  vec4 material = texture(u_material, v_uv);
  vec3 emissive = texture(u_emissive, v_uv).rgb;
  vec3 background = texture(u_background, v_uv).rgb;

  vec3 albedo = albedoSample.rgb;
  float coverage = albedoSample.a;
  float ao = material.g;

  // World Y is down, so a normal pointing up (toward the sky, negative Y) should sample the sky
  // tint, and one pointing down (toward the ground/floor bounce) should sample the ground tint —
  // i.e. the mix factor is how "down-facing" the normal is, not the raw normal.y sign.
  float downFacing = normal.y * 0.5 + 0.5;
  vec3 ambient = mix(u_ambientSky, u_ambientGround, downFacing) * u_ambientIntensity * ao;
  float keyLambert = max(dot(normal, KEY_LIGHT_DIR), 0.0);
  vec3 key = KEY_LIGHT_COLOR * KEY_LIGHT_INTENSITY * keyLambert * ao;
  vec3 lit = (ambient + key) * albedo;

  vec2 fragScreen = fragScreenPos();
  for (int i = 0; i < MAX_LIGHTS; i += 1) {
    if (i >= u_lightCount) break;
    vec4 posRadius = u_lightPosRadius[i];
    vec2 toLight = posRadius.xy - fragScreen;
    float dist = length(toLight);
    float radius = posRadius.z;
    if (dist > radius) continue;

    vec3 lightDir = normalize(vec3(toLight, posRadius.w));
    float halfLambert = dot(normal, lightDir) * 0.5 + 0.5;
    float atten = clamp(1.0 - dist / radius, 0.0, 1.0);
    atten *= atten;

    float shadow = 1.0;
    if (u_shadowsEnabled == 1 && dist > 3.0) {
      shadow = shadowFactor(fragScreen, toLight);
    }

    vec4 lightColor = u_lightColor[i];
    lit += albedo * lightColor.rgb * lightColor.a * halfLambert * atten * shadow;
  }

  vec3 finalColor = lit + emissive;
  outColor = vec4(mix(background, finalColor, coverage), 1.0);
}
`;

const FULLSCREEN_POS = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

export interface LightingPassInputs {
  readonly albedo: Texture;
  readonly normal: Texture;
  readonly material: Texture;
  readonly emissive: Texture;
  readonly occluder: Texture;
  readonly background: Texture;
  readonly view: ViewSize;
  readonly camera: CameraOffset;
  readonly lights: LightList;
  readonly shadowsEnabled: boolean;
}

export class LightingPass {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: Program;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly scratchPosRadius = new Float32Array(MAX_LIGHTS * 4);
  private readonly scratchColorIntensity = new Float32Array(MAX_LIGHTS * 4);

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = new Program(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_POS, gl.STATIC_DRAW);
    const location = this.program.attribLocation('a_pos');
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /** Draw the composited, lit scene into whichever framebuffer is currently bound. */
  draw(inputs: LightingPassInputs): void {
    const { gl } = this;
    const { lights, camera } = inputs;

    const count = Math.min(lights.count, MAX_LIGHTS);
    for (let i = 0; i < count; i += 1) {
      const base = i * 4;
      this.scratchPosRadius[base] = (lights.posRadiusHeight[base] ?? 0) - camera.x;
      this.scratchPosRadius[base + 1] = (lights.posRadiusHeight[base + 1] ?? 0) - camera.y;
      this.scratchPosRadius[base + 2] = lights.posRadiusHeight[base + 2] ?? 0;
      this.scratchPosRadius[base + 3] = lights.posRadiusHeight[base + 3] ?? 0;
      this.scratchColorIntensity[base] = lights.colorIntensity[base] ?? 0;
      this.scratchColorIntensity[base + 1] = lights.colorIntensity[base + 1] ?? 0;
      this.scratchColorIntensity[base + 2] = lights.colorIntensity[base + 2] ?? 0;
      this.scratchColorIntensity[base + 3] = lights.colorIntensity[base + 3] ?? 0;
    }
    for (let i = count * 4; i < MAX_LIGHTS * 4; i += 1) {
      this.scratchPosRadius[i] = 0;
      this.scratchColorIntensity[i] = 0;
    }

    this.program.use();
    this.program.setUniform1i('u_albedo', 0);
    this.program.setUniform1i('u_normal', 1);
    this.program.setUniform1i('u_material', 2);
    this.program.setUniform1i('u_emissive', 3);
    this.program.setUniform1i('u_occluder', 4);
    this.program.setUniform1i('u_background', 5);
    inputs.albedo.bind(0);
    inputs.normal.bind(1);
    inputs.material.bind(2);
    inputs.emissive.bind(3);
    inputs.occluder.bind(4);
    inputs.background.bind(5);

    this.program.setUniform2f('u_view', inputs.view.width, inputs.view.height);
    this.program.setUniform3f('u_ambientGround', lights.ambientGround[0], lights.ambientGround[1], lights.ambientGround[2]);
    this.program.setUniform3f('u_ambientSky', lights.ambientSky[0], lights.ambientSky[1], lights.ambientSky[2]);
    this.program.setUniform1f('u_ambientIntensity', lights.ambientIntensity);
    this.program.setUniform1i('u_lightCount', count);
    this.program.setUniform4fv('u_lightPosRadius', this.scratchPosRadius);
    this.program.setUniform4fv('u_lightColor', this.scratchColorIntensity);
    this.program.setUniform1i('u_shadowsEnabled', inputs.shadowsEnabled ? 1 : 0);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const { gl } = this;
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.vbo);
    this.program.dispose();
  }
}
