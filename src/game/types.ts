import * as THREE from "three";

export type Weapon = "cannon" | "mg";

export type HudState = {
  hp: number;
  score: number;
  weapon: Weapon;
  cannonAmmo: number;
  mgAmmo: number;
  running: boolean;
  gameOver: boolean;
  hint: string;
  crosshairX: number;
  crosshairY: number;
};

export type Enemy = {
  mesh: THREE.Group;
  hp: number;
  mgCooldownT: number;
  mgBurstT: number;
  mgBurstShots: number;
  cannonT: number;
  patrol: THREE.Vector3;
};

export type Bullet = {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  type: "enemy" | "enemyCannon" | Weapon;
  life: number;
};

export type Particle = {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  max: number;
  smoke?: boolean;
};
