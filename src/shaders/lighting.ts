/**
 * Deferred 2D lighting.
 *
 * This pass is where the game earns its look. It reads the G-buffer and
 * accumulates every light into an HDR target, with:
 *
 * - **Normal-mapped diffuse**, so surface detail catches light and moves as the
 *   light moves, rather than being a flat painted texture.
 * - **A hemispheric ambient term**, tinted separately for sky and bounce light.
 *   Flat ambient is the single biggest giveaway of a cheap 2D renderer; giving
 *   up-facing and down-facing surfaces different ambient colours immediately
 *   reads as a real environment.
 * - **Raymarched soft shadows** against the occluder mask, with a penumbra that
 *   widens with distance, matching how real shadows soften.
 * - **A rim term**, which separates characters from the background and is a
 *   large part of the sense of "presence" the art direction is chasing.
 * - **Translucency**, for the Prismatic Hollow's membranes and crystal, where
 *   light bleeds *through* a surface rather than bouncing off it.
 *
 * Shadow steps and light counts are compile-time `#define`s so the quality
 * tiers produce genuinely different shaders instead of branching at runtime.
 */

export const LIGHTING_FS = `#version 300 es
precision highp float;

#ifndef MAX_LIGHTS
#define MAX_LIGHTS 24
#endif

#ifndef SHADOW_STEPS
#define SHADOW_STEPS 16
#endif

in vec2 vUV;

uniform sampler2D uAlbedo;
uniform sampler2D uNormal;
uniform sampler2D uMaterial;
uniform sampler2D uDepth;
uniform sampler2D uOccluder;
uniform sampler2D uBlueNoise;
/** Single-channel contact occlusion: soft pools where objects meet surfaces. */
uniform sampler2D uContactAO;

/** Packed light data. xy = screen position (0..1), z = radius (screen units), w = intensity. */
uniform vec4 uLightPosition[MAX_LIGHTS];
/** rgb = colour, a = light type (0 point, 1 directional, 2 cone). */
uniform vec4 uLightColor[MAX_LIGHTS];
/** x = cone direction angle, y = cone half-width, z = shadow strength, w = falloff exponent. */
uniform vec4 uLightParams[MAX_LIGHTS];
uniform int uLightCount;

/** rgb = colour from above, a = intensity. */
uniform vec4 uAmbientSky;
/** rgb = bounce colour from below, a = intensity. */
uniform vec4 uAmbientGround;
/** rgb = rim colour, a = strength. */
uniform vec4 uRim;

uniform vec2 uResolution;
uniform float uTime;
/** Aspect correction so screen-space radii stay circular. */
uniform vec2 uAspect;
/**
 * Multiplier on the emissive channel.
 *
 * Kept at 1.0 so that a fully-emissive surface renders at exactly its authored
 * albedo — "unlit passthrough" rather than "glowing". Anything that should
 * actually bloom is authored bright enough to cross the bloom threshold on its
 * own. An earlier hardcoded 3.0 here drove the sky far past white and destroyed
 * the frame's entire dynamic range.
 */
uniform float uEmissiveScale;

out vec4 oLight;

/**
 * Marches from the fragment toward a light, accumulating occlusion.
 *
 * The penumbra widens with distance from the receiver, which is what makes
 * contact shadows crisp and distant shadows soft. Sampling is jittered per
 * pixel so the low step count reads as soft noise rather than as visible bands.
 */
float traceShadow(vec2 origin, vec2 lightPos, float jitter, float strength) {
#if SHADOW_STEPS == 0
  return 1.0;
#else
  if (strength <= 0.001) return 1.0;

  vec2 delta = lightPos - origin;
  float rayLength = length(delta * uAspect);
  if (rayLength < 0.0005) return 1.0;

  // Start the march a little away from the receiving surface. Without this
  // bias a fragment that is itself in the occluder mask immediately samples
  // its own coverage and shadows itself, which turns every lit surface a
  // uniform grey instead of producing actual cast shadows.
  const float START_BIAS = 0.03;

  // Occlusion is accumulated as a soft maximum rather than a mean.
  //
  // Averaging along the ray was the original approach and produced no visible
  // shadow at all: a character is roughly 0.03 of the screen wide while the
  // ray spans 0.5, so at most one sample in sixteen can land on it, and
  // dividing that single hit by the sample count left about four percent of
  // darkening. An occluder either blocks the light or it does not, so the
  // strongest hit along the ray is the physically meaningful quantity; the
  // per-pixel jitter and the filtered half-resolution mask supply the penumbra.
  float occlusion = 0.0;

  for (int i = 1; i <= SHADOW_STEPS; i++) {
    float t = mix(START_BIAS, 1.0, (float(i) - jitter) / float(SHADOW_STEPS));
    vec2 samplePos = origin + delta * t;

    // Samples that leave the screen cannot be evaluated; treating them as lit
    // avoids a dark border creeping in from off-screen geometry.
    if (samplePos.x < 0.0 || samplePos.x > 1.0 || samplePos.y < 0.0 || samplePos.y > 1.0) {
      continue;
    }

    float occluder = texture(uOccluder, samplePos).r;

    // Contact shadows are tight and dark; the further along the ray an
    // occluder sits, the softer and weaker its shadow, matching how a real
    // penumbra widens with distance.
    float proximity = 1.0 - t * 0.55;
    occlusion = max(occlusion, occluder * proximity);
  }

  return clamp(1.0 - occlusion * strength, 0.0, 1.0);
#endif
}

/**
 * Smooth radial falloff.
 *
 * The squared-then-smoothed form reaches exactly zero at the light's radius,
 * unlike true inverse-square which never does. A light that never quite ends
 * forces either a hard cutoff ring or an unbounded loop over every light in the
 * level, and both are worse than a slight physical inaccuracy.
 */
float falloff(float dist, float radius, float exponent) {
  float normalized = clamp(dist / max(radius, 0.0001), 0.0, 1.0);
  float inverse = 1.0 - normalized * normalized;
  return pow(max(inverse, 0.0), exponent);
}

void main() {
  vec4 albedo = texture(uAlbedo, vUV);
  vec4 normalSample = texture(uNormal, vUV);
  vec4 material = texture(uMaterial, vUV);
  vec4 depthSample = texture(uDepth, vUV);

  // Rebuild the unit normal from its packed xy.
  vec2 normalXY = normalSample.rg * 2.0 - 1.0;
  float normalZ = sqrt(max(1.0 - dot(normalXY, normalXY), 0.0));
  vec3 normal = normalize(vec3(normalXY, max(normalZ, 0.05)));

  // Baked relief occlusion, combined with the dynamic contact pools.
  //
  // In a side-scrolling view the ground is seen edge-on, so a directional
  // shadow lands on whatever is behind the character rather than on the surface
  // they stand on. Contact occlusion is what actually connects them to it; the
  // eye reads a character with no darkening beneath as floating, however
  // precisely their feet are aligned.
  float contactAO = clamp(texture(uContactAO, vUV).r, 0.0, 1.0);
  float ambientOcclusion = normalSample.a * (1.0 - contactAO * 0.95);
  float roughness = clamp(material.r, 0.04, 1.0);
  float metallic = material.g;
  float emissive = material.b;
  float translucency = material.a;
  float parallaxDepth = depthSample.r;

  // Distant layers receive flatter, dimmer light. Without this, a mountain ten
  // layers back is lit as crisply as the character, and all sense of depth
  // collapses.
  float depthAttenuation = 1.0 / (1.0 + parallaxDepth * 0.35);
  float depthFlatten = clamp(parallaxDepth * 0.16, 0.0, 0.75);

  // Shadow *reception* also falls off with depth. Every occluder lives in the
  // playfield plane, so without this a crate standing on the ground casts a
  // long dark band across a mesa fifty metres behind it.
  float shadowReceive = clamp(1.0 - parallaxDepth * 0.30, 0.0, 1.0);

  // Hemispheric ambient: sky from above, bounce from below.
  float upFacing = normal.y * -0.5 + 0.5;
  vec3 ambient =
    mix(uAmbientGround.rgb * uAmbientGround.a, uAmbientSky.rgb * uAmbientSky.a, upFacing);
  ambient *= ambientOcclusion;

  vec3 accumulated = ambient;

  // Per-pixel jitter for shadow sampling, animated so any residual banding
  // averages out across frames rather than sitting still and being noticed.
  float jitter = texture(uBlueNoise, vUV * uResolution / 64.0 + uTime * 0.017).r;

  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uLightCount) break;

    vec4 lightPos = uLightPosition[i];
    vec4 lightColor = uLightColor[i];
    vec4 lightParams = uLightParams[i];

    float lightType = lightColor.a;
    vec3 contribution = vec3(0.0);

    if (lightType < 0.5) {
      // ---- Point light ----
      vec2 toLight = lightPos.xy - vUV;
      float lightDistance = length(toLight * uAspect);
      float attenuation = falloff(lightDistance, lightPos.z, lightParams.w);
      if (attenuation <= 0.0) continue;

      vec3 lightDir = normalize(vec3(normalize(toLight * uAspect), 0.65));
      float lambert = max(dot(normal, lightDir), 0.0);
      lambert = mix(lambert, 1.0, depthFlatten);

      float shadow = mix(1.0, traceShadow(vUV, lightPos.xy, jitter, lightParams.z), shadowReceive);

      // Light passing through a thin surface, lit from behind.
      float backLight = max(-dot(normal, lightDir), 0.0) * translucency;

      contribution = lightColor.rgb * lightPos.w * attenuation * (lambert + backLight) * shadow;
    } else if (lightType < 1.5) {
      // ---- Directional light (the sun) ----
      float angle = lightParams.x;
      vec3 lightDir = normalize(vec3(cos(angle), sin(angle), 0.55));
      float lambert = max(dot(normal, lightDir), 0.0);
      lambert = mix(lambert, 1.0, depthFlatten);

      // March toward a virtual light position far along the sun direction.
      vec2 virtualLight = vUV + vec2(cos(angle), sin(angle)) * 0.30;
      float shadow = mix(1.0, traceShadow(vUV, virtualLight, jitter, lightParams.z), shadowReceive);

      float backLight = max(-dot(normal, lightDir), 0.0) * translucency;

      contribution = lightColor.rgb * lightPos.w * (lambert + backLight) * shadow;
    } else {
      // ---- Cone light ----
      vec2 toLight = lightPos.xy - vUV;
      float lightDistance = length(toLight * uAspect);
      float attenuation = falloff(lightDistance, lightPos.z, lightParams.w);
      if (attenuation <= 0.0) continue;

      vec2 lightForward = vec2(cos(lightParams.x), sin(lightParams.x));
      vec2 fragmentDir = normalize(-toLight * uAspect);
      float cosAngle = dot(fragmentDir, lightForward);
      float coneEdge = cos(lightParams.y);
      // Soften the cone edge over a fixed angular width.
      float cone = smoothstep(coneEdge, coneEdge + 0.12, cosAngle);
      if (cone <= 0.0) continue;

      vec3 lightDir = normalize(vec3(normalize(toLight * uAspect), 0.65));
      float lambert = max(dot(normal, lightDir), 0.0);
      lambert = mix(lambert, 1.0, depthFlatten);

      float shadow = mix(1.0, traceShadow(vUV, lightPos.xy, jitter, lightParams.z), shadowReceive);

      contribution = lightColor.rgb * lightPos.w * attenuation * cone * lambert * shadow;
    }

    // Metal reflects its own albedo; dielectrics scatter white light. A cheap
    // stand-in for a full BRDF that still keeps painted metal reading as metal.
    vec3 tinted = mix(contribution, contribution * albedo.rgb, metallic * 0.75);

    // Rough surfaces spread light more evenly; smooth ones concentrate it.
    float gloss = 1.0 - roughness;
    tinted *= 1.0 + gloss * 0.35;

    accumulated += tinted * depthAttenuation;
  }

  // Rim lighting from the screen-space normal. Edges facing away from the
  // viewer catch a cool highlight, which is what lifts a character off its
  // background without resorting to an outline.
  float rimFactor = pow(1.0 - clamp(normal.z, 0.0, 1.0), 2.5);
  vec3 rim = uRim.rgb * uRim.a * rimFactor * (1.0 - depthFlatten);

  // Emissive surfaces bypass lighting rather than adding on top of it.
  // Blending toward the raw albedo keeps a fully-emissive surface at exactly
  // its authored value, instead of stacking ambient light on top and pushing
  // it past white.
  // Direct light is occluded as well as ambient. Without this the pool
  // disappears entirely wherever the key light is strong, which is exactly
  // where contact most needs to read.
  accumulated *= 1.0 - contactAO * 0.72 * (1.0 - emissive);

  // Rim is *reflected* light, so it has to be modulated by the surface it is
  // reflecting off. Adding it independently of albedo lifted every dark surface
  // by the full rim colour, which in an interior biome turned near-black
  // structure into a flat pink-grey wash — the albedo was measured at 0.05-0.15
  // while the composited frame read around 0.6.
  //
  // A little is kept unmodulated so pure-black silhouettes still catch an edge,
  // which is what separates a character from the background.
  vec3 rimTint = mix(albedo.rgb, vec3(1.0), 0.25);
  vec3 lit = albedo.rgb * accumulated + rim * rimTint * albedo.a * (1.0 - emissive);
  lit = mix(lit, albedo.rgb * uEmissiveScale, emissive);

  oLight = vec4(lit, albedo.a);
}
`;
