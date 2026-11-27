import * as THREE from 'three';

/**
 * Five curated fixed architectural & cinematic camera lenses.
 * Each lens maintains disciplined illustration framing with critically damped transitions.
 */
export const CAMERA_PRESETS = [
  {
    id: 'illustration',
    key: '1',
    name: '插画俯视',
    en: 'Illustration',
    desc: '经典高机位长焦等轴构图，完整呈现冰原、长投影与碎冰航迹',
    fov: 22,
    mode: 'world', // Fixed world-compass framing reproducing the editorial artwork composition
    offset: new THREE.Vector3(56, 63, 45),
    lookOffset: new THREE.Vector3(-2.6, 0.9, -11.5),
  },
  {
    id: 'bow',
    key: '2',
    name: '船首破冰',
    en: 'Bow Breaker',
    desc: '低中机位贴近加强型破冰船首，聚焦冰层挤压与建筑细节',
    fov: 27,
    mode: 'ship', // Relative to ship local frame (+Z bow, +X port, +Y up)
    offset: new THREE.Vector3(20.5, 10.6, 23.8),
    lookOffset: new THREE.Vector3(0, 3.1, 1.3),
  },
  {
    id: 'aerial',
    key: '3',
    name: '航迹俯瞰',
    en: 'Aerial Wake',
    desc: '高空俯瞰冰面放射状裂纹网络与深蓝破冰航道',
    fov: 26,
    mode: 'world',
    offset: new THREE.Vector3(28, 96, 24),
    lookOffset: new THREE.Vector3(0, 0, -14.0),
  },
  {
    id: 'bridge',
    key: '4',
    name: '舰桥侧翼',
    en: 'Bridge Wing',
    desc: '建筑剖面式近景视角，突显舰桥翼台、橙色救生艇与桅杆光影',
    fov: 28,
    mode: 'ship',
    offset: new THREE.Vector3(22.5, 12.6, -8.2),
    lookOffset: new THREE.Vector3(0, 3.5, 0.5),
  },
  {
    id: 'stern',
    key: '5',
    name: '尾迹低角',
    en: 'Stern Chase',
    desc: '航道低视角尾随，观察螺旋桨白沫、浮冰与船尾直升机甲板',
    fov: 31,
    mode: 'ship',
    offset: new THREE.Vector3(10.2, 8.6, -28.8),
    lookOffset: new THREE.Vector3(0, 3.1, 3.2),
  },
];

export class CameraRig {
  constructor(aspect) {
    this.camera = new THREE.PerspectiveCamera(CAMERA_PRESETS[0].fov, aspect, 0.8, 700);
    this.activeIndex = 0;

    this._currentPos = new THREE.Vector3();
    this._currentLook = new THREE.Vector3();
    this._currentFov = CAMERA_PRESETS[0].fov;
    this._smoothedHeading = 0;
    this._impactBob = 0;
    this._impactBobVel = 0;
    this._impactRecoil = 0;
    this._impactRecoilVel = 0;

    this._targetPos = new THREE.Vector3();
    this._targetLook = new THREE.Vector3();
    this._tempOffset = new THREE.Vector3();
    this._tempLook = new THREE.Vector3();
    this._initialized = false;
  }

  setPreset(index) {
    const safeIdx = ((index % CAMERA_PRESETS.length) + CAMERA_PRESETS.length) % CAMERA_PRESETS.length;
    this.activeIndex = safeIdx;
    return CAMERA_PRESETS[this.activeIndex];
  }

  cyclePreset() {
    return this.setPreset(this.activeIndex + 1);
  }

  getActivePreset() {
    return CAMERA_PRESETS[this.activeIndex];
  }

  resize(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  _computeTarget(ship, preset, heading) {
    if (preset.mode === 'world') {
      this._targetPos.set(
        ship.x + preset.offset.x,
        preset.offset.y,
        ship.z + preset.offset.z
      );
      this._targetLook.set(
        ship.x + preset.lookOffset.x,
        preset.lookOffset.y,
        ship.z + preset.lookOffset.z
      );
    } else {
      const cosH = Math.cos(heading);
      const sinH = Math.sin(heading);

      // Rotate local (x, z) by heading around Y:
      // local +Z -> (sinH, cosH), local +X -> (cosH, -sinH)
      const ox = preset.offset.x;
      const oz = preset.offset.z;
      this._tempOffset.set(
        ox * cosH + oz * sinH,
        preset.offset.y,
        -ox * sinH + oz * cosH
      );

      const lx = preset.lookOffset.x;
      const lz = preset.lookOffset.z;
      this._tempLook.set(
        lx * cosH + lz * sinH,
        preset.lookOffset.y,
        -lx * sinH + lz * cosH
      );

      this._targetPos.set(
        ship.x + this._tempOffset.x,
        this._tempOffset.y,
        ship.z + this._tempOffset.z
      );
      this._targetLook.set(
        ship.x + this._tempLook.x,
        this._tempLook.y,
        ship.z + this._tempLook.z
      );
    }
  }

  snap(ship) {
    this._smoothedHeading = ship.heading;
    const preset = CAMERA_PRESETS[this.activeIndex];
    this._computeTarget(ship, preset, this._smoothedHeading);
    this._currentPos.copy(this._targetPos);
    this._currentLook.copy(this._targetLook);
    this._currentFov = preset.fov;

    this.camera.fov = this._currentFov;
    this.camera.position.copy(this._currentPos);
    this.camera.lookAt(this._currentLook);
    this.camera.updateProjectionMatrix();
    this._initialized = true;
  }

  update(dt, ship) {
    if (!this._initialized) {
      this.snap(ship);
      return;
    }

    const clampedDt = Math.min(dt, 0.05);
    const preset = CAMERA_PRESETS[this.activeIndex];

    // Stately, weighty ship heading follow matching heavy 15,000-ton icebreaker momentum
    let dHeading = ship.heading - this._smoothedHeading;
    while (dHeading > Math.PI) dHeading -= Math.PI * 2;
    while (dHeading < -Math.PI) dHeading += Math.PI * 2;
    this._smoothedHeading += dHeading * (1 - Math.exp(-clampedDt * 1.85));

    this._computeTarget(ship, preset, this._smoothedHeading);

    // Weighty camera follow (lets hull recoil, rebound & heave read clearly against the frame!)
    const posLambda = 1 - Math.exp(-clampedDt * 3.9);
    const lookLambda = 1 - Math.exp(-clampedDt * 4.8);
    const fovLambda = 1 - Math.exp(-clampedDt * 4.6);

    this._currentPos.lerp(this._targetPos, posLambda);
    this._currentLook.lerp(this._targetLook, lookLambda);
    this._currentFov += (preset.fov - this._currentFov) * fovLambda;

    // Restrained, weighty low-frequency ice-impact camera thud & longitudinal deceleration recoil
    const imp = ship.impactCameraImpulse || 0;
    const rec = ship.impactCameraRecoil || 0;
    const lensScale = preset.id === 'bow' ? 0.16 : preset.id === 'bridge' ? 0.13 : preset.id === 'stern' ? 0.12 : 0.045;
    const targetBob = -imp * lensScale;
    this._impactBobVel += ((targetBob - this._impactBob) * 24.0 - this._impactBobVel * 7.6) * clampedDt;
    this._impactBob += this._impactBobVel * clampedDt;

    const targetRecoil = rec * lensScale * 1.35;
    this._impactRecoilVel += ((targetRecoil - this._impactRecoil) * 20.0 - this._impactRecoilVel * 7.2) * clampedDt;
    this._impactRecoil += this._impactRecoilVel * clampedDt;

    const fx = Math.sin(ship.heading);
    const fz = Math.cos(ship.heading);

    this.camera.position.set(
      this._currentPos.x + fx * this._impactRecoil,
      this._currentPos.y + this._impactBob,
      this._currentPos.z + fz * this._impactRecoil
    );
    this.camera.lookAt(
      this._currentLook.x + fx * this._impactRecoil * 0.45,
      this._currentLook.y + this._impactBob * 0.48,
      this._currentLook.z + fz * this._impactRecoil * 0.45
    );
    if (Math.abs(this.camera.fov - this._currentFov) > 0.01) {
      this.camera.fov = this._currentFov;
      this.camera.updateProjectionMatrix();
    }
  }
}
