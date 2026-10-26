// ═══ 第一人称漫游：指针锁定 + WASD + 触摸摇杆 + 地面贴合 + 碰撞 ═══
import * as THREE from 'three';
// isMobile 原本定义在这里，但 app.js 首屏只需要它、却因此静态拖入了 three。
// 现移到零依赖的 env.js，这里 import 回来保证老导出仍可用。
import { isMobile } from './env.js';

export { isMobile };

export class Roamer {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.yaw = 0;
    this.pitch = 0;
    this.vel = new THREE.Vector3();
    this.keys = new Set();
    this.locked = false;
    this.eyeH = 1.65;
    this.boundR = 60;
    this.groundHeight = () => 0;
    this.enabled = false;
    this.colliders = [];     // [{x,z,w,d} 矩形 或 {x,z,r} 圆]
    this.playerR = 0.45;     // 玩家碰撞半径

    this.vy = 0;
    this.airborne = false;

    // ─── 触摸控制 ───
    this.touchMove = { x: 0, y: 0 };   // 摇杆输入 (-1~1)
    this.touchLook = { x: 0, y: 0 };   // 视角增量
    this.touchRunning = false;          // 移动端是否处于"漫游中"

    this._onMouseMove = e => {
      if (!this.locked) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch -= e.movementY * 0.0022;
      this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch));
    };
    this._onKeyDown = e => { this.keys.add(e.code); };
    this._onKeyUp = e => { this.keys.delete(e.code); };
    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.dom;
      if (this.onLockChange) this.onLockChange(this.locked);
    };

    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('pointerlockchange', this._onLockChange);
  }

  lock() { if (!isMobile && !this.locked) this.dom.requestPointerLock(); }
  unlock() { if (this.locked) document.exitPointerLock(); }

  spawnAt(pos, yaw) {
    this.camera.position.set(pos[0], pos[1] + this.eyeH, pos[2]);
    this.yaw = yaw; this.pitch = 0; this.vy = 0; this.airborne = false;
  }

  // 碰撞检测：玩家圆与所有 collider
  _blocked(x, z) {
    const pr = this.playerR;
    for (const c of this.colliders) {
      if (c.r !== undefined) {
        // 圆形 collider
        if ((x - c.x) ** 2 + (z - c.z) ** 2 < (c.r + pr) ** 2) return true;
      } else {
        // 矩形 collider（AABB，玩家视为圆近似为方）
        const hw = c.w / 2 + pr, hd = c.d / 2 + pr;
        if (x > c.x - hw && x < c.x + hw && z > c.z - hd && z < c.z + hd) return true;
      }
    }
    return false;
  }

  update(dt) {
    if (!this.enabled) return;
    const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 11.5 : 5.5;

    // 触摸视角
    if (this.touchLook.x !== 0 || this.touchLook.y !== 0) {
      this.yaw -= this.touchLook.x * 0.003;
      this.pitch -= this.touchLook.y * 0.003;
      this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch));
      this.touchLook.x = 0;
      this.touchLook.y = 0;
    }

    const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const r = new THREE.Vector3(-f.z, 0, f.x);
    const move = new THREE.Vector3();
    const canMove = this.locked || (isMobile && this.touchRunning);
    if (canMove) {
      if (this.keys.has('KeyW')) move.add(f);
      if (this.keys.has('KeyS')) move.sub(f);
      if (this.keys.has('KeyD')) move.add(r);
      if (this.keys.has('KeyA')) move.sub(r);
      // 触摸摇杆
      if (this.touchMove.x !== 0 || this.touchMove.y !== 0) {
        move.add(f.clone().multiplyScalar(-this.touchMove.y));
        move.add(r.clone().multiplyScalar(this.touchMove.x));
      }
    }
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed);

    this.vel.x += (move.x - this.vel.x) * Math.min(1, dt * 10);
    this.vel.z += (move.z - this.vel.z) * Math.min(1, dt * 10);

    const p = this.camera.position;
    // 分轴移动 + 碰撞（实现沿墙滑动）
    const oldX = p.x, oldZ = p.z;
    let nx = p.x + this.vel.x * dt;
    let nz = p.z + this.vel.z * dt;
    // 圆形边界先夹
    const d = Math.hypot(nx, nz);
    if (d > this.boundR) { nx *= this.boundR / d; nz *= this.boundR / d; }
    // 试整步，若挡则分轴滑
    if (this._blocked(nx, nz)) {
      // 试只 X
      if (!this._blocked(nx, oldZ)) { p.x = nx; p.z = oldZ; }
      else if (!this._blocked(oldX, nz)) { p.x = oldX; p.z = nz; }
      // 都挡则不动
    } else { p.x = nx; p.z = nz; }

    // 地面 + 跳跃
    const gy = this.groundHeight(p.x, p.z) + this.eyeH;
    if (this.locked && this.keys.has('Space') && !this.airborne) {
      this.vy = 5.2; this.airborne = true;
    }
    if (this.airborne) {
      this.vy -= 14 * dt;
      p.y += this.vy * dt;
      if (p.y <= gy) { p.y = gy; this.airborne = false; this.vy = 0; }
    } else {
      p.y += (gy - p.y) * Math.min(1, dt * 12);
    }

    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
  }

  dispose() {
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('pointerlockchange', this._onLockChange);
  }
}
