/**
 * Particle shaders.
 *
 * Particles expand from a static unit quad in the vertex shader using
 * per-instance position, size, rotation, and colour. They write the same four
 * G-buffer attachments as everything else, so they sit correctly inside the
 * deferred pipeline: they are fogged by depth, they contribute to bloom through
 * the emissive channel, and they are not simply pasted over the composited
 * image the way a separate forward pass would be.
 *
 * They are marked fully emissive because airborne particulate is *scattering*
 * light rather than reflecting it. Running motes through the normal-mapped
 * diffuse path would darken them into invisibility against a bright sky.
 */

export const PARTICLE_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;     // static unit quad, -1..1
layout(location = 1) in vec3 iPosition;   // x, y in metres; z = parallax depth
layout(location = 2) in float iSize;      // half-extent in metres
layout(location = 3) in float iRotation;
layout(location = 4) in vec4 iColor;      // premultiplied

uniform mat3 uViewProjection;
uniform vec4 uUVRect;   // u0, v0, u1, v1
/**
 * Extra length along the particle's own X axis.
 *
 * Sparks orient themselves along their velocity, so stretching them turns a
 * dot into a streak and reads as speed.
 */
uniform float uStretch;
/**
 * Parallax scroll compensation.
 *
 * Particles at depth must scroll more slowly than the playfield. The offset is
 * applied here rather than on the CPU so the simulation can keep working in
 * plain world space.
 */
uniform vec2 uCameraPosition;

out vec2 vUV;
out vec4 vColor;
out float vDepth;

void main() {
  vec2 local = aCorner * iSize;
  local.x *= 1.0 + uStretch;

  float c = cos(iRotation);
  float s = sin(iRotation);
  vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);

  // Reciprocal depth falloff, matching the parallax layers exactly so a mote
  // at a layer's depth tracks that layer.
  float parallax = 1.0 / (1.0 + max(iPosition.z, 0.0) * 0.55);
  vec2 offset = uCameraPosition * (1.0 - parallax);

  vec3 clip = uViewProjection * vec3(iPosition.xy + offset + rotated, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);

  vUV = mix(uUVRect.xy, uUVRect.zw, aCorner * 0.5 + 0.5);
  vColor = iColor;
  vDepth = iPosition.z;
}
`;

export const PARTICLE_FS = `#version 300 es
precision highp float;

in vec2 vUV;
in vec4 vColor;
in float vDepth;

uniform sampler2D uAlbedo;

layout(location = 0) out vec4 oAlbedo;
layout(location = 1) out vec4 oNormal;
layout(location = 2) out vec4 oMaterial;
layout(location = 3) out vec4 oDepth;

void main() {
  vec4 texel = texture(uAlbedo, vUV);
  float coverage = texel.a * vColor.a;
  if (coverage < 0.004) discard;

  // The atlas is premultiplied and the vertex colour is too, so the product is
  // already in the additive form the blend mode expects.
  oAlbedo = vec4(texel.rgb * vColor.rgb, coverage);

  // Flat, camera-facing normal. Particles have no meaningful surface, and
  // giving them one produces distracting lighting pops as they rotate.
  oNormal = vec4(0.5, 0.5, 0.0, 1.0);

  // Fully emissive: particulate scatters light rather than reflecting it, so it
  // must bypass the diffuse path or it goes black against a bright sky.
  oMaterial = vec4(1.0, 0.0, 1.0, 0.0);

  oDepth = vec4(vDepth, 0.0, 0.0, coverage);
}
`;
