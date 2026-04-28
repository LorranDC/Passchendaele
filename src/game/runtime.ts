import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CONFIG } from "./config";
import type { Bullet, Enemy, HudState, Particle, Weapon } from "./types";

type RuntimeOptions = {
  canvas: HTMLCanvasElement;
  onHud: (state: HudState) => void;
};

const BASE_HINT =
  "V - 1a pessoa | W/S mover | A/D girar | Mouse mirar | Clique atirar | TAB trocar arma | R reparar";
const DEFAULT_TANK_MODEL_FILE = "mark_v_tank_male_2.glb";
const LEGACY_TANK_MODEL_FILE = "player-tank.glb";

export class GameRuntime {
  private readonly canvas: HTMLCanvasElement;
  private readonly onHud: (state: HudState) => void;

  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private clock: THREE.Clock;

  private terrain!: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;

  private tank: THREE.Group;
  private cannonMesh: THREE.Group;
  private mgMesh: THREE.Group;
  private cannonBarrelObj: THREE.Group;
  private usingExternalTankModel = false;
  private externalCannonPivot: THREE.Object3D | null = null;
  private externalMgPivot: THREE.Object3D | null = null;
  private externalCannonBaseQuat = new THREE.Quaternion();
  private externalMgBaseQuat = new THREE.Quaternion();
  private readonly axisX = new THREE.Vector3(1, 0, 0);
  private readonly axisY = new THREE.Vector3(0, 1, 0);
  private cannonMuzzleMarker: THREE.Object3D | null = null;
  private mgMuzzleMarker: THREE.Object3D | null = null;
  private selectedTankModelFile = DEFAULT_TANK_MODEL_FILE;
  private readonly tankModelCacheVersion = "20260411";
  private playerTrackLinks: Array<{
    mesh: THREE.Mesh;
    t: number;
    side: number;
  }> = [];

  private running = false;
  private gameOver = false;

  private tankVel = 0;
  private prevTankYaw = 0;
  private camYaw = 0;

  private gunYaw = 0;
  private gunPitch = 0;
  private gunYawTarget = 0;
  private gunPitchTarget = 0;
  private recoilZ = 0;
  private recoilVel = 0;
  private screenShake = 0;

  private hp = 100;
  private score = 0;

  private weapon: Weapon = "cannon";
  private cannonAmmo = CONFIG.MAX_CANNON;
  private mgAmmo = CONFIG.MAX_MG;
  private lastShot = 0;

  private enemies: Enemy[] = [];
  private bullets: Bullet[] = [];
  private particles: Particle[] = [];

  private spawnTimer = 20;
  private fpMode = false;
  private repairT = 0;

  private aimScreenX = window.innerWidth / 2;
  private aimScreenY = window.innerHeight / 2;
  private readonly aimRaycaster = new THREE.Raycaster();

  private readonly keys: Record<string, boolean> = {};
  private rafId = 0;

  private audioCtx: AudioContext | null = null;
  private soundLoadPromise: Promise<void> | null = null;
  private soundBufs: Record<string, AudioBuffer> = {};
  private noiseBuffer: AudioBuffer | null = null;
  private engineNode: AudioBufferSourceNode | null = null;
  private engineGain: GainNode | null = null;
  private engineState: "off" | "starting" | "running" | "idle" = "off";
  private readonly bulletAxis = new THREE.Vector3(0, 1, 0);

  private readonly onMouseMoveBound = (e: MouseEvent) => this.onMouseMove(e);
  private readonly onMouseDownBound = () => this.onMouseDown();
  private readonly onMouseUpBound = () => this.onMouseUp();
  private readonly onKeyDownBound = (e: KeyboardEvent) => this.onKeyDown(e);
  private readonly onKeyUpBound = (e: KeyboardEvent) => this.onKeyUp(e);
  private readonly onResizeBound = () => this.onResize();

  constructor(options: RuntimeOptions) {
    this.canvas = options.canvas;
    this.onHud = options.onHud;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x444738);
    this.scene.fog = new THREE.FogExp2(0x444738, 0.0155);

    this.camera = new THREE.PerspectiveCamera(
      65,
      window.innerWidth / window.innerHeight,
      0.1,
      300,
    );

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;

    this.clock = new THREE.Clock();

    const ambient = new THREE.AmbientLight(0x4a4c3f, 0.5);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xd8b070, 1.75);
    sun.position.set(42, 56, 26);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -90;
    sun.shadow.camera.right = 90;
    sun.shadow.camera.top = 90;
    sun.shadow.camera.bottom = -90;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 260;
    sun.shadow.bias = -0.0007;
    this.scene.add(sun);

    const terrainGeo = new THREE.PlaneGeometry(150, 150, 80, 80);
    terrainGeo.rotateX(-Math.PI / 2);
    const pos = terrainGeo.attributes.position;
    const colors: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = this.terrainH(x, z);
      pos.setY(i, y);

      const mud = THREE.MathUtils.clamp((y + 0.8) * 0.65, 0, 1);
      colors.push(0.24 + mud * 0.14, 0.22 + mud * 0.2, 0.17 + mud * 0.1);
    }
    terrainGeo.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(colors, 3),
    );
    terrainGeo.computeVertexNormals();

    this.terrain = new THREE.Mesh(
      terrainGeo,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.95,
        metalness: 0.03,
      }),
    );
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);

    this.camera.position.set(0, 6, 22);
    this.camera.lookAt(0, 1.5, 10);

    this.tank = new THREE.Group();
    this.cannonMesh = new THREE.Group();
    this.mgMesh = new THREE.Group();
    this.cannonBarrelObj = new THREE.Group();

    this.tank.clear();
    this.playerTrackLinks = [];

    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x667256,
      roughness: 0.86,
      metalness: 0.08,
    });
    const deckMat = new THREE.MeshStandardMaterial({
      color: 0x575d48,
      roughness: 0.9,
      metalness: 0.06,
    });
    const trackMat = new THREE.MeshStandardMaterial({
      color: 0x2f332b,
      roughness: 0.8,
      metalness: 0.05,
    });
    const innerMat = new THREE.MeshStandardMaterial({
      color: 0x45493d,
      roughness: 0.84,
      metalness: 0.08,
    });
    const metalMat = new THREE.MeshStandardMaterial({
      color: 0x6c6556,
      roughness: 0.5,
      metalness: 0.5,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x23261f,
      roughness: 0.9,
      metalness: 0.02,
    });

    const add = (
      mesh: THREE.Mesh,
      x: number,
      y: number,
      z: number,
    ): THREE.Mesh => {
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.tank.add(mesh);
      return mesh;
    };

    const hullShape = new THREE.Shape();
    hullShape.moveTo(-3.32, -0.56);
    hullShape.lineTo(-3.05, 0.08);
    hullShape.lineTo(-2.45, 0.54);
    hullShape.lineTo(-1.1, 0.86);
    hullShape.lineTo(0.92, 0.95);
    hullShape.lineTo(2.35, 0.78);
    hullShape.lineTo(3.16, 0.28);
    hullShape.lineTo(3.42, -0.42);
    hullShape.lineTo(2.8, -0.58);
    hullShape.lineTo(-3.32, -0.56);

    const hullGeo = new THREE.ExtrudeGeometry(hullShape, {
      depth: 1.8,
      bevelEnabled: true,
      bevelSize: 0.05,
      bevelThickness: 0.05,
      bevelSegments: 1,
      steps: 1,
    });
    hullGeo.center();
    hullGeo.rotateY(Math.PI / 2);
    add(new THREE.Mesh(hullGeo, bodyMat), 0, 0.18, 0);

    add(
      new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.18, 2.35), deckMat),
      0,
      0.68,
      0.2,
    );
    add(
      new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.18, 1.15), deckMat),
      -0.62,
      0.7,
      1.95,
    );
    add(
      new THREE.Mesh(new THREE.BoxGeometry(1.12, 0.76, 1.02), innerMat),
      0,
      0.26,
      -1.5,
    );
    add(
      new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.82), metalMat),
      0,
      0.18,
      -2.0,
    );
    add(
      new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.26, 0.64), darkMat),
      -0.88,
      0.58,
      0.9,
    );

    for (const side of [-1, 1] as const) {
      const shellShape = new THREE.Shape();
      shellShape.moveTo(-3.3, -0.68);
      shellShape.lineTo(-3.02, 0.1);
      shellShape.lineTo(-2.18, 0.72);
      shellShape.lineTo(-0.3, 0.95);
      shellShape.lineTo(2.22, 0.84);
      shellShape.lineTo(3.08, 0.3);
      shellShape.lineTo(3.38, -0.44);
      shellShape.lineTo(2.86, -0.74);
      shellShape.lineTo(-3.3, -0.68);

      const shellGeo = new THREE.ExtrudeGeometry(shellShape, {
        depth: 0.16,
        bevelEnabled: true,
        bevelSize: 0.04,
        bevelThickness: 0.03,
        bevelSegments: 1,
        steps: 1,
      });
      shellGeo.center();
      shellGeo.rotateY(Math.PI / 2);
      add(new THREE.Mesh(shellGeo, trackMat), side * 1.6, 0.03, 0);

      add(
        new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.18, 6.2), innerMat),
        side * 1.42,
        -0.04,
        0,
      );

      const linkCount = 16;
      for (let i = 0; i < linkCount; i++) {
        const link = new THREE.Mesh(
          new THREE.BoxGeometry(0.42, 0.08, 0.2),
          metalMat,
        );
        add(link, side * 1.54, 0, 0);
        this.playerTrackLinks.push({ mesh: link, t: i / linkCount, side });
      }

      for (let z = -2.8; z <= 2.8; z += 1.0) {
        add(
          new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.86, 0.12), darkMat),
          side * 1.78,
          -0.1,
          z,
        );
      }
    }

    for (const link of this.playerTrackLinks) {
      this.applyTrackPose(link);
    }

    for (let i = 0; i < 6; i++) {
      const x = -1.05 + i * 0.42;
      add(
        new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.02, 0.045), metalMat),
        x,
        0.26,
        -3.15,
      );
      add(
        new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.02, 0.045), metalMat),
        x,
        0.26,
        3.15,
      );
    }

    this.cannonMesh = new THREE.Group();
    this.cannonMesh.position.set(0, 0.24, -1.42);
    const cHub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.18, 0.28, 10),
      metalMat,
    );
    cHub.rotation.y = Math.PI / 2;
    this.cannonMesh.add(cHub);

    this.cannonBarrelObj = new THREE.Group();
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.1, 2.72, 10),
      metalMat,
    );
    barrel.rotation.z = Math.PI / 2;
    barrel.position.x = 1.35;
    this.cannonBarrelObj.add(barrel);

    const barrelTip = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.075, 0.22, 8),
      darkMat,
    );
    barrelTip.rotation.z = Math.PI / 2;
    barrelTip.position.x = 2.72;
    this.cannonBarrelObj.add(barrelTip);

    this.cannonMesh.add(this.cannonBarrelObj);
    this.tank.add(this.cannonMesh);

    this.mgMesh = new THREE.Group();
    this.mgMesh.position.set(-1.72, 0.14, -0.18);
    const mgBarrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.05, 1.6, 7),
      metalMat,
    );
    mgBarrel.rotation.x = Math.PI / 2;
    mgBarrel.position.z = -0.66;
    this.mgMesh.add(mgBarrel);

    this.tank.add(this.mgMesh);

    this.tank.position.set(0, this.terrainH(0, 10) + 0.95, 10);
    this.scene.add(this.tank);
    this.camYaw = this.prevTankYaw = this.tank.rotation.y;

    window.addEventListener("mousemove", this.onMouseMoveBound);
    window.addEventListener("mousedown", this.onMouseDownBound);
    window.addEventListener("mouseup", this.onMouseUpBound);
    window.addEventListener("keydown", this.onKeyDownBound);
    window.addEventListener("keyup", this.onKeyUpBound);
    window.addEventListener("resize", this.onResizeBound);

    this.loop();
    this.pushHud();
    void this.tryLoadExternalTankModel();

    /*
    for (let i = 0; i < 6; i++) {
      add(
        new THREE.BoxGeometry(0.02, 0.025, 0.58),
        O,
        -2.05,
        -0.18 + i * 0.07,
        0.36,
      );
    }

    // WWI continuous track belt generated over a closed rhomboid path.
    const createTrackBelt = (side: number): void => {
      const x = side * 1.56;
      add(new THREE.BoxGeometry(0.5, 1.42, 7.28), I, x, 0.01, 0, true);
      add(
        new THREE.BoxGeometry(0.04, 0.06, 7.52),
        O,
        side * 1.88,
        0.84,
        0,
        true,
      );
      add(
        new THREE.BoxGeometry(0.04, 0.06, 7.52),
        O,
        side * 1.88,
        -0.72,
        0,
        true,
      );
      add(
        new THREE.BoxGeometry(0.04, 1.36, 0.24),
        O,
        side * 1.88,
        0.02,
        -3.56,
        true,
      );
      add(
        new THREE.BoxGeometry(0.04, 1.36, 0.24),
        O,
        side * 1.88,
        0.02,
        3.56,
        true,
      );
      add(new THREE.BoxGeometry(0.05, 1.42, 7.22), D, side * 1.86, 0.03, 0);

      const linkCount = 36;
      for (let i = 0; i < linkCount; i++) {
        const link = add(new THREE.BoxGeometry(0.48, 0.09, 0.22), I, x, 0, 0);
        this.playerTrackLinks.push({ mesh: link, t: i / linkCount, side });
      }

      for (let z = -3.0; z <= 3.0; z += 0.75) {
        add(new THREE.BoxGeometry(0.06, 0.96, 0.14), D, side * 1.76, -0.04, z);
      }
    };

    createTrackBelt(-1);
    createTrackBelt(1);

    for (const link of this.playerTrackLinks) {
      this.applyTrackPose(link);
    }

    // Rivet rows as subtle rectangular studs (avoid black-ball artifacts).
    for (let i = 0; i < 8; i++) {
      const x = -1.0 + i * 0.285;
      add(new THREE.BoxGeometry(0.055, 0.022, 0.055), R, x, 0.28, -3.5);
      add(new THREE.BoxGeometry(0.055, 0.022, 0.055), R, x, 0.28, 3.5);
      add(new THREE.BoxGeometry(0.045, 0.02, 0.045), R, x, 0.62, -0.76);
    }
    for (const tx of [-1.56, 1.56]) {
      for (let i = 0; i < 10; i++) {
        const z = -2.95 + i * 0.62;
        add(new THREE.BoxGeometry(0.045, 0.02, 0.045), R, tx * 1.46, 0.26, z);
        add(new THREE.BoxGeometry(0.045, 0.02, 0.045), R, tx * 1.46, -0.24, z);
      }
    }

    this.cannonMesh = new THREE.Group();
    this.cannonMesh.position.set(0, 0.16, -1.72);
    const cHub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.19, 0.19, 0.32, 10),
      I,
    );
    cHub.rotation.y = Math.PI / 2;
    this.cannonMesh.add(cHub);

    this.cannonBarrelObj = new THREE.Group();
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.085, 0.11, 2.8, 10),
      I,
    );
    barrel.rotation.z = Math.PI / 2;
    barrel.position.x = 1.4;
    this.cannonBarrelObj.add(barrel);

    const barrelTip = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.08, 0.24, 8),
      D,
    );
    barrelTip.rotation.z = Math.PI / 2;
    barrelTip.position.x = 2.78;
    this.cannonBarrelObj.add(barrelTip);

    for (let i = 0; i < 4; i++) {
      const ring = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.12, 0.04, 10),
        D,
      );
      ring.rotation.z = Math.PI / 2;
      ring.position.x = 0.52 + i * 0.5;
      this.cannonBarrelObj.add(ring);
    }

    this.cannonMesh.add(this.cannonBarrelObj);
    this.tank.add(this.cannonMesh);

    this.mgMesh = new THREE.Group();
    this.mgMesh.position.set(-1.72, 0.12, -0.2);
    const mgBarrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.055, 1.8, 7),
      I,
    );
    mgBarrel.rotation.x = Math.PI / 2;
    mgBarrel.position.z = -0.7;
    this.mgMesh.add(mgBarrel);

    for (let i = 0; i < 5; i++) {
      const mgRing = new THREE.Mesh(
        new THREE.CylinderGeometry(0.065, 0.065, 0.04, 8),
        D,
      );
      mgRing.rotation.x = Math.PI / 2;
      mgRing.position.z = -0.28 - i * 0.26;
      this.mgMesh.add(mgRing);
    }

    this.tank.add(this.mgMesh);

    this.tank.position.set(0, this.terrainH(0, 10) + 1, 10);
    this.scene.add(this.tank);
    this.camYaw = this.prevTankYaw = this.tank.rotation.y;
    */
  }

  private applyTrackPose(link: {
    mesh: THREE.Mesh;
    t: number;
    side: number;
  }): void {
    const x = link.side * 1.56;
    const zFront = -3.24;
    const zRear = 3.24;
    const zTopFront = -1.84;
    const zTopRear = 1.84;
    const yBottom = -0.66;
    const yTop = 0.9;

    const lBottom = zRear - zFront;
    const lFront = Math.hypot(zTopFront - zFront, yTop - yBottom);
    const lTop = zTopRear - zTopFront;
    const lRear = Math.hypot(zRear - zTopRear, yBottom - yTop);
    const total = lBottom + lFront + lTop + lRear;

    let d = ((link.t % 1) + 1) % 1;
    d *= total;

    let y = yBottom;
    let z = zRear;
    let rx = 0;

    if (d < lBottom) {
      const u = d / lBottom;
      z = zRear + (zFront - zRear) * u;
      y = yBottom;
      rx = 0;
    } else if (d < lBottom + lFront) {
      const u = (d - lBottom) / lFront;
      z = zFront + (zTopFront - zFront) * u;
      y = yBottom + (yTop - yBottom) * u;
      rx = 0.78;
    } else if (d < lBottom + lFront + lTop) {
      const u = (d - lBottom - lFront) / lTop;
      z = zTopFront + (zTopRear - zTopFront) * u;
      y = yTop;
      rx = 0;
    } else {
      const u = (d - lBottom - lFront - lTop) / lRear;
      z = zTopRear + (zRear - zTopRear) * u;
      y = yTop + (yBottom - yTop) * u;
      rx = -0.78;
    }

    link.mesh.position.set(x, y, z);
    link.mesh.rotation.set(rx, 0, 0);
  }

  private buildEnemy(x: number, z: number): void {
    const g = new THREE.Group();
    const B = new THREE.MeshStandardMaterial({
      color: 0x585040,
      roughness: 0.82,
      metalness: 0.2,
    });
    const D = new THREE.MeshStandardMaterial({
      color: 0x38342a,
      roughness: 0.88,
      metalness: 0.12,
    });
    const I = new THREE.MeshStandardMaterial({
      color: 0x242018,
      roughness: 0.5,
      metalness: 0.62,
    });

    const body = new THREE.Mesh(new THREE.BoxGeometry(3.1, 1.5, 5.2), B);
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    const top = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.72, 4.4), D);
    top.position.y = 1.1;
    top.castShadow = true;
    g.add(top);

    const sidePlateR = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.66, 5.5), D);
    sidePlateR.position.set(1.66, -0.5, 0);
    sidePlateR.castShadow = true;
    g.add(sidePlateR);

    const sidePlateL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.66, 5.5), D);
    sidePlateL.position.set(-1.66, -0.5, 0);
    sidePlateL.castShadow = true;
    g.add(sidePlateL);

    // A7V-style segmented track strips (less modern wheel look).
    for (const tx of [-1.66, 1.66]) {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.82, 5.65), D);
      frame.position.set(tx, -0.52, 0);
      frame.castShadow = true;
      g.add(frame);

      for (let zc = -2.45; zc <= 2.45; zc += 0.58) {
        const lowerLink = new THREE.Mesh(
          new THREE.BoxGeometry(0.5, 0.09, 0.23),
          I,
        );
        lowerLink.position.set(tx, -0.9, zc);
        g.add(lowerLink);

        const upperLink = new THREE.Mesh(
          new THREE.BoxGeometry(0.48, 0.08, 0.2),
          I,
        );
        upperLink.position.set(tx, -0.18, zc);
        g.add(upperLink);
      }

      for (let y = -0.8; y <= -0.26; y += 0.2) {
        const fCap = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.09, 0.2), I);
        fCap.position.set(tx, y, -2.68);
        fCap.rotation.x = 0.72;
        g.add(fCap);

        const rCap = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.09, 0.2), I);
        rCap.position.set(tx, y, 2.68);
        rCap.rotation.x = -0.72;
        g.add(rCap);
      }
    }

    for (let i = 0; i < 8; i++) {
      const zc = -2.3 + i * 0.64;
      const rivR = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.018, 0.05), D);
      rivR.position.set(1.88, 0.1, zc);
      g.add(rivR);
      const rivL = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.018, 0.05), D);
      rivL.position.set(-1.88, 0.1, zc);
      g.add(rivL);
    }

    const gun = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.12, 2.4, 8),
      I,
    );
    gun.rotation.x = Math.PI / 2;
    gun.position.set(0, 0.6, -2.9);
    g.add(gun);

    g.position.set(x, this.terrainH(x, z) + 0.85, z);
    g.rotation.y = Math.random() * Math.PI * 2;
    this.scene.add(g);

    this.enemies.push({
      mesh: g,
      hp: 3,
      shootT: 2 + Math.random() * 4,
      patrol: new THREE.Vector3(
        (Math.random() - 0.5) * 65,
        0,
        (Math.random() - 0.5) * 65,
      ),
    });
  }

  private getFireDir(): THREE.Vector3 {
    const totalYaw = this.tank.rotation.y + this.gunYaw;
    const cosp = Math.cos(this.gunPitch);
    const sinp = Math.sin(this.gunPitch);
    return new THREE.Vector3(
      -Math.sin(totalYaw) * cosp,
      sinp,
      -Math.cos(totalYaw) * cosp,
    ).normalize();
  }

  private getMuzzlePos(): THREE.Vector3 {
    if (this.weapon === "cannon" && this.cannonMuzzleMarker) {
      return this.cannonMuzzleMarker.getWorldPosition(new THREE.Vector3());
    }
    if (this.weapon === "mg" && this.mgMuzzleMarker) {
      return this.mgMuzzleMarker.getWorldPosition(new THREE.Vector3());
    }

    if (this.usingExternalTankModel) {
      const dir = this.getFireDir();
      const side = this.weapon === "cannon" ? 0 : -0.9;
      const base = this.tank.position
        .clone()
        .add(
          new THREE.Vector3(side, 0.28, -1.35).applyEuler(this.tank.rotation),
        );
      return base.addScaledVector(dir, this.weapon === "cannon" ? 1.25 : 0.9);
    }

    if (this.weapon === "cannon") {
      return this.cannonBarrelObj.localToWorld(new THREE.Vector3(2.9, 0, 0));
    }
    return this.mgMesh.localToWorld(new THREE.Vector3(0, 0, -1.6));
  }

  private findModelObject(
    root: THREE.Object3D,
    terms: string[],
  ): THREE.Object3D | null {
    const wanted = terms.map((term) =>
      term.toLowerCase().replace(/[^a-z0-9]/g, ""),
    );
    let firstMatch: THREE.Object3D | null = null;

    root.traverse((obj) => {
      if (firstMatch) return;
      const normalized = obj.name.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (wanted.every((term) => normalized.includes(term))) {
        firstMatch = obj;
      }
    });

    return firstMatch;
  }

  private getTankModelUrl(fileName: string): string {
    return `/models/${encodeURIComponent(fileName)}?v=${this.tankModelCacheVersion}`;
  }

  public setTankModelFile(fileName: string): void {
    const next = fileName.trim();
    if (this.running) return;
    if (!next || next === this.selectedTankModelFile) return;
    this.selectedTankModelFile = next;
    void this.tryLoadExternalTankModel();
  }

  public getTankModelFile(): string {
    return this.selectedTankModelFile;
  }

  private async tryLoadExternalTankModel(): Promise<void> {
    const loader = new GLTFLoader();
    const filesToTry = Array.from(
      new Set([
        this.selectedTankModelFile,
        DEFAULT_TANK_MODEL_FILE,
        LEGACY_TANK_MODEL_FILE,
      ]),
    );

    await new Promise<void>((resolve) => {
      const tryIndex = (index: number): void => {
        if (index >= filesToTry.length) {
          // No external model found: keep procedural fallback.
          this.usingExternalTankModel = false;
          this.cannonMesh.visible = true;
          this.mgMesh.visible = true;
          this.externalCannonPivot = null;
          this.externalMgPivot = null;
          this.cannonMuzzleMarker = null;
          this.mgMuzzleMarker = null;
          resolve();
          return;
        }

        const currentFile = filesToTry[index];
        loader.load(
          this.getTankModelUrl(currentFile),
          (gltf) => {
            const model = gltf.scene;

            model.traverse((obj) => {
              if (obj instanceof THREE.Mesh) {
                obj.castShadow = true;
                obj.receiveShadow = true;
              }
            });

            // Auto-fix common Blender export orientation issues.
            // 1) If model is "standing" on a wrong axis, lay it flat.
            // 2) If model length is along X, rotate to face forward/back on Z.
            const preBox = new THREE.Box3().setFromObject(model);
            const preSize = preBox.getSize(new THREE.Vector3());
            if (preSize.y > preSize.x && preSize.y > preSize.z) {
              model.rotation.z = -Math.PI / 2;
            }

            const orientBox = new THREE.Box3().setFromObject(model);
            const orientSize = orientBox.getSize(new THREE.Vector3());
            if (orientSize.x > orientSize.z) {
              model.rotation.y += Math.PI / 2;
            }

            // Normalize model dimensions to fit existing gameplay scale.
            const box = new THREE.Box3().setFromObject(model);
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            if (maxDim > 0.0001) {
              const scale = 6.8 / maxDim;
              model.scale.setScalar(scale);
            }

            const centered = new THREE.Box3().setFromObject(model);
            const center = centered.getCenter(new THREE.Vector3());
            model.position.sub(center);

            const afterCenter = new THREE.Box3().setFromObject(model);
            model.position.y += -1.02 - afterCenter.min.y;

            // Keep gameplay gun pivots, but replace hull geometry.
            const keep = new Set<THREE.Object3D>([
              this.cannonMesh,
              this.mgMesh,
            ]);
            for (const child of [...this.tank.children]) {
              if (!keep.has(child)) {
                this.tank.remove(child);
              }
            }

            this.tank.add(model);
            this.playerTrackLinks = [];
            this.usingExternalTankModel = true;

            // Hide procedural guns when a full authored model is present.
            this.cannonMesh.visible = false;
            this.mgMesh.visible = false;

            this.cannonMuzzleMarker =
              this.findModelObject(model, ["muzzle", "cannon"]) ||
              this.findModelObject(model, ["muzzlecannon"]) ||
              null;
            this.mgMuzzleMarker =
              this.findModelObject(model, ["muzzle", "mg"]) ||
              this.findModelObject(model, ["muzzlemg"]) ||
              null;

            this.externalCannonPivot =
              this.findModelObject(model, ["cannon", "pivot"]) ||
              this.findModelObject(model, ["gun", "pivot"]) ||
              this.findModelObject(model, ["main", "cannon"]) ||
              (this.cannonMuzzleMarker?.parent ?? null);

            this.externalMgPivot =
              this.findModelObject(model, ["mg", "pivot"]) ||
              this.findModelObject(model, ["machine", "gun", "pivot"]) ||
              (this.mgMuzzleMarker?.parent ?? null);

            if (this.externalCannonPivot) {
              this.externalCannonBaseQuat.copy(
                this.externalCannonPivot.quaternion,
              );
            }
            if (this.externalMgPivot) {
              this.externalMgBaseQuat.copy(this.externalMgPivot.quaternion);
            }

            this.selectedTankModelFile = currentFile;

            resolve();
          },
          undefined,
          () => {
            tryIndex(index + 1);
          },
        );
      };

      tryIndex(0);
    });
  }

  private shoot(): void {
    const now = this.clock.getElapsedTime();
    const reload =
      this.weapon === "cannon" ? CONFIG.RELOAD_CANNON : CONFIG.RELOAD_MG;
    if (now - this.lastShot < reload) return;
    if (this.weapon === "cannon" && this.cannonAmmo <= 0) return;
    if (this.weapon === "mg" && this.mgAmmo <= 0) return;

    this.lastShot = now;
    const dir = this.getFireDir();
    const pos = this.getMuzzlePos();

    const blt =
      this.weapon === "cannon"
        ? new THREE.Mesh(
            new THREE.SphereGeometry(0.2, 10, 10),
            new THREE.MeshStandardMaterial({
              color: 0xeea24a,
              emissive: 0x8a4512,
              emissiveIntensity: 0.95,
              roughness: 0.35,
              metalness: 0.2,
            }),
          )
        : new THREE.Mesh(
            new THREE.CylinderGeometry(0.03, 0.04, 0.34, 8),
            new THREE.MeshStandardMaterial({
              color: 0xffcf85,
              emissive: 0x8f5f20,
              emissiveIntensity: 0.9,
              roughness: 0.25,
              metalness: 0.12,
            }),
          );
    blt.position.copy(pos);
    blt.castShadow = false;
    blt.receiveShadow = false;
    blt.quaternion.setFromUnitVectors(this.bulletAxis, dir);
    this.scene.add(blt);

    const speed =
      this.weapon === "cannon"
        ? CONFIG.BULLET_SPEED_CANNON
        : CONFIG.BULLET_SPEED_MG;
    this.bullets.push({
      mesh: blt,
      vel: dir.multiplyScalar(speed),
      type: this.weapon,
      life: this.weapon === "cannon" ? 4.5 : 2,
    });

    if (this.weapon === "cannon") {
      this.cannonAmmo--;
      this.recoilZ = -0.55;
      this.recoilVel = -0.02;
      this.screenShake = 0.18;
    } else {
      this.mgAmmo--;
    }

    this.spawnMuzzleFlash(pos, this.weapon === "cannon");
    if (this.weapon === "cannon") {
      if (!this.playAny(["cannon_fire", "cannon", "gun_fire"], 0.95)) {
        this.playSynthShot("cannon");
      }
    } else {
      if (!this.playAny(["mg_fire", "mg", "machinegun"], 0.72)) {
        this.playSynthShot("mg");
      }
    }
    this.pushHud();
  }

  private spawnMuzzleFlash(pos: THREE.Vector3, big: boolean): void {
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(big ? 0.5 : 0.22, 6, 6),
      new THREE.MeshBasicMaterial({
        color: 0xffe050,
        transparent: true,
        opacity: 0.95,
      }),
    );
    flash.position.copy(pos);
    this.scene.add(flash);
    this.particles.push({
      mesh: flash,
      vel: new THREE.Vector3(0, 0, 0),
      life: 0.09,
      max: 0.09,
    });
  }

  private spawnExplosion(pos: THREE.Vector3, strength: number): void {
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.25 + strength * 0.75, 8, 8),
      new THREE.MeshBasicMaterial({
        color: 0xffc96d,
        transparent: true,
        opacity: 0.9,
      }),
    );
    flash.position.copy(pos);
    this.scene.add(flash);
    this.particles.push({
      mesh: flash,
      vel: new THREE.Vector3(0, 0, 0),
      life: 0.12 + strength * 0.08,
      max: 0.12 + strength * 0.08,
    });

    const sparkCount = Math.floor(14 + strength * 16);
    for (let i = 0; i < sparkCount; i++) {
      const spark = new THREE.Mesh(
        new THREE.SphereGeometry(0.04 + Math.random() * 0.06, 4, 4),
        new THREE.MeshBasicMaterial({
          color: Math.random() > 0.5 ? 0xff9f2f : 0xffdf8c,
          transparent: true,
          opacity: 0.95,
        }),
      );
      spark.position.copy(pos);
      this.scene.add(spark);

      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * 2,
        Math.random() * 1.4 + 0.2,
        (Math.random() - 0.5) * 2,
      )
        .normalize()
        .multiplyScalar((8 + Math.random() * 16) * strength);

      const life = 0.24 + Math.random() * 0.36;
      this.particles.push({
        mesh: spark,
        vel,
        life,
        max: life,
      });
    }

    const smokeCount = Math.floor(8 + strength * 10);
    for (let i = 0; i < smokeCount; i++) {
      const smoke = new THREE.Mesh(
        new THREE.SphereGeometry(0.14 + Math.random() * 0.2, 6, 6),
        new THREE.MeshBasicMaterial({
          color: 0x3d3d3d,
          transparent: true,
          opacity: 0.62,
        }),
      );
      smoke.position
        .copy(pos)
        .add(
          new THREE.Vector3(
            (Math.random() - 0.5) * 0.8,
            Math.random() * 0.25,
            (Math.random() - 0.5) * 0.8,
          ),
        );
      this.scene.add(smoke);
      const life = 0.8 + Math.random() * 1.15;
      this.particles.push({
        mesh: smoke,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 0.7,
          0.65 + Math.random() * 0.8,
          (Math.random() - 0.5) * 0.7,
        ),
        life,
        max: life,
        smoke: true,
      });
    }

    this.screenShake = Math.max(this.screenShake, 0.12 + strength * 0.2);
  }

  private enemyShoot(e: Enemy): void {
    const dir = new THREE.Vector3()
      .subVectors(this.tank.position, e.mesh.position)
      .normalize();
    dir.x += (Math.random() - 0.5) * 0.1;
    dir.z += (Math.random() - 0.5) * 0.1;
    dir.normalize();

    const blt = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.06, 0.32, 8),
      new THREE.MeshStandardMaterial({
        color: 0xff5a3a,
        emissive: 0x7f180e,
        emissiveIntensity: 0.8,
        roughness: 0.35,
        metalness: 0.1,
      }),
    );
    blt.position.copy(e.mesh.position).add(new THREE.Vector3(0, 1, 0));
    blt.castShadow = false;
    blt.receiveShadow = false;
    blt.quaternion.setFromUnitVectors(this.bulletAxis, dir);
    this.scene.add(blt);

    this.bullets.push({
      mesh: blt,
      vel: dir.multiplyScalar(CONFIG.BULLET_SPEED_ENEMY),
      type: "enemy",
      life: 2.8,
    });

    if (!this.playAny(["enemy_fire", "enemy_shot"], 0.55)) {
      this.playSynthShot("enemy");
    }
  }

  private updateEnemies(dt: number): void {
    this.enemies.forEach((e) => {
      const toP = new THREE.Vector3().subVectors(
        this.tank.position,
        e.mesh.position,
      );
      const dist = toP.length();

      e.mesh.lookAt(
        this.tank.position.x,
        e.mesh.position.y,
        this.tank.position.z,
      );

      if (dist > 10 && dist < 65) {
        e.mesh.position.addScaledVector(toP.normalize(), 3.2 * dt);
      } else if (dist >= 65) {
        const tp = new THREE.Vector3().subVectors(e.patrol, e.mesh.position);
        if (tp.length() < 3) {
          e.patrol.set(
            (Math.random() - 0.5) * 65,
            0,
            (Math.random() - 0.5) * 65,
          );
        }
        e.mesh.position.addScaledVector(tp.normalize(), 1.6 * dt);
      }

      e.mesh.position.y =
        this.terrainH(e.mesh.position.x, e.mesh.position.z) + 0.85;
      e.mesh.position.x = THREE.MathUtils.clamp(e.mesh.position.x, -60, 60);
      e.mesh.position.z = THREE.MathUtils.clamp(e.mesh.position.z, -60, 60);

      e.shootT -= dt;
      if (e.shootT <= 0 && dist < 52) {
        e.shootT = 3 + Math.random() * 4;
        this.enemyShoot(e);
      }
    });

    this.enemies = this.enemies.filter((e) => e.hp > 0);
  }

  private updateBullets(dt: number): void {
    const dead: number[] = [];

    this.bullets.forEach((b, i) => {
      const gravity =
        b.type === "cannon" ? 1.1 : b.type === "mg" ? 0.58 : 0.78;
      const drag = b.type === "cannon" ? 0.05 : b.type === "mg" ? 0.12 : 0.08;
      b.vel.multiplyScalar(Math.exp(-drag * dt));
      b.vel.y -= 9.8 * dt * gravity;
      b.mesh.position.addScaledVector(b.vel, dt);
      if (b.vel.lengthSq() > 0.001) {
        b.mesh.quaternion.setFromUnitVectors(
          this.bulletAxis,
          b.vel.clone().normalize(),
        );
      }
      b.life -= dt;

      const ty = this.terrainH(b.mesh.position.x, b.mesh.position.z);
      if (b.mesh.position.y <= ty + 0.05) {
        if (b.type === "cannon") {
          this.spawnExplosion(b.mesh.position.clone(), 0.72);
          if (!this.playAny(["explosion", "boom"], 0.78)) {
            this.playSynthExplosion(0.72);
          }
        } else {
          this.spawnMuzzleFlash(b.mesh.position.clone(), false);
          if (!this.playAny(["impact", "ricochet"], 0.48)) {
            this.playSynthImpact();
          }
        }
        this.scene.remove(b.mesh);
        dead.push(i);
        return;
      }

      if (
        b.life <= 0 ||
        Math.abs(b.mesh.position.x) > 85 ||
        Math.abs(b.mesh.position.z) > 85
      ) {
        this.scene.remove(b.mesh);
        dead.push(i);
        return;
      }

      if (b.type !== "enemy") {
        for (const e of this.enemies) {
          if (
            b.mesh.position.distanceTo(e.mesh.position) <
            (b.type === "cannon" ? 3.5 : 1.5)
          ) {
            e.hp -= b.type === "cannon" ? 1 : 0.25;
            this.scene.remove(b.mesh);
            dead.push(i);
            this.spawnExplosion(
              b.mesh.position.clone(),
              b.type === "cannon" ? 0.92 : 0.45,
            );
            if (e.hp <= 0) {
              this.scene.remove(e.mesh);
              this.score += 1;
              if (!this.playAny(["explosion", "boom"], 0.95)) {
                this.playSynthExplosion(1);
              }
            } else if (!this.playAny(["hit", "armor_hit"], 0.55)) {
              this.playSynthImpact();
            }
            break;
          }
        }
      } else if (b.mesh.position.distanceTo(this.tank.position) < 3.5) {
        this.hp = Math.max(0, this.hp - 2);
        this.scene.remove(b.mesh);
        dead.push(i);
        this.spawnExplosion(b.mesh.position.clone(), 0.38);
        this.screenShake = 0.15;
        if (!this.playAny(["hit", "armor_hit"], 0.85)) {
          this.playSynthImpact();
        }
        if (this.hp <= 0) {
          this.spawnExplosion(this.tank.position.clone(), 1.15);
          if (!this.playAny(["explosion", "boom"], 1)) {
            this.playSynthExplosion(1.15);
          }
          this.endGame();
        }
      }
    });

    for (let i = dead.length - 1; i >= 0; i--) {
      this.bullets.splice(dead[i], 1);
    }
  }

  private updateParticles(dt: number): void {
    const dead: number[] = [];
    this.particles.forEach((p, i) => {
      p.life -= dt;
      if (p.smoke) {
        p.vel.y += dt * 0.45;
        p.vel.multiplyScalar(Math.exp(-0.95 * dt));
      } else {
        p.vel.y -= dt * 4.5;
        p.vel.multiplyScalar(Math.exp(-2.1 * dt));
      }
      p.mesh.position.addScaledVector(p.vel, dt);

      const mat = p.mesh.material;
      const t = 1 - Math.max(0, p.life) / p.max;
      if (mat instanceof THREE.MeshBasicMaterial) {
        mat.opacity = p.smoke
          ? Math.max(0, (1 - t) * 0.55)
          : Math.max(0, p.life / p.max);
      }
      p.mesh.scale.setScalar(p.smoke ? 1 + t * 1.9 : 1 + t * 0.45);
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        dead.push(i);
      }
    });

    for (let i = dead.length - 1; i >= 0; i--) {
      this.particles.splice(dead[i], 1);
    }
  }

  private updatePlayerTrackAnimation(dt: number): void {
    if (this.playerTrackLinks.length === 0) return;

    const speed = this.tankVel;
    if (Math.abs(speed) < 0.01) return;

    const deltaT = (speed * dt * 0.16) / 15.5;
    for (const link of this.playerTrackLinks) {
      link.t += deltaT;
      if (link.t > 1) link.t -= 1;
      if (link.t < 0) link.t += 1;
      this.applyTrackPose(link);
    }
  }

  private updatePlayer(dt: number): void {
    const wantFwd =
      this.keys.KeyW || this.keys.ArrowUp
        ? 1
        : this.keys.KeyS || this.keys.ArrowDown
          ? -1
          : 0;
    const targetV =
      wantFwd > 0
        ? CONFIG.TANK_FWD_MAX
        : wantFwd < 0
          ? -CONFIG.TANK_REV_MAX
          : 0;

    if (wantFwd !== 0) {
      this.tankVel +=
        Math.sign(targetV - this.tankVel) * CONFIG.TANK_ACCEL * dt;
      if (Math.abs(this.tankVel) > Math.abs(targetV)) this.tankVel = targetV;
    } else {
      const d = CONFIG.TANK_DECEL * dt;
      this.tankVel =
        Math.abs(this.tankVel) < d
          ? 0
          : this.tankVel - Math.sign(this.tankVel) * d;
    }

    const turnMod = 1 - (Math.abs(this.tankVel) / CONFIG.TANK_FWD_MAX) * 0.45;
    if (this.keys.KeyA || this.keys.ArrowLeft)
      this.tank.rotation.y += CONFIG.TANK_TURN * turnMod * dt;
    if (this.keys.KeyD || this.keys.ArrowRight)
      this.tank.rotation.y -= CONFIG.TANK_TURN * turnMod * dt;

    if (this.fpMode) this.compensateGunForTurnDelta();

    const fwd = new THREE.Vector3(0, 0, -1).applyEuler(this.tank.rotation);
    this.tank.position.addScaledVector(fwd, this.tankVel * dt);
    this.tank.position.x = THREE.MathUtils.clamp(this.tank.position.x, -60, 60);
    this.tank.position.z = THREE.MathUtils.clamp(this.tank.position.z, -60, 60);
    this.tank.position.y =
      this.terrainH(this.tank.position.x, this.tank.position.z) + 1;

    this.updatePlayerTrackAnimation(dt);

    if (this.keys.Mouse0 && this.weapon === "mg") this.shoot();
    this.updateEngine(Math.abs(this.tankVel) > 0.5);

    if (this.keys.KeyR && this.hp < 100) {
      this.repairT += dt;
      if (this.repairT >= 5) {
        this.hp = Math.min(100, this.hp + 20);
        this.repairT = 0;
      }
    } else {
      this.repairT = 0;
    }

    if (this.fpMode) {
      const fireDir = this.getFireDir();
      const muzzle = this.getMuzzlePos();
      const camPos = muzzle
        .clone()
        .addScaledVector(fireDir, -0.9)
        .add(new THREE.Vector3(0, 0.18, 0));
      this.camera.position.copy(camPos);
      this.camera.lookAt(camPos.clone().addScaledVector(fireDir, 100));
      this.applyShake(dt, 0.04, 3);
    } else {
      this.applyShake(dt, 0.06, 2.5);
      let yd = this.tank.rotation.y - this.camYaw;
      while (yd > Math.PI) yd -= Math.PI * 2;
      while (yd < -Math.PI) yd += Math.PI * 2;
      this.camYaw += yd * Math.min(1, dt * 5);
      const offset = new THREE.Vector3(0, 5, 12).applyEuler(
        new THREE.Euler(0, this.camYaw, 0),
      );
      this.camera.position.lerp(this.tank.position.clone().add(offset), 0.1);
      const lookTarget = this.tank.position
        .clone()
        .add(new THREE.Vector3(0, 1.5, 0))
        .add(
          new THREE.Vector3(0, 0, -6).applyEuler(
            new THREE.Euler(0, this.camYaw, 0),
          ),
        );
      this.camera.lookAt(lookTarget);
    }

    this.syncGunToCrosshair3P();
    this.updateGunVisuals(dt);
  }

  private compensateGunForTurnDelta(): void {
    const delta = this.tank.rotation.y - this.prevTankYaw;
    this.gunYawTarget -= delta;
    this.gunYawTarget = THREE.MathUtils.clamp(
      this.gunYawTarget,
      -CONFIG.GUN_YAW_MAX,
      CONFIG.GUN_YAW_MAX,
    );
    this.prevTankYaw = this.tank.rotation.y;
  }

  private getCrosshairTargetPoint(): THREE.Vector3 {
    const ndc = new THREE.Vector2(
      (this.aimScreenX / window.innerWidth) * 2 - 1,
      -(this.aimScreenY / window.innerHeight) * 2 + 1,
    );
    this.aimRaycaster.setFromCamera(ndc, this.camera);

    const pickables: THREE.Object3D[] = [
      this.terrain,
      ...this.enemies.map((e) => e.mesh),
    ];
    const hits = this.aimRaycaster.intersectObjects(pickables, true);
    if (hits.length > 0) return hits[0].point.clone();

    return this.aimRaycaster.ray.origin
      .clone()
      .addScaledVector(this.aimRaycaster.ray.direction, 220);
  }

  private syncGunToCrosshair3P(): void {
    if (!this.running || this.fpMode) return;

    const target = this.getCrosshairTargetPoint();
    const origin = this.getMuzzlePos();
    const toTarget = target.sub(origin);
    const horiz = Math.hypot(toTarget.x, toTarget.z);
    if (horiz < 1e-4) return;

    const desiredTotalYaw = Math.atan2(-toTarget.x, -toTarget.z);
    const desiredGunYaw = this.normalizeAngle(
      desiredTotalYaw - this.tank.rotation.y,
    );
    const desiredPitch = Math.atan2(toTarget.y, horiz);

    this.gunYawTarget = THREE.MathUtils.clamp(
      desiredGunYaw,
      -CONFIG.GUN_YAW_MAX,
      CONFIG.GUN_YAW_MAX,
    );
    this.gunPitchTarget = THREE.MathUtils.clamp(
      desiredPitch,
      CONFIG.GUN_PITCH_MIN,
      CONFIG.GUN_PITCH_MAX,
    );
  }

  private updateGunVisuals(dt: number): void {
    const aimBlend = 1 - Math.exp(-dt * 18);
    const yawDelta = this.normalizeAngle(this.gunYawTarget - this.gunYaw);
    this.gunYaw += yawDelta * aimBlend;
    this.gunPitch += (this.gunPitchTarget - this.gunPitch) * aimBlend;

    this.cannonMesh.rotation.y = this.gunYaw;
    this.cannonMesh.rotation.x = this.gunPitch;
    this.mgMesh.rotation.y = this.gunYaw;
    this.mgMesh.rotation.x = this.gunPitch;

    if (this.usingExternalTankModel) {
      const yawQ = new THREE.Quaternion().setFromAxisAngle(
        this.axisY,
        this.gunYaw,
      );
      const pitchQ = new THREE.Quaternion().setFromAxisAngle(
        this.axisX,
        this.gunPitch,
      );

      if (this.externalCannonPivot) {
        this.externalCannonPivot.quaternion
          .copy(this.externalCannonBaseQuat)
          .multiply(yawQ)
          .multiply(pitchQ);
      }

      if (this.externalMgPivot) {
        this.externalMgPivot.quaternion
          .copy(this.externalMgBaseQuat)
          .multiply(yawQ)
          .multiply(pitchQ);
      }
    }

    this.recoilVel += -this.recoilZ * 40 * (1 / 60);
    this.recoilVel *= 0.7;
    this.recoilZ += this.recoilVel * (1 / 60);
    this.recoilZ = THREE.MathUtils.clamp(this.recoilZ, -0.6, 0);
    this.cannonBarrelObj.position.x = this.recoilZ;
  }

  private applyShake(dt: number, strength: number, decay: number): void {
    if (this.screenShake > 0) {
      this.screenShake -= dt * decay;
      const s = this.screenShake * strength;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
    }
  }

  public startGame(): void {
    this.running = true;
    this.gameOver = false;
    void this.ensureAudioLoaded();
    this.requestPointerLock();
    this.pushHud();
  }

  public restartGame(): void {
    this.running = false;
    this.gameOver = false;
    this.hp = 100;
    this.score = 0;
    this.weapon = "cannon";
    this.cannonAmmo = CONFIG.MAX_CANNON;
    this.mgAmmo = CONFIG.MAX_MG;
    this.repairT = 0;
    this.bullets.forEach((b) => this.scene.remove(b.mesh));
    this.particles.forEach((p) => this.scene.remove(p.mesh));
    this.enemies.forEach((e) => this.scene.remove(e.mesh));
    this.bullets = [];
    this.particles = [];
    this.enemies = [];
    this.spawnTimer = 4;
    this.tank.position.set(0, this.terrainH(0, 10) + 1, 10);
    this.tank.rotation.set(0, 0, 0);
    this.camYaw = this.prevTankYaw = this.tank.rotation.y;
    this.setXhairCenter();
    this.startGame();
  }

  public setWeapon(next: Weapon): void {
    this.weapon = next;
    this.pushHud();
  }

  public swapWeapon(): void {
    this.weapon = this.weapon === "cannon" ? "mg" : "cannon";
    this.pushHud();
  }

  public toggleFP(): void {
    this.fpMode = !this.fpMode;
    if (this.fpMode) {
      this.setXhairCenter();
    }
    this.pushHud();
  }

  public dispose(): void {
    this.running = false;
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }

    window.removeEventListener("mousemove", this.onMouseMoveBound);
    window.removeEventListener("mousedown", this.onMouseDownBound);
    window.removeEventListener("mouseup", this.onMouseUpBound);
    window.removeEventListener("keydown", this.onKeyDownBound);
    window.removeEventListener("keyup", this.onKeyUpBound);
    window.removeEventListener("resize", this.onResizeBound);

    this.stopEngineNode();
    this.engineState = "off";
    if (this.audioCtx) {
      void this.audioCtx.close();
      this.audioCtx = null;
    }

    this.renderer.dispose();
  }

  private async ensureAudioLoaded(): Promise<void> {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext();
    }
    if (this.audioCtx.state === "suspended") {
      await this.audioCtx.resume();
    }
    if (!this.soundLoadPromise) {
      this.soundLoadPromise = Promise.resolve();
    }
    await this.soundLoadPromise;
  }

  private stopEngineNode(): void {
    if (this.engineNode) {
      try {
        this.engineNode.stop();
      } catch {
        // ignore stop timing errors
      }
      this.engineNode.disconnect();
      this.engineNode = null;
    }

    if (this.engineGain) {
      this.engineGain.disconnect();
      this.engineGain = null;
    }
  }

  private loopEngine(): void {
    if (!this.audioCtx || this.engineState === "running") return;
    this.engineState = "running";
    this.stopEngineNode();

    const buffer =
      this.soundBufs.tank_running ||
      this.soundBufs.engine_running ||
      this.soundBufs.tank_idle ||
      this.soundBufs.engine_idle;
    if (!buffer) return;

    this.engineNode = this.audioCtx.createBufferSource();
    this.engineNode.buffer = buffer;
    this.engineNode.loop = true;
    this.engineGain = this.audioCtx.createGain();
    this.engineGain.gain.value = 0.9;

    this.engineNode.connect(this.engineGain);
    this.engineGain.connect(this.audioCtx.destination);
    this.engineNode.start();
  }

  private idleEngine(): void {
    if (!this.audioCtx || this.engineState === "idle") return;
    this.engineState = "idle";
    this.stopEngineNode();

    const buffer = this.soundBufs.tank_idle || this.soundBufs.engine_idle;
    if (!buffer) return;

    this.engineNode = this.audioCtx.createBufferSource();
    this.engineNode.buffer = buffer;
    this.engineNode.loop = true;
    this.engineGain = this.audioCtx.createGain();
    this.engineGain.gain.value = 0.7;

    this.engineNode.connect(this.engineGain);
    this.engineGain.connect(this.audioCtx.destination);
    this.engineNode.start();
  }

  private updateEngine(moving: boolean): void {
    if (
      !this.audioCtx ||
      this.engineState === "off" ||
      this.engineState === "starting"
    ) {
      return;
    }

    const want = moving ? "running" : "idle";
    if (want === "running" && this.engineState !== "running") this.loopEngine();
    if (want === "idle" && this.engineState !== "idle") this.idleEngine();

    if (this.engineNode && this.engineGain) {
      const spd = Math.abs(this.tankVel) / CONFIG.TANK_FWD_MAX;
      this.engineNode.playbackRate.value = 0.85 + spd * 0.35;
      this.engineGain.gain.value = 0.6 + spd * 0.4;
    }
  }

  private playAny(keys: string[], volume = 1): boolean {
    if (!this.audioCtx) return false;
    const key = keys.find((candidate) => this.soundBufs[candidate]);
    if (!key) return false;

    const source = this.audioCtx.createBufferSource();
    source.buffer = this.soundBufs[key];
    const gain = this.audioCtx.createGain();
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(this.audioCtx.destination);
    source.start();
    return true;
  }

  private getNoiseBuffer(): AudioBuffer | null {
    if (!this.audioCtx) return null;
    if (this.noiseBuffer) return this.noiseBuffer;

    const sampleRate = this.audioCtx.sampleRate;
    const frameCount = sampleRate;
    const buffer = this.audioCtx.createBuffer(1, frameCount, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frameCount; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buffer;
    return buffer;
  }

  private playSynthShot(kind: "cannon" | "mg" | "enemy"): void {
    if (!this.audioCtx) return;
    const ctx = this.audioCtx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    if (kind === "cannon") {
      osc.type = "triangle";
      osc.frequency.setValueAtTime(180, now);
      osc.frequency.exponentialRampToValueAtTime(48, now + 0.2);
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(1200, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.52, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
      osc.start(now);
      osc.stop(now + 0.24);
      return;
    }

    osc.type = kind === "mg" ? "square" : "sawtooth";
    osc.frequency.setValueAtTime(kind === "mg" ? 520 : 360, now);
    osc.frequency.exponentialRampToValueAtTime(kind === "mg" ? 250 : 170, now + 0.08);
    filter.type = "bandpass";
    filter.Q.value = 1.8;
    filter.frequency.setValueAtTime(kind === "mg" ? 2400 : 1800, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(kind === "mg" ? 0.12 : 0.16, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    osc.start(now);
    osc.stop(now + 0.12);
  }

  private playSynthExplosion(intensity: number): void {
    if (!this.audioCtx) return;
    const ctx = this.audioCtx;
    const noise = this.getNoiseBuffer();
    if (!noise) return;
    const now = ctx.currentTime;

    const source = ctx.createBufferSource();
    source.buffer = noise;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(900 + intensity * 420, now);
    filter.frequency.exponentialRampToValueAtTime(130, now + 0.6);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.46 * intensity, now + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.72);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    source.start(now);
    source.stop(now + 0.74);
  }

  private playSynthImpact(): void {
    if (!this.audioCtx) return;
    const ctx = this.audioCtx;
    const noise = this.getNoiseBuffer();
    if (!noise) return;
    const now = ctx.currentTime;

    const source = ctx.createBufferSource();
    source.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.setValueAtTime(1400, now);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.2, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    source.start(now);
    source.stop(now + 0.08);
  }

  private endGame(): void {
    this.running = false;
    this.gameOver = true;
    this.stopEngineNode();
    this.engineState = "off";
    if (document.exitPointerLock) document.exitPointerLock();
    this.pushHud();
  }

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);

    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (this.running) {
      this.updatePlayer(dt);
      this.updateEnemies(dt);
      this.updateBullets(dt);
      this.updateParticles(dt);

      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0 && this.enemies.length < 4) {
        this.spawnTimer = 20 + Math.random() * 15;
        const a = Math.random() * Math.PI * 2;
        const r = 38 + Math.random() * 14;
        this.buildEnemy(Math.cos(a) * r, Math.sin(a) * r);
      }

      this.pushHud();
    }

    this.renderer.render(this.scene, this.camera);
  };

  private onMouseMove(e: MouseEvent): void {
    if (!this.running) return;
    const locked = this.isPointerLocked();

    if (locked) {
      if (this.fpMode) {
        this.gunYawTarget -= e.movementX * CONFIG.MOUSE_SENS;
        this.gunPitchTarget -= e.movementY * CONFIG.MOUSE_SENS;
        this.gunYawTarget = THREE.MathUtils.clamp(
          this.gunYawTarget,
          -CONFIG.GUN_YAW_MAX,
          CONFIG.GUN_YAW_MAX,
        );
        this.gunPitchTarget = THREE.MathUtils.clamp(
          this.gunPitchTarget,
          CONFIG.GUN_PITCH_MIN,
          CONFIG.GUN_PITCH_MAX,
        );
        return;
      }

      this.aimScreenX = THREE.MathUtils.clamp(
        this.aimScreenX + e.movementX,
        0,
        window.innerWidth,
      );
      this.aimScreenY = THREE.MathUtils.clamp(
        this.aimScreenY + e.movementY,
        0,
        window.innerHeight,
      );
      return;
    }

    if (this.fpMode) {
      this.gunYawTarget -= e.movementX * CONFIG.MOUSE_SENS;
      this.gunPitchTarget -= e.movementY * CONFIG.MOUSE_SENS;
      this.gunYawTarget = THREE.MathUtils.clamp(
        this.gunYawTarget,
        -CONFIG.GUN_YAW_MAX,
        CONFIG.GUN_YAW_MAX,
      );
      this.gunPitchTarget = THREE.MathUtils.clamp(
        this.gunPitchTarget,
        CONFIG.GUN_PITCH_MIN,
        CONFIG.GUN_PITCH_MAX,
      );
      return;
    }

    this.aimScreenX = THREE.MathUtils.clamp(e.clientX, 0, window.innerWidth);
    this.aimScreenY = THREE.MathUtils.clamp(e.clientY, 0, window.innerHeight);
  }

  private onMouseDown(): void {
    if (!this.running) return;
    this.requestPointerLock();
    this.keys.Mouse0 = true;
    if (this.weapon === "cannon") {
      this.shoot();
    }
  }

  private onMouseUp(): void {
    this.keys.Mouse0 = false;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.code === "Tab") {
      e.preventDefault();
      this.swapWeapon();
      return;
    }

    if (e.code === "KeyX") this.swapWeapon();
    if (e.code === "KeyV") this.toggleFP();

    this.keys[e.code] = true;
    if (e.code === "Space") this.keys.Mouse0 = true;
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.keys[e.code] = false;
    if (e.code === "Space") this.keys.Mouse0 = false;
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    if (this.fpMode) {
      this.setXhairCenter();
    }
  }

  private requestPointerLock(): void {
    if (document.pointerLockElement !== this.canvas) {
      this.canvas.requestPointerLock().catch(() => {
        // ignore pointer lock errors
      });
    }
  }

  private isPointerLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  private setXhairCenter(): void {
    this.aimScreenX = window.innerWidth / 2;
    this.aimScreenY = window.innerHeight / 2;
  }

  private terrainH(x: number, z: number): number {
    return Math.sin(x * 0.06) * 0.22 + Math.cos(z * 0.05) * 0.18;
  }

  private normalizeAngle(a: number): number {
    let out = a;
    while (out > Math.PI) out -= Math.PI * 2;
    while (out < -Math.PI) out += Math.PI * 2;
    return out;
  }

  private pushHud(): void {
    this.onHud({
      hp: this.hp,
      score: this.score,
      weapon: this.weapon,
      cannonAmmo: this.cannonAmmo,
      mgAmmo: this.mgAmmo,
      running: this.running,
      gameOver: this.gameOver,
      hint: this.fpMode
        ? "V - 3a pessoa | W/S mover | A/D girar | Mouse mirar | Clique atirar | TAB trocar arma | R reparar"
        : BASE_HINT,
      crosshairX: this.fpMode ? window.innerWidth / 2 : this.aimScreenX,
      crosshairY: this.fpMode ? window.innerHeight / 2 : this.aimScreenY,
    });
  }
}
