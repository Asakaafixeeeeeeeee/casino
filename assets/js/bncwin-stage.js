/* BNC WIN's 3D broadcast (bncwin.html): a night stadium, two athletes and TV cameras, drawn with three.js.
   This file only draws. The race itself is the server's: bncwin.js publishes what to show in window.BNC_VIEW every
   frame (phase, who leads and by how much, how far the race has run, how it ended) and the athletes and cameras follow
   it. Nothing here can change a race or a payout. If WebGL isn't available the race still runs with the TV graphics.

   The athletes are one rigged character model (Mixamo character "Ch03", via the three.js examples) with a run, idle and
   walk taken from the Mixamo "Soldier" rig; assets/models/bnc-athlete.glb is both, pre-joined. Each runner gets her own
   kit colour, and the green runner (the player's) her own short natural curls, like the BNC WIN picture. */
import * as THREE from "../vendor/three/three.module.min.js";
import { GLTFLoader } from "../vendor/three/GLTFLoader.js";
import * as SU from "../vendor/three/SkeletonUtils.js";
import { mergeGeometries } from "../vendor/three/BufferGeometryUtils.js";

const stage = document.getElementById("bnStage");
const canvas = document.getElementById("bnCanvas");
const camLabel = document.getElementById("bnCam");
const FINISH = 210, GAP = 4.2, LANE = 1.22;
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
    uniforms: {},
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
  Object.assign(key.shadow.camera, { left: -12, right: 12, top: 8, bottom: -8, near: 1, far: 120 });
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

  /* the track: 8 lanes of red tartan with white lines, 40 m per tile */
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
  /* the infield (toward the main cameras) and the apron in front of the stand */
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
  /* kerb on the inside edge */
  const kerb = new THREE.Mesh(new THREE.BoxGeometry(500, 0.06, 0.12), new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.6 }));
  kerb.position.set(100, 0.03, TRACK_W / 2 + 0.06); scene.add(kerb);
  /* start line and the chequered finish line */
  const startLine = new THREE.Mesh(new THREE.PlaneGeometry(0.12, TRACK_W - 0.6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  startLine.rotation.x = -Math.PI / 2; startLine.position.set(0, 0.006, 0); scene.add(startLine);
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

  /* ---------------- the main stand, the crowd, the boards ---------------- */
  const ROWS = small ? 11 : 15, X0 = -60, X1 = 290;
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
  /* the roof with a light strip along its edge */
  const roofY = 1.4 + ROWS * 0.55 + 5.2;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(X1 - X0, 0.3, ROWS * 0.85 + 4), new THREE.MeshStandardMaterial({ color: 0x10141c, roughness: 0.8 }));
  roof.position.set((X0 + X1) / 2, roofY, -TRACK_W / 2 - 3.6 - ROWS * 0.85 / 2 - 1); roof.rotation.x = -0.08; scene.add(roof);
  const strip = new THREE.Mesh(new THREE.BoxGeometry(X1 - X0, 0.12, 0.12), new THREE.MeshBasicMaterial({ color: 0xfff2c6 }));
  strip.position.set((X0 + X1) / 2, roofY - 0.35, -TRACK_W / 2 - 2.6); scene.add(strip);

  /* the crowd: a few thousand fans, each its own colours, bouncing harder when the race gets close */
  const crowdU = { uTime: { value: 0 }, uExcite: { value: 0.3 } };
  {
    const torso = new THREE.CylinderGeometry(0.16, 0.2, 0.52, 7); torso.translate(0, 0.26, 0);
    const head = new THREE.SphereGeometry(0.105, 8, 6); head.translate(0, 0.64, 0);
    const armL = new THREE.CylinderGeometry(0.045, 0.05, 0.42, 5); armL.translate(-0.21, 0.3, 0);
    const armR = armL.clone(); armR.translate(0.42, 0, 0);
    [torso, head, armL, armR].forEach((g, i) => {
      const n = g.attributes.position.count, part = new Float32Array(n).fill(i);
      g.setAttribute("part", new THREE.BufferAttribute(part, 1));
      g.deleteAttribute("uv");
    });
    const fan = mergeGeometries([torso, head, armL, armR]);
    const shirts = [0xffd34d, 0x18b257, 0xe01f2d, 0xffffff, 0x2a6fdb, 0xff8c1a, 0x111111, 0x6ff0a4, 0xf2f2f2, 0x7b2cbf, 0x18b257, 0xffd34d];
    const skins = [0x5a3420, 0x7a4a2c, 0x3f2516, 0x8d5a36, 0xc68a5c];
    const step = small ? 0.78 : 0.62;
    const per = Math.floor((X1 - X0) / step);
    const total = per * ROWS;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: false });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, crowdU);
      sh.vertexShader = "uniform float uTime; uniform float uExcite; attribute float part; varying float vPart;\n" + sh.vertexShader.replace("#include <begin_vertex>",
        "#include <begin_vertex>\n vPart = part;\n" +
        " vec4 ip = instanceMatrix[3]; float ph = fract(sin(dot(ip.xz, vec2(12.9898,78.233))) * 43758.5453);\n" +
        " float fast = step(0.42, ph) * uExcite;\n" +
        " float j = max(0.0, sin(uTime * (5.5 + ph * 3.5) + ph * 40.0)); transformed.y += j * j * 0.16 * fast + sin(uTime * 1.4 + ph * 23.0) * 0.015;\n" +
        " if (part > 1.5) { float up = clamp(fast * 1.4 + step(0.9, ph) * 0.4, 0.0, 1.0) * (0.6 + 0.4 * j);\n" +
        "   float side = part < 2.5 ? -1.0 : 1.0; vec3 sh = vec3(side * 0.21, 0.5, 0.0);\n" +
        "   vec3 d = transformed - sh; float a = up * 2.7 * -side; transformed = sh + vec3(d.x * cos(a) - d.y * sin(a), d.x * sin(a) + d.y * cos(a), d.z); }");
      sh.fragmentShader = "varying float vPart;\n" + sh.fragmentShader;
    };
    const crowd = new THREE.InstancedMesh(fan, mat, total);
    const m4 = new THREE.Matrix4(), col = new THREE.Color(), q = new THREE.Quaternion(), s3 = new THREE.Vector3(1, 1, 1), p3 = new THREE.Vector3();
    let k = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let i = 0; i < per; i++) {
        if (rnd() < 0.1) continue; /* an empty seat */
        p3.set(X0 + i * step + rnd() * 0.2, 1.1 + r * 0.55 + 0.3, -TRACK_W / 2 - 3.55 - r * 0.85 + (rnd() - 0.5) * 0.1);
        const sc = 0.92 + rnd() * 0.18; s3.set(sc, sc, sc);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (rnd() - 0.5) * 0.6);
        m4.compose(p3, q, s3); crowd.setMatrixAt(k, m4);
        col.setHex(rnd() < 0.18 ? skins[(rnd() * skins.length) | 0] : shirts[(rnd() * shirts.length) | 0]);
        crowd.setColorAt(k, col);
        k++;
      }
    }
    crowd.count = k; crowd.frustumCulled = false;
    scene.add(crowd);
  }
  /* LED boards along the front of the stand, scrolling */
  const ledTex = canvasTex(2048, 128, (x, w, h) => {
    x.fillStyle = "#050505"; x.fillRect(0, 0, w, h);
    const items = [["WIN B", "#ffd34d"], ["BNC WIN RACING", "#6ff0a4"], ["VIRTUAL RACE", "#ffffff"], ["PLAY RESPONSIBLY · 18+", "#ff8a84"]];
    x.font = "900 70px Arial Black, Arial, sans-serif"; x.textBaseline = "middle";
    let px = 30; let i = 0;
    for (;;) { const [t, c] = items[i++ % items.length]; const tw = x.measureText(t).width; if (px + tw > w - 20) break; x.fillStyle = c; x.fillText(t, px, h / 2 + 4); px += tw + 90; x.fillStyle = "#333"; x.fillRect(px - 50, 30, 8, 68); }
    x.fillStyle = "rgba(0,0,0,.35)"; for (let y = 0; y < h; y += 4) x.fillRect(0, y, w, 1.5); /* the LED rows */
  }, [12, 1]);
  const boards = new THREE.Mesh(new THREE.BoxGeometry(X1 - X0, 0.95, 0.12), [null, null, null, null, new THREE.MeshBasicMaterial({ map: ledTex, toneMapped: false }), new THREE.MeshBasicMaterial({ color: 0x050505 })].map((m) => m || new THREE.MeshBasicMaterial({ color: 0x050505 })));
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
  const towers = [];
  for (const side of [-1, 1]) {
    for (const x of [-30, 40, 110, 180, 250]) {
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
      const mid = new THREE.Vector3(x, H / 2, z / 2);
      beam.position.copy(mid); beam.lookAt(x, H + 1.5, z); beam.rotateX(Math.PI / 2);
      scene.add(beam);
      towers.push({ glow, x });
    }
  }

  /* the camera rail along the infield, and the dolly that rides it */
  const rail = new THREE.Mesh(new THREE.BoxGeometry(400, 0.08, 0.3), new THREE.MeshStandardMaterial({ color: 0x555b66, metalness: 0.7, roughness: 0.4 }));
  rail.position.set(100, 0.05, TRACK_W / 2 + 1.6); scene.add(rail);
  const dolly = new THREE.Group();
  {
    const dark = new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.5, metalness: 0.4 });
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.3, 0.8), dark); base.position.y = 0.25; dolly.add(base);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.1, 8), dark); mast.position.y = 0.9; dolly.add(mast);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.32, 0.3), dark); body.position.set(0, 1.5, 0); dolly.add(body);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.42, 12), dark); lens.rotation.z = Math.PI / 2; lens.position.set(0.48, 1.5, 0); dolly.add(lens);
    const tally = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2020 })); tally.position.set(0.1, 1.7, 0.16); dolly.add(tally);
    dolly.position.set(0, 0, TRACK_W / 2 + 1.6); dolly.traverse((o) => { o.castShadow = true; });
  }
  scene.add(dolly);

  /* ---------------- the athletes ---------------- */
  const gltf = await new GLTFLoader().loadAsync("assets/models/bnc-athlete.glb?v=1");
  const clips = Object.fromEntries(gltf.animations.map((a) => [a.name, a]));
  const runners = { green: makeRunner("green", GREEN_Z), red: makeRunner("red", RED_Z) };
  function makeRunner(kind, z) {
    const root = buildAthlete(gltf, kind);
    root.rotation.y = Math.PI / 2; /* facing down the track */
    root.position.set(0, 0, z);
    scene.add(root);
    const mixer = new THREE.AnimationMixer(root);
    const actions = { run: mixer.clipAction(clips.run), idle: mixer.clipAction(clips.idle), walk: mixer.clipAction(clips.walk) };
    actions.idle.play();
    actions.idle.time = kind === "red" ? 0.7 : 0;
    return { kind, root, mixer, actions, now: "idle", x: 0, vel: 0, z, phase: 0 };
  }
  function setMove(r, name) {
    if (r.now === name) return;
    const from = r.actions[r.now], to = r.actions[name];
    to.reset().play(); to.crossFadeFrom(from, 0.35, false);
    r.now = name;
  }

  /* ---------------- the race on screen ---------------- */
  let raceKey = null, endedAt = 0, lastLead = 0, leadSign = 0, endKind = null;
  function updateRunners(v, dt, t) {
    const G = runners.green, R = runners.red;
    if (v.raceId !== raceKey) { /* a new race: both back on the line */
      raceKey = v.raceId;
      for (const r of [G, R]) { r.x = 0; r.vel = 0; }
      endKind = null;
      cutTo(v.phase === "countdown" ? "grid" : "wide", t);
    }
    if (v.phase === "running") {
      const base = v.prog * FINISH;
      const lead = v.lead;
      for (const [r, tx] of [[G, base + lead * GAP], [R, base - lead * GAP]]) {
        const before = r.x;
        r.x += (tx - r.x) * Math.min(1, dt * 2.6);
        const vel = (r.x - before) / Math.max(dt, 1e-3);
        r.vel += (vel - r.vel) * Math.min(1, dt * 5);
      }
      lastLead = lead;
    } else if (v.phase === "ended") {
      if (endKind !== v.ended) { endKind = v.ended; endedAt = t; onEnd(v.ended, t); }
      const since = t - endedAt;
      for (const r of [G, R]) {
        const sprint = v.ended === "BUSTED" && r === R && since < 2.6; /* red breaks away */
        if (sprint) r.vel += (9.5 - r.vel) * Math.min(1, dt * 3);
        else r.vel *= Math.exp(-dt * (r === G && v.ended === "BUSTED" ? 1.4 : 0.85));
        if (r.vel < 0.05) r.vel = 0;
        r.x += r.vel * dt;
      }
    } else { /* waiting on the line */
      for (const r of [G, R]) { r.vel = 0; if (v.phase !== "ended") r.x += (0 - r.x) * Math.min(1, dt * 4); }
    }
    for (const r of [G, R]) {
      const sp = Math.abs(r.vel);
      if (v.phase === "running" || sp > 2.6) { setMove(r, "run"); r.actions.run.timeScale = THREE.MathUtils.clamp(sp / 5.6, 0.75, 1.65); }
      else if (sp > 0.35) { setMove(r, "walk"); r.actions.walk.timeScale = THREE.MathUtils.clamp(sp / 1.5, 0.6, 1.4); }
      else setMove(r, "idle");
      r.root.position.x = r.x;
      r.mixer.update(dt);
      /* footsteps: two per run cycle */
      if (r.now === "run") {
        const ph = (r.actions.run.time / clips.run.duration) % 1, half = ph < 0.5 ? 0 : 1;
        if (half !== r.phase) { r.phase = half; if (window.BNCSound && window.BNCSound.step) window.BNCSound.step(r.kind, sp); }
      }
    }
    /* the crowd gets louder and bouncier when the race is close or near the end */
    const close = v.phase === "running" ? 1 - Math.min(1, Math.abs(v.lead) * 1.6) : 0;
    const target = v.phase === "running" ? 0.45 + 0.35 * close + (v.prog > 0.8 ? 0.4 : 0) : v.phase === "ended" ? (t - endedAt < 5 ? 1 : 0.3) : 0.25;
    crowdU.uExcite.value += (Math.min(1, target) - crowdU.uExcite.value) * Math.min(1, dt * 2);
    crowdU.uTime.value = t;
    if (window.BNCSound && window.BNCSound.crowd) window.BNCSound.crowd(crowdU.uExcite.value);
    const sign = v.phase === "running" ? (v.lead > 0.03 ? 1 : v.lead < -0.03 ? -1 : leadSign) : 0;
    if (sign !== leadSign && sign !== 0 && v.phase === "running" && t - shotAt > 2.2) cutTo("close", t);
    leadSign = sign;
  }
  function onEnd(kind, t) { cutTo(kind === "BUSTED" ? "closeRed" : "close", t); }

  /* ---------------- the TV cameras ---------------- */
  const SHOT_NAMES = { wide: "STADIUM", grid: "START LINE", side: "TRACKSIDE", front: "HEAD-ON", chase: "CHASE CAM", aerial: "SKY CAM", close: "CLOSE-UP", closeRed: "CLOSE-UP", finish: "FINISH LINE" };
  const RUN_ORDER = ["side", "front", "side", "chase", "aerial", "side", "close", "front"];
  let shot = "wide", shotAt = -99, order = 0, finishShown = false;
  const camPos = new THREE.Vector3(-20, 9, 24), camLook = new THREE.Vector3(10, 1, 0), wantPos = new THREE.Vector3(), wantLook = new THREE.Vector3();
  let fov = 40;
  function cutTo(name, t) {
    if (name === shot && t - shotAt < 1) return;
    shot = name; shotAt = t; snap = true;
    const n = Object.keys(SHOT_NAMES).indexOf(name) + 1;
    if (camLabel) camLabel.textContent = "CAM " + n + " · " + SHOT_NAMES[name];
    stage.classList.remove("cut"); void stage.offsetWidth; stage.classList.add("cut");
  }
  let snap = true;
  function frameShot(t, dt, v) {
    const G = runners.green, R = runners.red;
    const mid = (G.x + R.x) / 2, front = Math.max(G.x, R.x), backX = Math.min(G.x, R.x);
    const lead = G.x >= R.x ? G : R;
    const st = t - shotAt;
    let f = 32;
    switch (shot) {
      case "wide": wantPos.set(mid - 26 + Math.sin(t * 0.08) * 6, 10, 26); wantLook.set(mid + 12, 2, -6); f = 46; break;
      case "grid": wantPos.set(mid + 7 * Math.cos(0.9 + st * 0.12), 1.5, 6.5 * Math.sin(0.9 + st * 0.12) + 0.3); wantLook.set(mid, 1.05, 0); f = 34; break;
      case "side": wantPos.set(mid + 2.2, 1.75, 9.5); wantLook.set(mid + 1.2, 0.95, -0.3); f = 30; break;
      case "front": wantPos.set(front + 17, 1.3, 1.6); wantLook.set(mid, 1.0, 0); f = 19; break;
      case "chase": wantPos.set(backX - 6.5, 2.4, 3.6); wantLook.set(front + 5, 0.9, -0.5); f = 40; break;
      case "aerial": wantPos.set(mid - 12, 16, 19); wantLook.set(mid + 6, 0, -4); f = 40; break;
      case "close": wantPos.set(G.x + 2.8, 1.45, G.z + 2.9); wantLook.set(G.x - 0.1, 1.2, G.z); f = 30; break;
      case "closeRed": wantPos.set(R.x + 2.8, 1.45, R.z + 3.6); wantLook.set(R.x - 0.1, 1.2, R.z); f = 30; break;
      case "finish": wantPos.set(FINISH + 12, 1.35, 1.9); wantLook.set(mid, 1.0, 0); f = 22; break;
    }
    if (shot === "close" && v.phase === "running") { wantPos.set(lead.x + 2.8, 1.45, lead.z + 3.2); wantLook.set(lead.x - 0.1, 1.2, lead.z); }
    /* a little operator sway */
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
    /* the director: cut every few seconds while they run, the finish camera for the last stretch */
    if (v.phase === "running") {
      if (v.prog > 0.86 && !finishShown) { finishShown = true; cutTo("finish", t); }
      else if (st > (shot === "close" ? 3.8 : 5.6) && !(shot === "finish" && v.prog < 0.995)) { cutTo(RUN_ORDER[order++ % RUN_ORDER.length], t); }
    } else {
      finishShown = false;
      if (v.phase === "countdown" && shot !== "grid" && shot !== "close") cutTo("grid", t);
      else if (v.phase === "idle" && st > 8) cutTo(shot === "wide" ? "grid" : shot === "grid" ? "close" : "wide", t);
      else if (v.phase === "ended" && st > 7) cutTo(shot === "wide" ? "close" : "wide", t);
    }
    /* lights follow the action */
    key.position.set(mid + 18, 38, 26); key.target.position.set(mid, 0, 0);
    fill.position.set(mid - 20, 20, -30); fill.target.position.set(mid, 1, 0);
    rim.position.set(mid - 30, 14, 4); rim.target.position.set(mid, 1, 0);
    dolly.position.x = mid + 1.5;
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
  loop();
  stage.dataset.three = "ready";
  window.BNCStage = { ready: true, shot: () => shot };
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
/* the kit: the trousers and the top take the team colour */
function kitTexture(img, hue) {
  const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
  const x = c.getContext("2d"); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height), p = d.data;
  const sx = c.width / 512, sy = c.height / 512;
  for (let i = 0; i < p.length; i += 4) {
    const r = p[i] / 255, g = p[i + 1] / 255, b = p[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, s = mx - mn;
    let h = 0; if (s > 0.0001) { if (mx === r) h = ((g - b) / s) % 6; else if (mx === g) h = (b - r) / s + 2; else h = (r - g) / s + 4; h *= 60; if (h < 0) h += 360; }
    const yellow = s > 0.35 && h > 40 && h < 70;
    const px = ((i / 4) % c.width) / sx, py = ((i / 4 / c.width) | 0) / sy;
    const grey = s < 0.14 && l > 0.3 && l < 0.86 && px > 240 && px < 470 && py > 190 && py < 330; /* the top only */
    if (!yellow && !grey) continue;
    const k = yellow ? Math.min(1.25, l * 1.55) : l * 1.15;
    p[i] = Math.min(255, hue[0] * k); p[i + 1] = Math.min(255, hue[1] * k); p[i + 2] = Math.min(255, hue[2] * k);
  }
  x.putImageData(d, 0, 0);
  const t = new THREE.CanvasTexture(c); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; return t;
}
function curlTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const x = c.getContext("2d"); x.fillStyle = "#120a07"; x.fillRect(0, 0, 256, 256);
  let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 1400; i++) {
    const cx = rnd() * 256, cy = rnd() * 256, r = 2 + rnd() * 3.5;
    x.strokeStyle = "rgba(" + (40 + rnd() * 40 | 0) + "," + (26 + rnd() * 22 | 0) + "," + (18 + rnd() * 16 | 0) + "," + (0.55 + rnd() * 0.4) + ")";
    x.lineWidth = 1 + rnd() * 1.2; x.beginPath(); x.arc(cx, cy, r, rnd() * 6, rnd() * 6 + 4.5); x.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}
function buildAthlete(gltf, kind) {
  const root = SU.clone(gltf.scene);
  let sk; root.traverse((o) => { if (o.isSkinnedMesh) sk = o; });
  const g = sk.geometry.clone(); sk.geometry = g;
  const P = g.attributes.position, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight, I = g.index;
  const { f, size } = components(g);
  /* the model's parts, by size: body (with the face), headphones, hair, glasses, eyes */
  const role = (r) => { const n = size.get(r); return n > 6000 ? "body" : n > 3000 ? "headset" : n > 1500 ? "hair" : n < 340 && n !== 257 ? "glasses" : "other"; };
  const green = kind === "green";
  const keep = [];
  for (let t = 0; t < I.count; t += 3) {
    const a = I.getX(t), b = I.getX(t + 1), c = I.getX(t + 2), r = role(f(a));
    if (r === "headset") continue; /* athletes race without headphones */
    if (green && (r === "hair" || r === "glasses")) continue;
    keep.push(a, b, c);
  }
  g.setIndex(keep);
  const mat = sk.material.clone();
  mat.map = kitTexture(sk.material.map.image, green ? [34, 205, 104] : [226, 34, 44]);
  mat.metalness = 0; mat.roughness = 0.62;
  sk.material = mat;
  sk.castShadow = true; sk.frustumCulled = false;

  if (green) {
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
    hair.bind(sk.skeleton, sk.bindMatrix); hair.castShadow = true; hair.frustumCulled = false;
  }
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
  return root;
}
