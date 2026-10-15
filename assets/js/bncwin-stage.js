/* BNC WIN's 3D broadcast (bncwin.html): a night stadium, two athletes, a crowd and TV cameras, drawn with three.js.
   This file only draws. bncwin.js publishes what to show in window.BNC_VIEW every frame (phase, who leads and by how
   much, how far the race has run, how it ended) and the athletes and cameras follow it. Real-money outcomes remain
   server-authoritative; free-play outcomes only affect virtual credits. If WebGL isn't available the race still runs
   with the TV graphics.

   The athletes are one rigged character model (Mixamo character "Ch03", via the three.js examples). Their motions are
   Mixamo captures (run, walk, idle, a dejected pose and a head shake, from the "X Bot" rig) carried over bone by bone in
   world space, with the run given a longer racing stride and forward lean, plus poses built on the same skeleton
   (stretching, drinking, the start-line stance, celebrating, hands on head, and the crowd's sitting, waving and
   cheering); assets/models/bnc-athlete.glb holds them all. Each runner gets her own kit and fitted leggings, and the
   green runner (the player's) short natural curls like the BNC WIN picture. The crowd is the same model, drawn once per
   pose and outfit into a sprite sheet, so thousands of fans cost no more than one. */
import * as THREE from "../vendor/three/three.module.min.js";
import { GLTFLoader } from "../vendor/three/GLTFLoader.js";
import * as SU from "../vendor/three/SkeletonUtils.js";
import { mergeGeometries } from "../vendor/three/BufferGeometryUtils.js";

const stage = document.getElementById("bnStage");
const canvas = document.getElementById("bnCanvas");
const camLabel = document.getElementById("bnCam");
const FINISH = 160, GAP = 3.2, LANE = 1.22;
const RUN_SPEED = 3.5;   /* metres per second the run covers at normal playback: playback follows speed, so feet don't slide */
const WALK_SPEED = 1.64;
const GREEN_Z = LANE / 2, RED_Z = -LANE / 2; /* green, the player's runner, in the lane nearer the main cameras */
const small = Math.min(window.innerWidth, window.innerHeight) < 700;
const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function fail(why) {
  stage.dataset.three = "off";
  if (window.console) console.warn("BNC WIN 3D view off:", why);
}

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
} catch (e) { fail(e && e.message); }

if (renderer) start().catch((e) => fail(e && e.message));

async function start() {
  stage.dataset.three = "loading";
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.6 : 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0b1222, 70, 300);
  const camera = new THREE.PerspectiveCamera(32, 16 / 9, 0.1, 900);

  /* ---------------- sky, lights ---------------- */
  const sky = new THREE.Mesh(new THREE.SphereGeometry(700, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: "varying vec3 vp; void main(){ vp = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: "varying vec3 vp; void main(){ float h = clamp(vp.y, -0.1, 1.0);" +
      " vec3 top = vec3(0.012,0.02,0.06), mid = vec3(0.05,0.08,0.18), glow = vec3(0.32,0.26,0.2);" +
      " vec3 c = mix(mid, top, smoothstep(0.02, 0.5, h)); c += glow * pow(1.0 - clamp(h*3.0,0.0,1.0), 4.0) * 0.55;" +
      " gl_FragColor = vec4(c, 1.0); }",
  }));
  scene.add(sky);
  {
    const n = 500, p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, h = 0.25 + Math.random() * 0.75, r = 650;
      p.set([Math.cos(a) * r * Math.sqrt(1 - h * h), h * r, Math.sin(a) * r * Math.sqrt(1 - h * h)], i * 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xc8d4ff, size: 1.4, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.7 })));
  }
  scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x2a1c12, 0.75));
  const key = new THREE.DirectionalLight(0xfff1d6, 2.6);
  key.castShadow = true;
  key.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
  Object.assign(key.shadow.camera, { left: -14, right: 14, top: 10, bottom: -10, near: 1, far: 120 });
  key.shadow.bias = -0.0006; key.shadow.normalBias = 0.02;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0x9db8ff, 0.7);
  scene.add(fill, fill.target);
  const rim = new THREE.DirectionalLight(0xffe2b0, 1.1);
  scene.add(rim, rim.target);

  /* ---------------- canvas textures ---------------- */
  const canvasTex = (w, h, draw, repeat) => {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    draw(c.getContext("2d"), w, h);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
    return t;
  };
  let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  /* the track: 8 lanes of red tartan with white lines and lane numbers at the start, 40 m per tile */
  const TRACK_W = 8 * LANE + 1.2;
  const trackTex = canvasTex(1024, 256, (x, w, h) => {
    x.fillStyle = "#a83a2a"; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 9000; i++) { x.fillStyle = rnd() < 0.5 ? "rgba(0,0,0,.08)" : "rgba(255,190,160,.07)"; x.fillRect(rnd() * w, rnd() * h, 2, 2); }
    x.fillStyle = "rgba(255,255,255,.92)";
    const m = (0.6 / TRACK_W) * h;
    for (let i = 0; i <= 8; i++) x.fillRect(0, m + (i * LANE / TRACK_W) * h - 1.5, w, 3);
  }, [10, 1]);
  const track = new THREE.Mesh(new THREE.PlaneGeometry(400, TRACK_W), new THREE.MeshStandardMaterial({ map: trackTex, roughness: 0.92 }));
  track.rotation.x = -Math.PI / 2; track.position.set(100, 0, 0); track.receiveShadow = true;
  scene.add(track);
  const grassTex = canvasTex(512, 512, (x, w, h) => {
    for (let i = 0; i < 8; i++) { x.fillStyle = i % 2 ? "#1f6b33" : "#24793a"; x.fillRect(i * w / 8, 0, w / 8, h); }
    for (let i = 0; i < 12000; i++) { x.fillStyle = rnd() < 0.5 ? "rgba(0,0,0,.07)" : "rgba(160,255,160,.05)"; x.fillRect(rnd() * w, rnd() * h, 1.5, 2.5); }
  }, [40, 8]);
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(500, 90), new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 }));
  grass.rotation.x = -Math.PI / 2; grass.position.set(100, -0.01, TRACK_W / 2 + 45); grass.receiveShadow = true;
  scene.add(grass);
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(500, 3), new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.9 }));
  apron.rotation.x = -Math.PI / 2; apron.position.set(100, -0.005, -TRACK_W / 2 - 1.5);
  scene.add(apron);
  const kerb = new THREE.Mesh(new THREE.BoxGeometry(500, 0.06, 0.12), new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.6 }));
  kerb.position.set(100, 0.03, TRACK_W / 2 + 0.06); scene.add(kerb);
  const startLine = new THREE.Mesh(new THREE.PlaneGeometry(0.12, TRACK_W - 0.6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  startLine.rotation.x = -Math.PI / 2; startLine.position.set(0, 0.006, 0); scene.add(startLine);
  /* lane numbers painted behind the start line */
  for (let i = 0; i < 8; i++) {
    const tex = canvasTex(128, 128, (x, w, h) => { x.fillStyle = "rgba(255,255,255,.9)"; x.font = "900 96px Arial"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(String(i + 1), w / 2, h / 2); });
    const num = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    num.rotation.set(-Math.PI / 2, 0, -Math.PI / 2); num.position.set(-1.4, 0.007, -TRACK_W / 2 + 0.6 + LANE * (7 - i) + LANE / 2); scene.add(num);
  }
  const chequer = canvasTex(64, 512, (x, w, h) => { const s = w / 2; for (let r = 0; r < h / s; r++) for (let c = 0; c < 2; c++) { x.fillStyle = (r + c) % 2 ? "#111" : "#fff"; x.fillRect(c * s, r * s, s, s); } });
  const finishLine = new THREE.Mesh(new THREE.PlaneGeometry(0.6, TRACK_W - 0.6), new THREE.MeshBasicMaterial({ map: chequer }));
  finishLine.rotation.x = -Math.PI / 2; finishLine.position.set(FINISH, 0.006, 0); scene.add(finishLine);

  /* the finish gantry */
  {
    const gold = new THREE.MeshStandardMaterial({ color: 0xd9a514, metalness: 0.8, roughness: 0.3 });
    for (const z of [-TRACK_W / 2 - 0.5, TRACK_W / 2 + 0.5]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, 5.2, 0.35), gold); post.position.set(FINISH, 2.6, z); post.castShadow = true; scene.add(post);
    }
    const sign = canvasTex(1024, 128, (x, w, h) => {
      const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, "#151515"); g.addColorStop(1, "#000"); x.fillStyle = g; x.fillRect(0, 0, w, h);
      x.font = "900 78px Arial Black, Arial, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
      const t = x.createLinearGradient(0, 20, 0, 110); t.addColorStop(0, "#fff4b8"); t.addColorStop(0.5, "#ffd34d"); t.addColorStop(1, "#c98600");
      x.fillStyle = t; x.fillText("FINISH  ·  BNC WIN", w / 2, h / 2 + 4);
    });
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.1, TRACK_W + 1.4), [gold, gold, gold, gold,
      new THREE.MeshBasicMaterial({ map: sign }), new THREE.MeshBasicMaterial({ map: sign })]);
    beam.position.set(FINISH, 5.4, 0); scene.add(beam);
  }

  /* ---------------- the main stand and the boards ---------------- */
  const ROWS = small ? 11 : 15, X0 = -60, X1 = 260;
  const standMat = new THREE.MeshStandardMaterial({ color: 0x1b2230, roughness: 0.95 });
  const stepGeo = [];
  for (let r = 0; r < ROWS; r++) {
    const g = new THREE.BoxGeometry(X1 - X0, 0.55, 0.85);
    g.translate((X0 + X1) / 2, 1.1 + r * 0.55 - 0.275 + 0.3, -TRACK_W / 2 - 3.6 - r * 0.85);
    stepGeo.push(g);
  }
  const back = new THREE.BoxGeometry(X1 - X0, 4, 0.4); back.translate((X0 + X1) / 2, 1.4 + ROWS * 0.55 + 1.2, -TRACK_W / 2 - 3.6 - ROWS * 0.85);
  stepGeo.push(back);
  const stand = new THREE.Mesh(mergeGeometries(stepGeo), standMat); stand.receiveShadow = true; scene.add(stand);
  const roofY = 1.4 + ROWS * 0.55 + 5.2;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(X1 - X0, 0.3, ROWS * 0.85 + 4), new THREE.MeshStandardMaterial({ color: 0x10141c, roughness: 0.8 }));
  roof.position.set((X0 + X1) / 2, roofY, -TRACK_W / 2 - 3.6 - ROWS * 0.85 / 2 - 1); roof.rotation.x = -0.08; scene.add(roof);
  const strip = new THREE.Mesh(new THREE.BoxGeometry(X1 - X0, 0.12, 0.12), new THREE.MeshBasicMaterial({ color: 0xfff2c6 }));
  strip.position.set((X0 + X1) / 2, roofY - 0.35, -TRACK_W / 2 - 2.6); scene.add(strip);
  const ledTex = canvasTex(2048, 128, (x, w, h) => {
    x.fillStyle = "#050505"; x.fillRect(0, 0, w, h);
    const items = [["WIN B", "#ffd34d"], ["BNC WIN RACING", "#6ff0a4"], ["VIRTUAL RACE", "#ffffff"], ["PLAY RESPONSIBLY · 18+", "#ff8a84"]];
    x.font = "900 70px Arial Black, Arial, sans-serif"; x.textBaseline = "middle";
    let px = 30; let i = 0;
    for (;;) { const [t, c] = items[i++ % items.length]; const tw = x.measureText(t).width; if (px + tw > w - 20) break; x.fillStyle = c; x.fillText(t, px, h / 2 + 4); px += tw + 90; x.fillStyle = "#333"; x.fillRect(px - 50, 30, 8, 68); }
    x.fillStyle = "rgba(0,0,0,.35)"; for (let y = 0; y < h; y += 4) x.fillRect(0, y, w, 1.5);
  }, [12, 1]);
  const black = new THREE.MeshBasicMaterial({ color: 0x050505 });
  const boards = new THREE.Mesh(new THREE.BoxGeometry(X1 - X0, 0.95, 0.12), [black, black, black, black, new THREE.MeshBasicMaterial({ map: ledTex, toneMapped: false }), black]);
  boards.position.set((X0 + X1) / 2, 0.48, -TRACK_W / 2 - 2.9); scene.add(boards);

  /* floodlight towers on both sides, with glow and a soft beam */
  const glowTex = canvasTex(128, 128, (x, w) => {
    const g = x.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    g.addColorStop(0, "rgba(255,255,240,1)"); g.addColorStop(0.18, "rgba(255,246,210,.85)"); g.addColorStop(0.5, "rgba(255,226,160,.18)"); g.addColorStop(1, "rgba(255,220,150,0)");
    x.fillStyle = g; x.fillRect(0, 0, w, w);
  });
  const beamTex = canvasTex(64, 256, (x, w, h) => { const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, "rgba(255,244,214,.55)"); g.addColorStop(1, "rgba(255,244,214,0)"); x.fillStyle = g; x.fillRect(0, 0, w, h); });
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a4250, metalness: 0.6, roughness: 0.5 });
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff6dc, toneMapped: false });
  for (const side of [-1, 1]) {
    for (const x of [-30, 30, 90, 150, 210]) {
      const z = side < 0 ? -TRACK_W / 2 - 3.6 - ROWS * 0.85 - 6 : TRACK_W / 2 + 34;
      const H = 34;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.6, H, 8), poleMat); pole.position.set(x, H / 2, z); scene.add(pole);
      const head = new THREE.Group(); head.position.set(x, H + 1.5, z); head.lookAt(x, 0, 0); scene.add(head);
      const panel = new THREE.Mesh(new THREE.BoxGeometry(7, 3.4, 0.4), poleMat); head.add(panel);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) {
        const l = new THREE.Mesh(new THREE.CircleGeometry(0.62, 12), lampMat); l.position.set(-2.6 + i * 1.72, -0.8 + j * 1.6, 0.21); head.add(l);
      }
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false, opacity: 0.95 }));
      glow.scale.set(26, 18, 1); glow.position.set(x, H + 1.5, z + side * -0.6); scene.add(glow);
      const beam = new THREE.Mesh(new THREE.ConeGeometry(12, H + 4, 24, 1, true), new THREE.MeshBasicMaterial({ map: beamTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.07, side: THREE.DoubleSide, fog: false }));
      beam.position.set(x, H / 2, z / 2); beam.lookAt(x, H + 1.5, z); beam.rotateX(Math.PI / 2);
      scene.add(beam);
    }
  }

  /* the camera rail along the infield, the dolly that rides it, and a TV camera by the finish */
  const rail = new THREE.Mesh(new THREE.BoxGeometry(400, 0.08, 0.3), new THREE.MeshStandardMaterial({ color: 0x555b66, metalness: 0.7, roughness: 0.4 }));
  rail.position.set(100, 0.05, TRACK_W / 2 + 1.6); scene.add(rail);
  const tvCamera = () => {
    const g = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.5, metalness: 0.4 });
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.3, 0.8), dark); base.position.y = 0.25; g.add(base);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.1, 8), dark); mast.position.y = 0.9; g.add(mast);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.32, 0.3), dark); body.position.set(0, 1.5, 0); g.add(body);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.42, 12), dark); lens.rotation.z = Math.PI / 2; lens.position.set(0.48, 1.5, 0); g.add(lens);
    const tally = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2020 })); tally.position.set(0.1, 1.7, 0.16); g.add(tally);
    g.traverse((o) => { o.castShadow = true; });
    return g;
  };
  const dolly = tvCamera(); dolly.position.set(0, 0, TRACK_W / 2 + 1.6); scene.add(dolly);
  const finishCam = tvCamera(); finishCam.position.set(FINISH + 14, 0, TRACK_W / 2 + 3); finishCam.rotation.y = Math.PI; scene.add(finishCam);

  /* ---------------- the athletes ---------------- */
  const gltf = await new GLTFLoader().loadAsync("assets/models/bnc-athlete.glb?v=2");
  const clips = Object.fromEntries(gltf.animations.map((a) => [a.name, a]));

  /* ---------------- the crowd: real figures, drawn once per pose and outfit into a sprite sheet ---------------- */
  const crowdU = { uTime: { value: 0 }, uExcite: { value: 0.3 } };
  const FRAMES = [["sit", 0], ["sitcheer", 0], ["sitwave", 0], ["idle", 0.4], ["cheer", 0], ["celebrate", 0.6], ["wave", 0], ["wave", 0.4]];
  const OUTFITS = [[[255, 211, 77], [30, 34, 48]], [[24, 178, 87], [20, 24, 30]], [[224, 31, 45], [40, 44, 60]], [[240, 240, 240], [44, 70, 120]], [[42, 111, 219], [26, 26, 30]], [[255, 140, 26], [50, 40, 34]]];
  const CW = 80, CH = 160, COLS = FRAMES.length, ROWS_A = OUTFITS.length;
  const atlas = new THREE.WebGLRenderTarget(CW * COLS, CH * ROWS_A, { samples: 0 });
  atlas.texture.colorSpace = THREE.SRGBColorSpace;
  atlas.texture.generateMipmaps = true; atlas.texture.minFilter = THREE.LinearMipmapLinearFilter;
  {
    const sScene = new THREE.Scene();
    sScene.add(new THREE.HemisphereLight(0xb8c8ff, 0x302418, 1.3));
    const sl = new THREE.DirectionalLight(0xfff1d6, 2.4); sl.position.set(1, 3, 4); sScene.add(sl);
    const oc = new THREE.OrthographicCamera(-0.5, 0.5, 1.95, -0.05, 0.1, 10); oc.position.set(0, 0.9, 5); oc.lookAt(0, 0.9, 0);
    const prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha(), prevTone = renderer.toneMapping;
    renderer.setRenderTarget(atlas); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.toneMapping = THREE.NoToneMapping;
    OUTFITS.forEach(([top, pants], row) => {
      const fan = buildAthlete(gltf, { top, pants, hair: row % 2 ? "crop" : "puffs", fan: true });
      sScene.add(fan);
      const mixer = new THREE.AnimationMixer(fan);
      FRAMES.forEach(([name, t], col) => {
        mixer.stopAllAction(); const a = mixer.clipAction(clips[name]); a.reset().play(); mixer.setTime(Math.min(t, clips[name].duration - 0.01));
        fan.position.y = 0; groundClamp(fan, 0);
        atlas.viewport.set(col * CW, row * CH, CW, CH); atlas.scissor.set(col * CW, row * CH, CW, CH); atlas.scissorTest = true;
        renderer.setRenderTarget(atlas);
        renderer.render(sScene, oc);
      });
      sScene.remove(fan);
    });
    atlas.viewport.set(0, 0, CW * COLS, CH * ROWS_A); atlas.scissorTest = false;
    renderer.setRenderTarget(prevTarget); renderer.setClearColor(prevClear, prevAlpha); renderer.toneMapping = prevTone;
  }
  {
    const quad = new THREE.PlaneGeometry(0.62, 1.24); quad.translate(0, 0.62 - 0.03, 0);
    const step = small ? 0.62 : 0.5;
    const per = Math.floor((210 - -45) / step);
    const total = per * ROWS;
    const geo = new THREE.InstancedBufferGeometry(); geo.index = quad.index; geo.attributes.position = quad.attributes.position; geo.attributes.uv = quad.attributes.uv;
    const offs = new Float32Array(total * 3), rnds = new Float32Array(total * 4);
    let k = 0;
    for (let r = 0; r < ROWS; r++) for (let i = 0; i < per; i++) {
      if (rnd() < 0.08) continue; /* an empty seat */
      offs.set([-45 + i * step + rnd() * 0.12, 1.1 + r * 0.55 + 0.3 - 0.02, -TRACK_W / 2 - 3.5 - r * 0.85], k * 3);
      rnds.set([rnd(), rnd(), rnd(), Math.floor(rnd() * ROWS_A)], k * 4);
      k++;
    }
    geo.setAttribute("offset", new THREE.InstancedBufferAttribute(offs.subarray(0, k * 3), 3));
    geo.setAttribute("rnd", new THREE.InstancedBufferAttribute(rnds.subarray(0, k * 4), 4));
    geo.instanceCount = k;
    const mat = new THREE.ShaderMaterial({
      transparent: false,
      uniforms: { map: { value: atlas.texture }, uTime: crowdU.uTime, uExcite: crowdU.uExcite, fogColor: { value: scene.fog.color }, fogNear: { value: scene.fog.near }, fogFar: { value: scene.fog.far } },
      vertexShader: [
        "attribute vec3 offset; attribute vec4 rnd; uniform float uTime; uniform float uExcite; varying vec2 vUv; varying float vShade; varying float vFog;",
        "void main(){",
        "  float ex = uExcite;",
        "  float seated = step(rnd.x, 0.62 - 0.5 * ex);",      /* more fans on their feet as the race heats up */
        "  float act = step(rnd.y, ex * 0.9);",
        "  float beat = step(0.0, sin(uTime * (3.0 + rnd.z * 3.0) + rnd.z * 40.0));",
        "  float col = seated > 0.5 ? (act > 0.5 ? (rnd.z < 0.5 ? 1.0 : 2.0) : 0.0) : (act > 0.5 ? 4.0 + beat : (rnd.z < 0.22 ? 6.0 + beat : 3.0));",
        "  float jump = (1.0 - seated) * act * max(0.0, sin(uTime * (5.0 + rnd.z * 3.0) + rnd.z * 30.0)) * 0.12;",
        "  vUv = vec2((col + uv.x) / " + COLS.toFixed(1) + ", (rnd.w + uv.y) / " + ROWS_A.toFixed(1) + ");",
        "  vShade = 0.72 + rnd.y * 0.35;",
        "  vec4 mv = modelViewMatrix * vec4(position + offset + vec3(0.0, jump - seated * 0.0, 0.0), 1.0);",
        "  vFog = -mv.z; gl_Position = projectionMatrix * mv; }",
      ].join("\n"),
      fragmentShader: [
        "uniform sampler2D map; uniform vec3 fogColor; uniform float fogNear; uniform float fogFar; varying vec2 vUv; varying float vShade; varying float vFog;",
        "void main(){ vec4 c = texture2D(map, vUv); if (c.a < 0.45) discard;",
        "  vec3 col = c.rgb * vShade; col = mix(col, fogColor, smoothstep(fogNear, fogFar, vFog));",
        "  gl_FragColor = vec4(col, 1.0);",
        "#include <colorspace_fragment>",
        "}",
      ].join("\n"),
    });
    const crowd = new THREE.Mesh(geo, mat); crowd.frustumCulled = false;
    scene.add(crowd);
  }

  /* ---------------- the two runners ---------------- */
  const runners = { green: makeRunner("green", GREEN_Z), red: makeRunner("red", RED_Z) };
  function makeRunner(kind, z) {
    const root = buildAthlete(gltf, kind === "green" ? { top: [34, 205, 104], pants: [24, 150, 76], hair: "crop" } : { top: [226, 34, 44], pants: [180, 22, 34], hair: "puffs" });
    root.position.set(kind === "green" ? -4 : -6, 0, z * 3);
    scene.add(root);
    const mixer = new THREE.AnimationMixer(root);
    const actions = {};
    for (const n of Object.keys(clips)) actions[n] = mixer.clipAction(clips[n]);
    for (const n of ["set", "sad"]) { actions[n].setLoop(THREE.LoopOnce, 1); actions[n].clampWhenFinished = true; }
    actions.idle.play();
    /* a water bottle she picks up to drink */
    let hand = null; root.traverse((o) => { if (o.isBone && o.name === "mixamorigRightHand") hand = o; });
    root.updateMatrixWorld(true);
    const ws = hand.getWorldScale(new THREE.Vector3()).x;
    const bottle = new THREE.Group();
    const bodyB = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.034, 0.2, 12), new THREE.MeshStandardMaterial({ color: 0xbfe6ff, roughness: 0.15, transparent: true, opacity: 0.85 }));
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.04, 10), new THREE.MeshStandardMaterial({ color: kind === "green" ? 0x18b257 : 0xe01f2d }));
    cap.position.y = 0.12; bottle.add(bodyB, cap);
    bottle.scale.setScalar(1 / ws); bottle.position.set(0, 0.08 / ws, 0.03 / ws); bottle.rotation.x = -0.4;
    hand.add(bottle); bottle.visible = false;
    return { kind, root, mixer, actions, now: "idle", x: root.position.x, vel: 0, z, phase: 0, mode: "wander", modeAt: 0, target: null, yaw: Math.PI / 2, bottle, jitter: 1 };
  }
  function play(r, name, fade = 0.35) {
    if (r.now === name) return;
    const from = r.actions[r.now], to = r.actions[name];
    to.reset().play(); to.crossFadeFrom(from, fade, false);
    r.now = name;
    r.bottle.visible = name === "drink";
  }
  function face(r, yaw, dt, rate = 6) {
    let d = yaw - r.yaw; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
    r.yaw += d * Math.min(1, dt * rate);
    r.root.rotation.y = r.yaw;
  }

  /* ---------------- what the athletes do ---------------- */
  let raceKey = null, endedAt = 0, endKind = null, leadSign = 0, style = 0;
  const ACCEL = 0.1; /* the first 10% of the race is the drive off the line */
  const along = (p) => (p < ACCEL ? (p * p) / (2 * ACCEL) : p - ACCEL / 2) / (1 - ACCEL / 2);
  function wander(r, t, dt) {
    /* before a race: walk about near the start, stretch, take a drink, shake out */
    if (r.mode !== "wander" && r.mode !== "action") { r.mode = "wander"; r.target = null; }
    if (r.mode === "action") {
      if (t > r.modeAt) { r.mode = "wander"; r.target = null; }
      return;
    }
    if (!r.target) {
      const side = r.kind === "green" ? 1 : -1;
      r.target = new THREE.Vector3(-10 + Math.random() * 12, 0, side * (0.6 + Math.random() * 2.6));
    }
    const dx = r.target.x - r.root.position.x, dz = r.target.z - r.root.position.z, dist = Math.hypot(dx, dz);
    if (dist < 0.3) {
      const pick = Math.random();
      const act = pick < 0.34 ? "stretch" : pick < 0.62 ? "drink" : pick < 0.8 ? "shake" : "idle";
      play(r, act);
      r.mode = "action"; r.modeAt = t + (act === "idle" ? 2 + Math.random() * 2 : clips[act].duration * (act === "stretch" ? 1 : 1));
      r.target = null; r.vel = 0;
      return;
    }
    play(r, "walk");
    r.actions.walk.timeScale = 1;
    face(r, Math.atan2(dx, dz), dt, 4);
    const sp = WALK_SPEED * Math.min(1, Math.max(0, Math.cos(Math.atan2(dx, dz) - r.yaw))); /* turn before walking off */
    r.root.position.x += (dx / dist) * sp * dt; r.root.position.z += (dz / dist) * sp * dt;
    r.x = r.root.position.x;
  }
  function updateRunners(v, dt, t) {
    const G = runners.green, R = runners.red;
    if (v.raceId !== raceKey) {
      raceKey = v.raceId; endKind = null; style = Math.floor(Math.random() * 4);
      for (const r of [G, R]) { r.jitter = 0.97 + Math.random() * 0.06; }
      if (v.phase === "countdown" || v.phase === "running") onLine(t);
    }
    if (v.phase === "countdown" && G.mode !== "set") onLine(t);
    if (v.phase === "running") {
      if (G.mode !== "race") { for (const r of [G, R]) { r.mode = "race"; r.x = 0; r.vel = 0; } cutTo(pickRun(), t); }
      const base = along(v.prog) * FINISH, lead = v.lead;
      for (const [r, tx] of [[G, base + lead * GAP], [R, base - lead * GAP]]) {
        const before = r.x;
        r.x += (tx - r.x) * Math.min(1, dt * 2.6);
        const vel = (r.x - before) / Math.max(dt, 1e-3);
        r.vel += (vel - r.vel) * Math.min(1, dt * 5);
        r.root.position.set(r.x, 0, r.z);
        face(r, Math.PI / 2, dt, 10);
        play(r, "run", 0.25);
        r.actions.run.timeScale = THREE.MathUtils.clamp((Math.abs(r.vel) / RUN_SPEED) * r.jitter, 0.35, 2.4);
      }
    } else if (v.phase === "ended") {
      if (endKind !== v.ended) { endKind = v.ended; endedAt = t; cutTo(v.ended === "BUSTED" ? "closeRed" : "close", t); for (const r of [G, R]) if (r.mode !== "race") { r.mode = "race"; } }
      const since = t - endedAt;
      const greenWon = v.ended !== "BUSTED" && v.lead > 0;
      for (const r of [G, R]) {
        if (r.mode === "race") {
          const sprint = v.ended === "BUSTED" && r === R && since < 2.6; /* red breaks away */
          if (sprint) r.vel += (8 - r.vel) * Math.min(1, dt * 3);
          else r.vel *= Math.exp(-dt * (r === G && v.ended === "BUSTED" ? 1.6 : 1.0));
          r.x += r.vel * dt; r.root.position.x = r.x;
          if (r.vel > 2.2) { play(r, "run", 0.3); r.actions.run.timeScale = THREE.MathUtils.clamp(r.vel / RUN_SPEED, 0.5, 2.4); }
          else if (r.vel > 0.35) { play(r, "walk", 0.4); r.actions.walk.timeScale = THREE.MathUtils.clamp(r.vel / WALK_SPEED, 0.6, 1.3); }
          else { r.vel = 0; r.mode = "react"; r.modeAt = t; }
        } else if (r.mode === "react") {
          const won = (r === G) === greenWon;
          const tt = t - r.modeAt;
          if (won) { play(r, "celebrate", 0.3); face(r, 0.25, dt, 2); } /* turns to the cameras and the crowd */
          else if (tt < 3) play(r, "hands", 0.4);
          else if (tt < 5.6) play(r, "shake", 0.4);
          else play(r, "idle", 0.6);
          if (since > 10) { r.mode = "wander"; r.target = null; }
        } else wander(r, t, dt);
      }
    } else if (v.phase === "countdown") {
      for (const r of [G, R]) { r.root.position.set(r.x, 0, r.z); face(r, Math.PI / 2, dt, 10); }
    } else {
      for (const r of [G, R]) wander(r, t, dt);
    }
    for (const r of [G, R]) {
      r.mixer.update(dt);
      groundClamp(r.root, r.now === "celebrate" ? Math.max(0, Math.sin((t - r.modeAt) * 5.2)) * 0.16 : 0);
      if (r.now === "run") { /* footsteps: two per stride */
        const ph = (r.actions.run.time / clips.run.duration) % 1, half = ph < 0.5 ? 0 : 1;
        if (half !== r.phase) { r.phase = half; if (window.BNCSound && window.BNCSound.step) window.BNCSound.step(r.kind, Math.abs(r.vel)); }
      }
    }
    /* the crowd: louder and more on their feet when it's close, near the end, and at the finish */
    const close = v.phase === "running" ? 1 - Math.min(1, Math.abs(v.lead) * 1.6) : 0;
    const target = v.phase === "running" ? 0.4 + 0.3 * close + (v.prog > 0.8 ? 0.35 : 0) : v.phase === "ended" ? (t - endedAt < 6 ? 1 : 0.25) : v.phase === "countdown" ? 0.55 : 0.18;
    crowdU.uExcite.value += (Math.min(1, target) - crowdU.uExcite.value) * Math.min(1, dt * 1.6);
    crowdU.uTime.value = t;
    if (window.BNCSound && window.BNCSound.crowd) window.BNCSound.crowd(crowdU.uExcite.value);
    const sign = v.phase === "running" ? (v.lead > 0.03 ? 1 : v.lead < -0.03 ? -1 : leadSign) : 0;
    if (sign !== leadSign && sign !== 0 && v.phase === "running" && t - shotAt > 2.2) cutTo(Math.random() < 0.7 ? "close" : "crowd", t);
    leadSign = sign;
  }
  function onLine(t) {
    /* to the line, in their lanes, in the set position (the camera cuts to the start as they settle) */
    for (const r of [runners.green, runners.red]) {
      r.mode = "set"; r.x = -0.35; r.vel = 0; r.yaw = Math.PI / 2; r.root.rotation.y = r.yaw;
      r.root.position.set(r.x, 0, r.z);
      r.actions.set.reset(); play(r, "set", 0.15);
    }
    cutTo("start", t);
  }

  /* ---------------- the TV cameras ---------------- */
  const SHOT_NAMES = { wide: "STADIUM", grid: "WARM-UP", start: "START LINE", side: "TRACKSIDE", front: "HEAD-ON", chase: "CHASE CAM", aerial: "SKY CAM", close: "CLOSE-UP", closeRed: "CLOSE-UP", finish: "FINISH LINE", crowd: "CROWD", warmG: "GREEN · WARM-UP", warmR: "RED · WARM-UP" };
  const RUN_ORDERS = [
    ["side", "front", "side", "chase", "crowd", "side", "close", "aerial", "front"],
    ["front", "side", "close", "chase", "side", "aerial", "crowd", "side"],
    ["side", "chase", "front", "close", "side", "crowd", "aerial", "side"],
    ["chase", "side", "aerial", "front", "close", "side", "crowd"],
  ];
  let shot = "wide", shotAt = -99, order = 0, finishShown = false;
  const pickRun = () => { order = 0; return RUN_ORDERS[style][0]; };
  const camPos = new THREE.Vector3(-20, 9, 24), camLook = new THREE.Vector3(10, 1, 0), wantPos = new THREE.Vector3(), wantLook = new THREE.Vector3();
  let fov = 40, snap = true;
  function cutTo(name, t) {
    if (name === shot && t - shotAt < 1) return;
    shot = name; shotAt = t; snap = true;
    const n = Object.keys(SHOT_NAMES).indexOf(name) + 1;
    if (camLabel) camLabel.textContent = "CAM " + n + " · " + SHOT_NAMES[name];
    stage.classList.remove("cut"); void stage.offsetWidth; stage.classList.add("cut");
  }
  const headOf = (r) => r.root.position.clone().add(new THREE.Vector3(0, 1.3, 0));
  function frameShot(t, dt, v) {
    const G = runners.green, R = runners.red;
    const gx = G.root.position.x, rx = R.root.position.x;
    const mid = (gx + rx) / 2, front = Math.max(gx, rx), backX = Math.min(gx, rx);
    const lead = gx >= rx ? G : R;
    const st = t - shotAt;
    let f = 32;
    const closeOn = (r, dist) => { const h = headOf(r); wantPos.set(h.x + dist * 0.95, 1.5, r.root.position.z + dist); wantLook.set(h.x - 0.1, 1.15, r.root.position.z); };
    switch (shot) {
      case "wide": wantPos.set(mid - 26 + Math.sin(t * 0.08) * 6, 10, 26); wantLook.set(mid + 12, 2, -6); f = 46; break;
      case "grid": wantPos.set(mid + 8 * Math.cos(0.9 + st * 0.1), 1.7, 7 * Math.sin(0.9 + st * 0.1) + 0.3); wantLook.set(mid, 1.0, (G.root.position.z + R.root.position.z) / 2); f = 36; break;
      case "warmG": closeOn(G, 3.2); f = 30; break;
      case "warmR": closeOn(R, 3.2); f = 30; break;
      case "start": wantPos.set(5.5 - Math.min(st, 3) * 0.25, 0.75, 1.4); wantLook.set(0, 0.85, 0); f = 30; break;
      case "side": wantPos.set(mid + 2.2, 1.75, 9.5); wantLook.set(mid + 1.2, 0.95, -0.3); f = 30; break;
      case "front": wantPos.set(front + 17, 1.3, 1.6); wantLook.set(mid, 1.0, 0); f = 19; break;
      case "chase": wantPos.set(backX - 6.5, 2.4, 3.6); wantLook.set(front + 5, 0.9, -0.5); f = 40; break;
      case "aerial": wantPos.set(mid - 12, 16, 19); wantLook.set(mid + 6, 0, -4); f = 40; break;
      case "close": closeOn(v.phase === "running" ? lead : G, 2.9); f = 30; break;
      case "closeRed": closeOn(R, 3.4); f = 30; break;
      case "finish": wantPos.set(FINISH + 12, 1.35, 1.9); wantLook.set(mid, 1.0, 0); f = 22; break;
      case "crowd": wantPos.set(mid + 3 - st * 0.6, 1.6, 0.5); wantLook.set(mid + 10 - st * 0.6, 4.2, -14); f = 34; break;
    }
    if (!reduce && shot !== "aerial" && shot !== "wide") { wantPos.y += Math.sin(t * 1.7) * 0.03; wantPos.x += Math.sin(t * 1.1) * 0.05; }
    /* the shots are composed for a wide TV picture; on a tall phone screen widen the lens so both runners stay in */
    if (camera.aspect < 1.5) f = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(f) / 2) * Math.min(2.4, (16 / 9) / camera.aspect * 0.66)));
    if (snap) { camPos.copy(wantPos); camLook.copy(wantLook); fov = f; snap = false; }
    else {
      const k = Math.min(1, dt * (shot === "front" || shot === "finish" ? 2.2 : 3.4));
      camPos.lerp(wantPos, k); camLook.lerp(wantLook, Math.min(1, dt * 5)); fov += (f - fov) * k;
    }
    camera.position.copy(camPos); camera.lookAt(camLook);
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
    /* the director */
    if (v.phase === "running") {
      if (v.prog > 0.86 && !finishShown) { finishShown = true; cutTo("finish", t); }
      else if (st > (shot === "close" || shot === "crowd" ? 3.4 : 5.4) && !(shot === "finish" && v.prog < 0.995)) { const o = RUN_ORDERS[style]; cutTo(o[++order % o.length], t); }
    } else {
      finishShown = false;
      if (v.phase === "countdown") { if (shot !== "start") cutTo("start", t); }
      else if (v.phase === "ended" && t - endedAt < 7) { if (st > 4 && shot !== "crowd") cutTo("crowd", t); }
      else if (st > 6.5) { const idle = ["wide", "warmG", "grid", "warmR", "crowd"]; cutTo(idle[(idle.indexOf(shot) + 1) % idle.length], t); }
    }
    key.position.set(mid + 18, 38, 26); key.target.position.set(mid, 0, 0);
    fill.position.set(mid - 20, 20, -30); fill.target.position.set(mid, 1, 0);
    rim.position.set(mid - 30, 14, 4); rim.target.position.set(mid, 1, 0);
    dolly.position.x = mid - 7; /* the rail camera rides just behind the runners, out of the trackside shot */
    ledTex.offset.x = (t * 0.02) % 1;
  }

  /* ---------------- size, loop ---------------- */
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      /* frame the action in the upper part of the picture, clear of the graphics along the bottom */
      camera.setViewOffset(w, h, 0, h * (w < h ? 0.2 : 0.13), w, h);
      camera.updateProjectionMatrix();
    }
  }
  let visible = true;
  if ("IntersectionObserver" in window) new IntersectionObserver((e) => { visible = e[0].isIntersecting; }).observe(stage);
  const clock = new THREE.Clock();
  let t = 0;
  function loop() {
    requestAnimationFrame(loop);
    const dt = Math.min(0.1, clock.getDelta());
    t += dt;
    if (!visible || document.hidden) return;
    const v = window.BNC_VIEW || { phase: "idle", lead: 0, prog: 0, raceId: null };
    resize();
    updateRunners(v, dt, t);
    frameShot(t, dt, v);
    renderer.render(scene, camera);
  }
  cutTo("wide", 0);
  /* prepare every shader before the first frame, without freezing the page (phones compile in the background) */
  try { await renderer.compileAsync(scene, camera); } catch (e) { /* older browsers compile on the first frame */ }
  loop();
  stage.dataset.three = "ready";
  window.BNCStage = { ready: true, shot: () => shot, modes: () => [runners.green.mode + ":" + runners.green.now, runners.red.mode + ":" + runners.red.now] };
}

/* feet on the ground: lift or lower the whole figure so its lowest foot touches the track (plus an optional hop) */
const _v = new THREE.Vector3();
function groundClamp(root, hop) {
  root.updateMatrixWorld(true);
  if (!root.userData.feet) { const f = []; root.traverse((o) => { if (o.isBone && /(Foot|ToeBase|Toe_End)$/.test(o.name)) f.push(o); }); root.userData.feet = f; }
  let low = Infinity;
  for (const b of root.userData.feet) low = Math.min(low, b.getWorldPosition(_v).y);
  if (low !== Infinity) { root.position.y += -(low - 0.035) + hop; root.updateMatrixWorld(true); }
}

/* ---------------- the athletes' looks ---------------- */
function components(g) {
  const P = g.attributes.position, I = g.index, n = P.count;
  const par = new Int32Array(n); for (let i = 0; i < n; i++) par[i] = i;
  const f = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let t = 0; t < I.count; t += 3) { const a = f(I.getX(t)); par[f(I.getX(t + 1))] = a; par[f(I.getX(t + 2))] = a; }
  const seen = new Map();
  for (let i = 0; i < n; i++) { const k = P.getX(i).toFixed(4) + "," + P.getY(i).toFixed(4) + "," + P.getZ(i).toFixed(4); if (seen.has(k)) par[f(i)] = f(seen.get(k)); else seen.set(k, i); }
  const size = new Map(); for (let i = 0; i < n; i++) { const r = f(i); size.set(r, (size.get(r) || 0) + 1); }
  return { f, size };
}
/* the kit: the top and the leggings take their colours */
const kitCache = new Map();
function kitTexture(img, top, pants) {
  const id = top.join() + "|" + pants.join();
  if (kitCache.has(id)) return kitCache.get(id);
  const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
  const x = c.getContext("2d"); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height), p = d.data;
  const sx = c.width / 512, sy = c.height / 512;
  for (let i = 0; i < p.length; i += 4) {
    const r = p[i] / 255, g = p[i + 1] / 255, b = p[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, s = mx - mn;
    let h = 0; if (s > 0.0001) { if (mx === r) h = ((g - b) / s) % 6; else if (mx === g) h = (b - r) / s + 2; else h = (r - g) / s + 4; h *= 60; if (h < 0) h += 360; }
    const px = ((i / 4) % c.width) / sx, py = ((i / 4 / c.width) | 0) / sy;
    const yellow = s > 0.35 && h > 40 && h < 70;
    const grey = s < 0.14 && l > 0.3 && l < 0.86 && px > 240 && px < 470 && py > 190 && py < 330; /* the top only */
    if (!yellow && !grey) continue;
    const hue = yellow ? pants : top;
    const k = yellow ? Math.min(1.25, l * 1.55) : l * 1.15;
    p[i] = Math.min(255, hue[0] * k); p[i + 1] = Math.min(255, hue[1] * k); p[i + 2] = Math.min(255, hue[2] * k);
  }
  x.putImageData(d, 0, 0);
  const t = new THREE.CanvasTexture(c); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace;
  kitCache.set(id, t);
  return t;
}
let curls = null;
function curlTexture() {
  if (curls) return curls;
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const x = c.getContext("2d"); x.fillStyle = "#120a07"; x.fillRect(0, 0, 256, 256);
  let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 1400; i++) {
    const cx = rnd() * 256, cy = rnd() * 256, r = 2 + rnd() * 3.5;
    x.strokeStyle = "rgba(" + (40 + rnd() * 40 | 0) + "," + (26 + rnd() * 22 | 0) + "," + (18 + rnd() * 16 | 0) + "," + (0.55 + rnd() * 0.4) + ")";
    x.lineWidth = 1 + rnd() * 1.2; x.beginPath(); x.arc(cx, cy, r, rnd() * 6, rnd() * 6 + 4.5); x.stroke();
  }
  curls = new THREE.CanvasTexture(c); curls.wrapS = curls.wrapT = THREE.RepeatWrapping; curls.colorSpace = THREE.SRGBColorSpace;
  return curls;
}
/* fitted leggings: pull the trouser surface in toward each leg's bone line (hip → knee → ankle) */
let slimmed = null; /* worked out once, shared by every figure */
function slimLegs(sk) {
  const g = sk.geometry, P = g.attributes.position, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight;
  if (slimmed) { g.setAttribute("position", slimmed); g.computeVertexNormals(); return; }
  const bones = sk.skeleton.bones, inv = sk.skeleton.boneInverses;
  const idx = (n) => bones.findIndex((b) => b.name === n);
  const jointPos = (i) => new THREE.Vector3().setFromMatrixPosition(inv[i].clone().invert()).applyMatrix4(sk.bindMatrixInverse);
  const legs = ["Left", "Right"].map((s) => {
    const up = idx("mixamorig" + s + "UpLeg"), lo = idx("mixamorig" + s + "Leg"), ft = idx("mixamorig" + s + "Foot");
    return { up, lo, hip: jointPos(up), knee: jointPos(lo), ankle: jointPos(ft) };
  });
  const thigh = [0.08, 0.056], calf = [0.054, 0.035];
  const v = new THREE.Vector3(), seg = new THREE.Vector3(), proj = new THREE.Vector3(), off = new THREE.Vector3();
  const pos = P.array.slice();
  for (let i = 0; i < P.count; i++) {
    let best = -1, bw = 0;
    for (let k = 0; k < 4; k++) { const w = SW.getComponent(i, k); if (w > bw) { bw = w; best = SI.getComponent(i, k); } }
    const leg = legs.find((l) => l.up === best || l.lo === best);
    if (!leg) continue;
    v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    const a = best === leg.up ? leg.hip : leg.knee, b = best === leg.up ? leg.knee : leg.ankle, r = best === leg.up ? thigh : calf;
    seg.subVectors(b, a);
    const t = THREE.MathUtils.clamp(off.subVectors(v, a).dot(seg) / seg.lengthSq(), 0, 1);
    if (best === leg.up && t < 0.12) continue; /* leave the hips and waistband alone */
    proj.copy(a).addScaledVector(seg, t);
    off.subVectors(v, proj); const d = off.length(), target = r[0] + (r[1] - r[0]) * t;
    if (d > target) { off.multiplyScalar((target + (d - target) * 0.18) / d); pos[i * 3] = proj.x + off.x; pos[i * 3 + 1] = proj.y + off.y; pos[i * 3 + 2] = proj.z + off.z; }
  }
  slimmed = new THREE.BufferAttribute(pos, 3);
  g.setAttribute("position", slimmed);
  g.computeVertexNormals();
}
function buildAthlete(gltf, look) {
  const root = SU.clone(gltf.scene);
  let sk; root.traverse((o) => { if (o.isSkinnedMesh) sk = o; });
  const g = sk.geometry.clone(); sk.geometry = g;
  const P = g.attributes.position, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight, I = g.index;
  const { f, size } = gltf.userData.parts || (gltf.userData.parts = components(g));
  /* the model's parts, by size: body (with the face), headphones, hair, glasses, eyes */
  const role = (r) => { const n = size.get(r); return n > 6000 ? "body" : n > 3000 ? "headset" : n > 1500 ? "hair" : n < 340 && n !== 257 ? "glasses" : "other"; };
  const crop = look.hair === "crop";
  const keep = [];
  for (let t = 0; t < I.count; t += 3) {
    const a = I.getX(t), b = I.getX(t + 1), c = I.getX(t + 2), r = role(f(a));
    if (r === "headset" || r === "glasses") continue; /* athletes race without headphones or glasses */
    if (crop && r === "hair") continue;
    keep.push(a, b, c);
  }
  g.setIndex(keep);
  slimLegs(sk);
  const mat = sk.material.clone();
  mat.map = kitTexture(sk.material.map.image, look.top, look.pants);
  mat.metalness = 0; mat.roughness = 0.62;
  sk.material = mat;
  sk.castShadow = !look.fan; sk.frustumCulled = false;

  if (crop) {
    /* her hair, pressed into a close crop of natural curls, like the BNC WIN picture */
    const hg = new THREE.BufferGeometry();
    const pos = [], nor = [], uv = [], si = [], sw = [], idx = [], map = new Map();
    const C = new THREE.Vector3(0, 1.462, -0.004), R = new THREE.Vector3(0.1, 0.12, 0.118), v = new THREE.Vector3();
    const add = (i) => {
      if (map.has(i)) return map.get(i);
      const k = pos.length / 3;
      v.fromBufferAttribute(P, i).sub(C).divide(R);
      v.multiplyScalar(1 / Math.max(v.length(), 1e-6));
      if (v.y < -0.35 && v.z > -0.2) v.y = -0.35; /* no strands down over the cheeks */
      const n = v.clone().divide(R).normalize();
      v.multiply(R).add(C);
      pos.push(v.x, v.y, v.z); nor.push(n.x, n.y, n.z);
      uv.push(Math.atan2(v.x - C.x, v.z - C.z) * 1.6, (v.y - C.y) * 16);
      for (let c = 0; c < 4; c++) { si.push(SI.getComponent(i, c)); sw.push(SW.getComponent(i, c)); }
      map.set(i, k); return k;
    };
    for (let t = 0; t < I.count; t += 3) {
      const a = I.getX(t), b = I.getX(t + 1), c = I.getX(t + 2);
      if (role(f(a)) === "hair") idx.push(add(a), add(b), add(c));
    }
    hg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    hg.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
    hg.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    hg.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4));
    hg.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw, 4));
    hg.setIndex(idx);
    const tex = curlTexture();
    const hair = new THREE.SkinnedMesh(hg, new THREE.MeshStandardMaterial({ map: tex, bumpMap: tex, bumpScale: 6, roughness: 0.85 }));
    sk.parent.add(hair); hair.position.copy(sk.position); hair.quaternion.copy(sk.quaternion); hair.scale.copy(sk.scale);
    hair.bind(sk.skeleton, sk.bindMatrix); hair.castShadow = !look.fan; hair.frustumCulled = false;
  }
  root.traverse((o) => { if (o.isMesh) { o.castShadow = !look.fan; o.frustumCulled = false; } });
  return root;
}
