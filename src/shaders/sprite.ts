/**
 * G-buffer sprite shaders.
 *
 * Shaders live in TypeScript template literals rather than `.glsl` files with
 * `?raw` imports. That keeps them available to Node-based tools and unit tests
 * without a bundler in the loop, and guarantees they end up inlined in the
 * single-file build.
 *
 * This pass writes the four deferred attachments in one go:
 *
 *   0. albedo         RGB colour, A coverage
 *   1. normal+height  RG tangent-space normal, B height, A ambient occlusion
 *   2. material       R roughness, G metallic, B emissive, A translucency
 *   3. depth          R parallax depth, G material id
 *
 * Writing all four together is the reason the geometry is only rasterised once,
 * rather than four times as a naive multi-pass approach would require.
 */

export const SPRITE_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;       // x, y in metres; z = parallax depth
layout(location = 1) in vec2 aUV;
layout(location = 2) in vec4 aColor;
layout(location = 3) in vec4 aMaterial;  // emissive, roughness, metallic, translucency
layout(location = 4) in float aRotation;

uniform mat3 uViewProjection;

out vec2 vUV;
out vec4 vColor;
out vec4 vMaterial;
out float vDepth;
out float vRotation;

void main() {
  vUV = aUV;
  vColor = aColor;
  vMaterial = aMaterial;
  vDepth = aPos.z;
  vRotation = aRotation;

  vec3 clip = uViewProjection * vec3(aPos.xy, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}
`;

export const SPRITE_FS = `#version 300 es
precision highp float;

in vec2 vUV;
in vec4 vColor;
in vec4 vMaterial;
in float vDepth;
in float vRotation;

uniform sampler2D uAlbedo;
uniform sampler2D uNormal;
uniform sampler2D uMaterial;

/** Global tint applied to a whole layer, used for atmospheric perspective. */
uniform vec4 uLayerTint;
/** Material id written to the depth attachment, for effect masking. */
uniform float uMaterialId;

layout(location = 0) out vec4 oAlbedo;
layout(location = 1) out vec4 oNormal;
layout(location = 2) out vec4 oMaterial;
layout(location = 3) out vec4 oDepth;

void main() {
  vec4 albedo = texture(uAlbedo, vUV);

  // Discarding fully transparent fragments keeps them out of every subsequent
  // attachment. Without it, a transparent pixel would still write a normal and
  // a depth, punching holes in the lighting behind it.
  if (albedo.a < 0.003) discard;

  vec4 normalSample = texture(uNormal, vUV);
  vec4 materialSample = texture(uMaterial, vUV);

  // Unpack the tangent-space normal from its 0..1 storage range.
  vec2 packedNormal = normalSample.rg * 2.0 - 1.0;

  // Rotate the normal to match the sprite's rotation. Skipping this makes a
  // spinning object look like its lighting is painted on and stationary.
  float c = cos(vRotation);
  float s = sin(vRotation);
  vec2 rotatedNormal = vec2(
    packedNormal.x * c - packedNormal.y * s,
    packedNormal.x * s + packedNormal.y * c
  );

  // Reconstruct z so the normal is unit length; clamped because compression
  // can push the xy magnitude just past 1 and produce a NaN in the sqrt.
  float nz = sqrt(max(1.0 - dot(rotatedNormal, rotatedNormal), 0.0));

  vec3 tint = vColor.rgb * uLayerTint.rgb;
  float coverage = albedo.a * vColor.a * uLayerTint.a;

  oAlbedo = vec4(albedo.rgb * tint, coverage);

  oNormal = vec4(
    rotatedNormal * 0.5 + 0.5,
    normalSample.b,          // height
    normalSample.a           // baked ambient occlusion
  );

  // Per-instance material values scale the atlas's baked channels, so one atlas
  // entry can serve both a dull and a glowing variant of the same part.
  oMaterial = vec4(
    clamp(materialSample.r * (vMaterial.g * 2.0), 0.0, 1.0),   // roughness
    clamp(materialSample.g * (vMaterial.b * 2.0), 0.0, 1.0),   // metallic
    clamp(materialSample.b + vMaterial.r, 0.0, 1.0),           // emissive
    clamp(materialSample.a + vMaterial.a, 0.0, 1.0)            // translucency
  );

  oDepth = vec4(vDepth, uMaterialId, 0.0, coverage);
}
`;

/**
 * Fragment shader for the occluder mask.
 *
 * Renders shadow-casting geometry as pure coverage into a single-channel
 * target. The lighting pass raymarches this mask to work out what is in shadow,
 * and the volumetrics pass reuses it for light shafts. Half resolution is
 * plenty: shadows are soft and light shafts are softer still, so the detail
 * would be thrown away by the blur regardless.
 */
export const OCCLUDER_FS = `#version 300 es
precision highp float;

in vec2 vUV;
in vec4 vColor;

uniform sampler2D uAlbedo;

out vec4 oOccluder;

void main() {
  float coverage = texture(uAlbedo, vUV).a * vColor.a;
  if (coverage < 0.35) discard;
  oOccluder = vec4(coverage, 0.0, 0.0, 1.0);
}
`;
