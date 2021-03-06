import * as twgl from "./twgl/twgl-full.js";
import {
  m4,
  BufferInfo,
  FramebufferInfo,
  ProgramInfo,
  VertexArrayInfo,
  v3
} from "./twgl/twgl-full";

import { loadFile } from "./util";
import { Vec3 } from "./twgl/v3.js";
import { Mat4 } from "./twgl/m4.js";
import { V2 } from "./v2.js";

type PassInfo = {
  programs: [string, string];
  programInfo?: ProgramInfo;
  source?: BufferInfo | VertexArrayInfo;
  target?: FramebufferInfo;
  overwrite?: boolean;
  uniforms?: any;
  then?: () => void;
};

const voxResolution = 200;
const noiseResolution = 200;
const toSun = v3.normalize([0, 0, 1]);

export let canvas: HTMLCanvasElement;
let gl: WebGL2RenderingContext;
let noise: WebGLTexture;

const fullScreenQuad = {
  position: [-1, -1, 0, 1, -1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1, 1, 0]
};

const up = [0, 0, 1];

export async function prepareRender(
  crash: () => void,
  collect: (arg0: number) => void,
  collected: Uint8Array,
  superSampling: number
) {
  canvas = document.getElementById("c") as HTMLCanvasElement;
  gl = canvas.getContext("webgl2");

  if (!gl) {
    document.children[0].innerHTML =
      "This browser has no WebGL2 support or it is not turned on.";
    return;
  }

  /*gl.getExtension("EXT_color_buffer_float");
  gl.getExtension("OES_texture_float_linear");
  gl.getExtension("WEBGL_color_buffer_float");*/

  twgl.addExtensionsToContext(gl);

  const shaderSources = [
    "noise-f",
    "simple-geo-v",
    "star-f",
    "raymarch-f",
    "lattice-v",
    "geo-f",
    "quad-v",
    "light-f",
    "screen-f"
  ];

  const shaderFiles = await Promise.all(
    shaderSources.map(f => {
      let inlined = document.getElementById(`${f}.glsl`);
      if (inlined) return inlined.innerHTML;
      return (
        document.getElementById(`${f}.glsl`) || loadFile(`./shaders/${f}.glsl`)
      );
    })
  );
  const shaders = shaderFiles.reduce(
    (p, c, i) => ((p[shaderSources[i]] = c), p),
    {}
  );

  const [
    noiseFs,
    simpleGeoVs,
    starFs,
    raymarchFs,
    latticeVs,
    geoFs,
    quadVs,
    lightFs,
    screenFs
  ] = shaderFiles;

  //let va = await loadStage();

  const bufferWH: V2 = [
    canvas.clientWidth * superSampling,
    canvas.clientHeight * superSampling
  ];

  const depthTexture = createTexture(gl, bufferWH, {
    internalFormat: gl.DEPTH24_STENCIL8
  });

  const normalTexture = createTexture(gl, bufferWH, {
    internalFormat: gl.RGB,
    min: gl.NEAREST
  });

  const screenTexture = createTexture(gl, bufferWH, {
    internalFormat: gl.RGBA16F,
    min: superSampling > 1 ? gl.LINEAR : gl.NEAREST
  });

  if (!noise) noise = makeTheNoise([quadVs, noiseFs]);

  const terrainPass: PassInfo = {
    programs: [quadVs, raymarchFs],
    source: twgl.createBufferInfoFromArrays(gl, fullScreenQuad),
    target: twgl.createFramebufferInfo(
      gl,
      [
        { internalFormat: gl.RGBA16F },
        { attachment: normalTexture },
        { format: gl.DEPTH_STENCIL, attachment: depthTexture }
      ],
      bufferWH[0],
      bufferWH[1]
    )
  };

  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);

  let polyGeometry = {
    color: { size: 1, data: [...new Array(6)].map((v, i) => 0) },
    position: fullScreenQuad.position.map(n => n * 200 + 200)
  };

  const polyPass: PassInfo = {
    programs: [simpleGeoVs, starFs],
    overwrite: true,
    source: twgl.createBufferInfoFromArrays(gl, polyGeometry),
    target: terrainPass.target
  };

  const lightPass: PassInfo = {
    programs: [quadVs, lightFs],
    uniforms: {
      u_color: terrainPass.target.attachments[0],
      u_normal: terrainPass.target.attachments[1],
      u_depth: terrainPass.target.attachments[2]
    },
    source: twgl.createBufferInfoFromArrays(gl, fullScreenQuad),
    target: twgl.createFramebufferInfo(
      gl,
      [{ attachment: screenTexture }],
      bufferWH[0],
      bufferWH[1]
    )
  };
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

  const viewportPass: PassInfo = {
    programs: [quadVs, screenFs],
    uniforms: {
      u_color: lightPass.target.attachments[0],
      u_bufferSize: bufferWH
    },
    source: twgl.createBufferInfoFromArrays(gl, fullScreenQuad)
  };

  twgl.resizeCanvasToDisplaySize(canvas);
  gl.viewport(0, 0, canvas.clientWidth, canvas.clientHeight);

  //const capturer = new CCapture( { format: 'webm' } );

  let collectedBits = new Int32Array(100);

  let render: (time: number, pos: Vec3, dir: Vec3, musicTime:number) => void;

  render = (time: number, eye: Vec3, direction: Vec3, musicTime:number) => {
    const fov = (40 * Math.PI) / 180;
    const aspect = canvas.clientWidth / canvas.clientHeight;
    const zNear = 0.5;
    const zFar = 800;
    const perspective = m4.perspective(fov, aspect, zNear, zFar);

    const camera = m4.lookAt(eye, v3.add(eye, direction), up);

    const raycastCamera = m4.lookAt([0, 0, 0], direction, up);
    const raycastProjection = m4.inverse(
      m4.multiply(perspective, m4.inverse(raycastCamera))
    );

    const viewTransform = m4.inverse(camera);
    const viewProjectionTransform = m4.multiply(perspective, viewTransform);
    const inverseViewProjectionTransform = m4.inverse(viewProjectionTransform);

    //console.log(v3.subtract(m4.transformPoint(invertViewProjectionTransform, [0,1,0]), eye));

    const world = m4.identity();

    for (let i = 0; i < collectedBits.length; i++) collectedBits[i] = 0;

    for (let i = 0; i < collected.length; i++) {
      let j = Math.floor(i / 16);
      if (collected[i]) collectedBits[j] = collectedBits[j] + (1 << i % 16);
      //console.log(i, j, collectedBits);
    }

    const uniforms = {
      "u_light[0].pos": [1300, 1000, 2000],
      "u_light[0].color": [1, 1, 1, 1],
      u_ambient: [1, 1, 1, 0.3],
      u_specular: [1, 1, 1, 5],
      u_shininess: 50,
      u_time: time,
      u_orbRadius: 1 + Math.sin(time * 3) * 0.2,
      u_eye: eye,
      u_toSun: toSun,
      u_resolution: voxResolution,
      u_scale: 100,
      u_depthRange: [zNear, zFar],
      u_bufferSize: bufferWH,
      u_viewInverse: camera,
      u_near: zNear,
      u_far: zFar,
      u_world: world,
      u_worldInverseTranspose: m4.transpose(m4.inverse(world)),
      u_worldViewProjection: viewProjectionTransform,
      u_inverseWorldViewProjection: inverseViewProjectionTransform,
      u_raycastProjection: raycastProjection,
      u_collected: collectedBits,
      u_noise: noise,
      u_musicTime: Math.sin(0.5 * musicTime / 60 * 102 * Math.PI) * 0.1
    };

    Object.assign(lightPass.uniforms, uniforms);

    polyPass.uniforms = uniforms;
    terrainPass.uniforms = uniforms;

    renderPass(gl, terrainPass);

    gl.flush();
    const data = new Float32Array(4);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, data);
    if (data[0]) crash();
    else if (data[1]) collect(data[1]);

    //renderPass(gl, polyPass);

    renderPass(gl, lightPass);

    renderPass(gl, viewportPass);
  };
  return render;
}

function renderPass(gl: WebGL2RenderingContext, pass: PassInfo) {
  twgl.bindFramebufferInfo(gl, pass.target);
  if (!pass.overwrite) gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  if (!pass.programInfo) {
    pass.programInfo = twgl.createProgramInfo(gl, pass.programs, error =>
      console.log(error)
    );
  }
  const program = pass.programInfo;
  gl.useProgram(program.program);
  twgl.setBuffersAndAttributes(gl, program, pass.source);
  twgl.setUniforms(program, pass.uniforms);
  twgl.drawBufferInfo(gl, pass.source);
  if (pass.then) {
    pass.then();
  }
}

function logBuffer(
  gl: WebGL2RenderingContext,
  attachment = gl.COLOR_ATTACHMENT0
) {
  gl.flush();
  const data = new Float32Array(100 * 100 * 1);
  gl.readBuffer(attachment);
  gl.readPixels(0, 0, 100, 100, gl.RED, gl.FLOAT, data);
}

function createTexture(gl: WebGL2RenderingContext, size: V2, other: Object) {
  return twgl.createTexture(
    gl,
    Object.assign(
      {
        width: size[0],
        height: size[1]
      },
      other
    )
  );
}

function makeTheNoise(programs: [string, string]) {
  let numPixels = noiseResolution * noiseResolution * noiseResolution;
  let noise2DSide = Math.ceil(Math.sqrt(numPixels));

  const noisePass: PassInfo = {
    programs,
    source: twgl.createBufferInfoFromArrays(gl, fullScreenQuad),
    uniforms: { u_resolution: noiseResolution, u_side: noise2DSide },
    target: twgl.createFramebufferInfo(
      gl,
      [{ internalFormat: gl.R32F }],
      noise2DSide,
      noise2DSide
    )
  };

  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

  renderPass(gl, noisePass);

  //gl.flush();
  const data = new Float32Array(noise2DSide * noise2DSide);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  gl.readPixels(0, 0, noise2DSide, noise2DSide, gl.RED, gl.FLOAT, data);

  const noise3DTexture = twgl.createTexture(gl, {
    target: gl.TEXTURE_3D,
    width: noiseResolution,
    height: noiseResolution,
    depth: noiseResolution,
    wrap: gl.MIRRORED_REPEAT,
    minMag: gl.LINEAR,
    internalFormat: gl.R16F,
    src: data.slice(0, numPixels)
  });

  return noise3DTexture;
}
