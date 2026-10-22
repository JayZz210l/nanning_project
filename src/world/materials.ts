import * as THREE from 'three';

/** Uniforms shared by every custom shader. uNight: 0 = day, 1 = night. */
export const shared = {
  uTime: { value: 0 },
  uNight: { value: 1 },
};

const HASH = /* glsl */ `
float h21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
`;

type Shader = THREE.WebGLProgramParametersWithUniforms;

/** Patches a Lambert material with extra varyings and fragment code that runs before lighting. */
function patchLambert(
  mat: THREE.MeshLambertMaterial,
  key: string,
  opts: { vertexDecl: string; vertexMain: string; fragDecl: string; fragMain: string },
): THREE.MeshLambertMaterial {
  mat.onBeforeCompile = (shader: Shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uNight = shared.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `${opts.vertexDecl}\nvoid main() {`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${opts.vertexMain}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `uniform float uTime;\nuniform float uNight;\n${HASH}\n${opts.fragDecl}\nvoid main() {`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${opts.fragMain}`);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

/**
 * Buildings: procedural window grid from per-vertex meters (perimeter distance, height),
 * lit windows, neon roof outlines and LED facade sweeps at night.
 * Attributes: aMeters (vec2), aInfo (seed, height, kind).
 */
export function createBuildingMaterial(): THREE.MeshLambertMaterial {
  return patchLambert(new THREE.MeshLambertMaterial({ color: 0xffffff }), 'building', {
    vertexDecl: `attribute vec2 aMeters; attribute vec3 aInfo;
      varying vec2 vMeters; varying vec3 vInfo; varying vec3 vObjNormal;`,
    vertexMain: `vMeters = aMeters; vInfo = aInfo; vObjNormal = normal;`,
    fragDecl: `varying vec2 vMeters; varying vec3 vInfo; varying vec3 vObjNormal;`,
    fragMain: /* glsl */ `
      float kind = vInfo.z;
      float seed = vInfo.x;
      float roof = step(0.5, vObjNormal.y);
      float isRes = step(0.5, kind) * step(kind, 1.5);
      float isCiv = step(1.5, kind) * step(kind, 2.5);
      float isLand = step(2.5, kind);
      float isOffice = 1.0 - isRes - isCiv;

      vec3 office = mix(vec3(0.17, 0.22, 0.30), vec3(0.24, 0.30, 0.36), fract(seed * 3.1));
      vec3 res = mix(vec3(0.66, 0.62, 0.56), vec3(0.78, 0.76, 0.72), fract(seed * 5.7));
      vec3 civ = mix(vec3(0.70, 0.68, 0.62), vec3(0.58, 0.60, 0.62), fract(seed * 2.3));
      vec3 base = office * isOffice + res * isRes + civ * isCiv;
      base = mix(base, vec3(0.14, 0.17, 0.22), isLand);

      vec2 cellSize = mix(vec2(2.3, 3.8), vec2(3.3, 3.0), isRes);
      vec2 g = vMeters / cellSize;
      vec2 cell = floor(g);
      vec2 f = fract(g);
      vec2 fw = max(fwidth(g), vec2(1e-4));
      float aa = clamp(max(fw.x, fw.y) * 1.2 - 0.15, 0.0, 1.0);
      vec2 lo = mix(vec2(0.08, 0.16), vec2(0.22, 0.24), isRes + isCiv);
      vec2 m2 = smoothstep(lo - fw, lo + fw, f) * (1.0 - smoothstep(1.0 - lo - fw, 1.0 - lo + fw, f));
      float avgWin = (1.0 - 2.0 * lo.x) * (1.0 - 2.0 * lo.y);
      float inBand = step(4.0, vMeters.y) * step(vMeters.y, vInfo.y - 1.5) * (1.0 - roof);
      float win = mix(m2.x * m2.y, avgWin, aa) * inBand;

      float r = h21(cell + seed * 91.7);
      float litRatio = 0.36 - isRes * 0.04 - isCiv * 0.16;
      float lit = mix(step(1.0 - litRatio, r), litRatio, aa);

      // daytime: glass reflects the sky, concrete gets darker window holes
      vec3 glass = mix(vec3(0.12, 0.16, 0.22), vec3(0.45, 0.6, 0.75), isOffice * (0.5 + 0.5 * vMeters.y / max(vInfo.y, 1.0)));
      diffuseColor.rgb = mix(base, glass, win * 0.85);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.21, 0.24) + 0.08 * fract(seed * 13.0), roof);

      float warmPick = mix(step(0.75, fract(r * 7.13)), step(0.15, fract(r * 7.13)), isRes + isCiv);
      vec3 winCol = mix(vec3(0.45, 0.85, 1.0), vec3(1.0, 0.72, 0.4), warmPick);
      float night = uNight;
      totalEmissiveRadiance += win * lit * winCol * night * (0.75 + isOffice * 0.25);

      // neon palette per building
      float pk = fract(seed * 17.3);
      vec3 neon = pk < 0.4 ? vec3(0.1, 0.9, 1.0) : pk < 0.7 ? vec3(1.0, 0.18, 0.75) : pk < 0.85 ? vec3(0.6, 0.3, 1.0) : vec3(1.0, 0.6, 0.15);
      float neonOn = clamp(isOffice + isLand + step(0.82, fract(seed * 29.0)), 0.0, 1.0) * step(35.0, vInfo.y);
      float topBand = smoothstep(vInfo.y - 1.4, vInfo.y - 0.9, vMeters.y) * (1.0 - roof);
      totalEmissiveRadiance += topBand * neon * neonOn * night * 2.2;

      // vertical light strips on landmarks and some towers
      float stripOn = clamp(isLand + step(0.9, fract(seed * 41.0)) * isOffice, 0.0, 1.0);
      float sx = fract(vMeters.x / 7.0);
      float strip = smoothstep(0.0, 0.02, sx) * (1.0 - smoothstep(0.04, 0.06, sx));
      totalEmissiveRadiance += strip * stripOn * neon * night * 2.2 * (1.0 - roof) * step(vMeters.y, vInfo.y);

      // LED sweep running up some office towers
      float sweepOn = step(0.8, fract(seed * 7.77)) * isOffice;
      float sw = fract(vMeters.y / 45.0 - uTime * 0.12 - seed);
      totalEmissiveRadiance += smoothstep(0.0, 0.03, sw) * (1.0 - smoothstep(0.03, 0.08, sw)) * sweepOn * neon * night * 1.8 * (1.0 - roof);

      // shopfront glow at street level
      float shop = (1.0 - step(4.5, vMeters.y)) * step(0.6, vMeters.y) * (1.0 - roof) * (isOffice + isCiv * 0.4);
      totalEmissiveRadiance += shop * vec3(1.0, 0.75, 0.5) * night * 0.3;

      // roof beacons
      totalEmissiveRadiance += roof * isLand * vec3(1.0, 0.1, 0.1) * night * (0.4 + 0.4 * step(0.5, fract(uTime * 0.7)));
    `,
  });
}

/**
 * Roads: asphalt with lane markings drawn procedurally.
 * Attributes: aUv (along meters, across -1..1), aRoad (class, half width, flags: 1 oneway, 2 plain).
 */
export function createRoadMaterial(): THREE.MeshLambertMaterial {
  const mat = patchLambert(new THREE.MeshLambertMaterial({ color: 0xffffff }), 'road', {
    vertexDecl: `attribute vec2 aUv; attribute vec3 aRoad; varying vec2 vRUv; varying vec3 vRoad; varying vec2 vWorld;`,
    vertexMain: `vRUv = aUv; vRoad = aRoad; vWorld = position.xz;`,
    fragDecl: `varying vec2 vRUv; varying vec3 vRoad; varying vec2 vWorld;`,
    fragMain: /* glsl */ `
      float cls = vRoad.x;
      float hw = vRoad.y;
      float plain = step(1.5, vRoad.z);
      float oneway = step(0.5, vRoad.z) * (1.0 - plain);
      float across = vRUv.y * hw;
      float aAcross = abs(across);
      float edge = hw - aAcross;
      float foot = step(3.5, cls);
      float n = vnoise(vWorld * 0.7) * 0.5 + vnoise(vWorld * 3.1) * 0.5;

      vec3 asphalt = mix(vec3(0.13, 0.135, 0.15), vec3(0.17, 0.17, 0.19), n);
      vec3 paver = mix(vec3(0.46, 0.42, 0.44), vec3(0.55, 0.5, 0.5), n);
      vec3 col = mix(asphalt, paver, foot);

      float px = max(fwidth(across), 0.01);
      float markOn = (1.0 - plain) * (1.0 - foot) * step(cls, 2.5);
      // edge lines
      float edgeLine = smoothstep(0.25 - px, 0.25, edge) * (1.0 - smoothstep(0.42, 0.42 + px, edge)) * markOn * step(4.0, hw);
      // double yellow center line on two-way major/medium roads
      float centerOn = markOn * (1.0 - oneway) * step(cls, 1.5);
      float cy = (smoothstep(0.08 - px, 0.08, aAcross) * (1.0 - smoothstep(0.2, 0.2 + px, aAcross))) * centerOn;
      // dashed lane dividers on wide roads
      float laneW = 3.5;
      float laneCoord = oneway > 0.5 ? (across + hw) : aAcross;
      float lf = fract(laneCoord / laneW);
      float ld = min(lf, 1.0 - lf) * laneW;
      float dash = step(fract(vRUv.x / 9.0), 0.45);
      float laneLine = (1.0 - smoothstep(0.07, 0.07 + px, ld)) * dash * markOn * step(laneW * 0.7, laneCoord) * step(0.8, edge) * step(cls, 1.5) * step(6.0, hw);
      laneLine *= step(0.4, aAcross);
      float fadeAA = clamp(1.0 - px * 6.0, 0.0, 1.0);

      col = mix(col, vec3(0.85, 0.85, 0.82), (edgeLine + laneLine) * fadeAA);
      col = mix(col, vec3(0.95, 0.75, 0.2), cy * fadeAA);
      diffuseColor.rgb = col;

      float night = uNight;
      totalEmissiveRadiance += col * vec3(0.6, 0.6, 0.9) * 0.18 * night;
      totalEmissiveRadiance += edgeLine * fadeAA * vec3(0.1, 0.75, 1.0) * night * 1.2;
      totalEmissiveRadiance += cy * fadeAA * vec3(1.0, 0.65, 0.1) * night * 0.8;
      totalEmissiveRadiance += laneLine * fadeAA * vec3(0.7, 0.8, 1.0) * night * 0.35;
      // footways: soft magenta glow along the borders
      float fEdge = 1.0 - smoothstep(0.05, 0.25, edge);
      totalEmissiveRadiance += foot * fEdge * vec3(1.0, 0.25, 0.7) * night * 0.6 * (1.0 - plain);
    `,
  });
  mat.depthWrite = false;
  return mat;
}

/** Land use polygons: vertex colors with a world-space noise texture. */
export function createAreaMaterial(): THREE.MeshLambertMaterial {
  const mat = patchLambert(new THREE.MeshLambertMaterial({ vertexColors: true }), 'area', {
    vertexDecl: `varying vec2 vWorld;`,
    vertexMain: `vWorld = position.xz;`,
    fragDecl: `varying vec2 vWorld;`,
    fragMain: /* glsl */ `
      float n = vnoise(vWorld * 0.08) * 0.55 + vnoise(vWorld * 0.6) * 0.3 + vnoise(vWorld * 2.5) * 0.15;
      diffuseColor.rgb *= 0.78 + 0.4 * n;
      totalEmissiveRadiance += diffuseColor.rgb * vec3(0.55, 0.6, 0.9) * 0.22 * uNight;
    `,
  });
  mat.depthWrite = false;
  return mat;
}

/** Lakes: dark water with moving highlights that pick up neon tints at night. */
export function createWaterMaterial(): THREE.MeshLambertMaterial {
  const mat = patchLambert(new THREE.MeshLambertMaterial({ color: 0x1d4a66 }), 'water', {
    vertexDecl: `varying vec2 vWorld;`,
    vertexMain: `vWorld = position.xz;`,
    fragDecl: `varying vec2 vWorld;`,
    fragMain: /* glsl */ `
      vec2 p = vWorld * 0.15;
      float w = vnoise(p + vec2(uTime * 0.15, uTime * 0.07)) + vnoise(p * 2.3 - vec2(uTime * 0.11, -uTime * 0.13));
      float sparkle = smoothstep(1.35, 1.7, w);
      diffuseColor.rgb = mix(vec3(0.12, 0.32, 0.45), vec3(0.3, 0.55, 0.7), w * 0.4);
      vec3 neon = mix(vec3(0.1, 0.8, 1.0), vec3(1.0, 0.2, 0.7), vnoise(vWorld * 0.01 + uTime * 0.02));
      totalEmissiveRadiance += sparkle * mix(vec3(0.4), neon, uNight) * (0.25 + uNight * 0.8);
      totalEmissiveRadiance += vec3(0.02, 0.05, 0.1) * uNight;
    `,
  });
  mat.depthWrite = false;
  return mat;
}

/** Ground plane with a faint cyber grid that fades with distance. */
export function createGroundMaterial(): THREE.MeshLambertMaterial {
  const mat = patchLambert(new THREE.MeshLambertMaterial({ color: 0xffffff }), 'ground', {
    vertexDecl: `varying vec2 vWorld;`,
    vertexMain: `vWorld = position.xz;`,
    fragDecl: `varying vec2 vWorld;`,
    fragMain: /* glsl */ `
      float n = vnoise(vWorld * 0.05) * 0.6 + vnoise(vWorld * 0.4) * 0.4;
      diffuseColor.rgb = mix(vec3(0.30, 0.31, 0.30), vec3(0.38, 0.38, 0.36), n);
      totalEmissiveRadiance += diffuseColor.rgb * vec3(0.5, 0.5, 0.8) * 0.12 * uNight;
      vec2 g = abs(fract(vWorld / 50.0 - 0.5) - 0.5) * 50.0;
      vec2 fw = fwidth(vWorld);
      float line = 1.0 - smoothstep(0.0, max(fw.x, fw.y) * 1.5 + 0.08, min(g.x, g.y));
      float fade = clamp(1.0 - max(fw.x, fw.y) * 0.6, 0.0, 1.0);
      totalEmissiveRadiance += line * fade * vec3(0.15, 0.35, 0.8) * uNight * 0.35;
    `,
  });
  mat.depthWrite = false;
  return mat;
}

/** Trees: plain Lambert with a soft night-time lift so canopies don't read as black holes. */
export function createFoliageMaterial(color: number): THREE.MeshLambertMaterial {
  return patchLambert(new THREE.MeshLambertMaterial({ color }), 'foliage', {
    vertexDecl: '',
    vertexMain: '',
    fragDecl: '',
    fragMain: `totalEmissiveRadiance += diffuseColor.rgb * vec3(0.5, 0.75, 0.9) * 0.35 * uNight;`,
  });
}

/** Gradient sky dome with stars at night and a sun during the day. */
export function createSkyMaterial(sunDir: THREE.Vector3): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uTime: shared.uTime, uNight: shared.uNight, uSun: { value: sunDir } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uNight; uniform vec3 uSun;
      varying vec3 vDir;
      ${HASH}
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y, -0.2, 1.0);
        // night: deep indigo with a magenta city glow on the horizon
        vec3 nZen = vec3(0.01, 0.01, 0.05);
        vec3 nHor = vec3(0.22, 0.05, 0.28);
        vec3 nGlow = vec3(0.85, 0.2, 0.55);
        vec3 night = mix(nHor, nZen, pow(max(h, 0.0), 0.45));
        night += nGlow * pow(1.0 - abs(h), 12.0) * 0.55;
        vec2 sp = d.xz / (d.y + 0.35) * 160.0;
        float star = step(0.9965, h21(floor(sp))) * smoothstep(0.05, 0.4, h);
        star *= 0.6 + 0.4 * sin(uTime * 2.0 + h21(floor(sp) + 3.0) * 30.0);
        night += vec3(star);
        // day: blue sky with a warm horizon and sun
        vec3 day = mix(vec3(0.78, 0.86, 0.92), vec3(0.28, 0.52, 0.85), pow(max(h, 0.0), 0.6));
        float sd = max(dot(d, normalize(uSun)), 0.0);
        day += vec3(1.0, 0.9, 0.7) * (pow(sd, 900.0) * 3.0 + pow(sd, 12.0) * 0.25);
        vec3 col = mix(day, night, uNight);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
