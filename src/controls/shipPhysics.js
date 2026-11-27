/**
 * Heavy multi-thousand-ton polar icebreaker kinematics with WASD + Arrow keys.
 * Models:
 * - Massive 15,000-ton displacement inertia: responsive bridge telegraph order paired with
 *   heavy diesel-electric shaft spool lag, long open-water coasting glide & heavy pack-ice drag
 * - Weighted hydraulic rudder, subtle realistic turning leeway (sway drift), and strong rotational momentum
 * - Unmistakable low-speed ice-contact collision feel: bow ride-up ("climb") onto unbroken pack-ice lip,
 *   momentary weight-arrest stick, sluggish gravity/spoon-bow slide-back when thrust is below fracture yield,
 *   asymmetric glancing shoulder bumps against channel walls, and low-frequency structural hull shudder
 * - Rhythmic heavy brittle-ice breakthrough cycle (climb -> resistance drag -> crack -> bow plunge)
 * - Slow, authoritative second-order damped metacentric roll, pitch & heave natural periods
 */
export class ShipPhysics {
  constructor() {
    this.keys = new Set();
    this.reset();
    this._bindEvents();
  }

  reset() {
    this.x = 0;
    this.z = 0;
    // Heading = 0 means bow points along +Z (matches iconic reference composition in Camera 1)
    this.heading = 0;
    this.speed = 1.95;           // Stately initial cruise speed (~3.2 kt) cutting steadily through pack ice
    this.swaySpeed = 0;          // Lateral leeway drift velocity during sweeping heavy turns
    this.targetThrottle = 0.44;  // -0.50..1.0 bridge engine-order telegraph
    this.throttle = 0.44;        // Spooling diesel-electric shaft output
    this.rudder = 0;             // -1 (starboard / D) to +1 (port / A)
    this.angularVelocity = 0;

    // Second-order damped metacentric hull attitude state (heavy ~3s natural periods!)
    this.roll = 0;
    this.rollVel = 0;
    this.pitch = -0.010;         // Slight bow-up trim riding onto pack ice
    this.pitchVel = 0;
    this.heave = 0.022;
    this.heaveVel = 0;

    // Ice-contact collision, low-speed arrest/rebound & breakthrough state
    this.iceResistance = 0.42;
    this.distanceSailed = 0;
    this.iceImpactPulse = 0;        // 0..1 visual burst for bow surge foam & chipped shard jostle
    this.impactCameraImpulse = 0;   // Weighty low-frequency vertical thud cushion for CameraRig
    this.impactCameraRecoil = 0;    // Subtle longitudinal deceleration cushion for CameraRig
    this.bowContact = 1.0;          // 0 = open water, 1 = bow stem pressing solid pack ice
    this.portShoulderContact = 0.0;
    this.stbdShoulderContact = 0.0;
    this.wasBowInIce = true;
    this.wasPortShoulderInIce = false;
    this.wasStbdShoulderInIce = false;
    this.isBreakingIce = true;      // True ONLY when force/momentum overcomes ice yield -> IceWorld carves!
    this.iceBreakProgress = 0.32;   // Builds 0 -> 1 over ~2.55m as bow rides up, then snaps & plunges
    this.iceStress = 0;             // Low-speed compression pressure against unbroken ice wall
    this.contactStickTimer = 0;     // Brief heavy bow-arrest pause at peak climb before sliding back
    this.pendingReboundSpeed = 0;   // Stored sluggish slide-back velocity released after bow-climb stick
    this.shudderEnergy = 0;         // Decaying low-frequency steel-hull structural shudder
    this.shudderPhase = 0;
    this.reboundCooldown = 0;
    this.shoulderCooldown = 0;
    this._impactSign = 1;
    this._pendingImpactEvent = null; // Consumed by IceWorld to chip shards right at contact point
    this._time = 0;

    this.renderRoll = this.roll;
    this.renderPitch = this.pitch;
    this.renderHeave = this.heave;
  }

  _bindEvents() {
    window.addEventListener('keydown', (e) => {
      const code = e.code;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(code)) {
        this.keys.add(code);
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
    });
  }

  isPressed(code) {
    return this.keys.has(code);
  }

  consumeImpactEvent() {
    const ev = this._pendingImpactEvent;
    this._pendingImpactEvent = null;
    return ev;
  }

  /**
   * Triggers a heavy hull-ice impact, low-speed contact bump, or brittle fracture snap impulse.
   * kind: 'bump' (low-speed arrest/climb), 'ram' (heavy ice-wall impact),
   *       'break' (plate fracture plunge), 'shoulder' (glancing side-bank bump)
   */
  _triggerIceImpact(strength, kind = 'bump', sideSign = 0) {
    const s = Math.max(0.18, Math.min(1.25, strength));
    this.iceImpactPulse = Math.max(this.iceImpactPulse, Math.min(1.0, s * 1.05));
    this.impactCameraImpulse = Math.max(
      this.impactCameraImpulse,
      s * (kind === 'shoulder' ? 0.55 : kind === 'break' ? 0.82 : 1.05)
    );
    if (kind === 'bump' || kind === 'ram') {
      this.impactCameraRecoil = Math.max(this.impactCameraRecoil, s * (kind === 'ram' ? 1.15 : 0.92));
    } else if (kind === 'break') {
      this.impactCameraRecoil = Math.max(this.impactCameraRecoil, s * 0.45);
    }

    this.shudderEnergy = Math.min(1.0, this.shudderEnergy + s * (kind === 'bump' ? 0.92 : 0.78));
    const rollDir = sideSign !== 0 ? -Math.sign(sideSign) : (this._impactSign = -this._impactSign);

    if (kind === 'break') {
      // Ice plate snaps under 15,000-ton bow -> weighty nose-down plunge & buoyant recovery!
      this.pitchVel += s * 0.145;
      this.heaveVel -= s * 0.24;
      this.rollVel += rollDir * s * 0.062;
    } else if (kind === 'shoulder') {
      // Glancing side-wall ice impact -> outward heel away from struck ice bank + mild bow lift
      this.rollVel += rollDir * s * 0.105;
      this.pitchVel -= s * 0.055;
      this.heaveVel += s * 0.080;
    } else {
      // Bow hits solid ice shelf -> raked spoon-bow rides unmistakably UP onto the ice lip!
      this.pitchVel -= s * 0.215;
      this.heaveVel += s * 0.28;
      this.rollVel += rollDir * s * 0.075;
    }

    this._pendingImpactEvent = { kind, strength: s, sideSign };
  }

  /**
   * Updates heavy ship kinematics & tactile ice-contact collision physics.
   * @param {number} dt Frame delta seconds
   * @param {boolean|{bowInIce:number, portShoulderInIce:number, stbdShoulderInIce:number, inOpenWater:boolean}} contact
   */
  update(dt, contact = false) {
    const clampedDt = Math.min(dt, 0.05);
    this._time += clampedDt;
    this.reboundCooldown = Math.max(0, this.reboundCooldown - clampedDt);
    this.shoulderCooldown = Math.max(0, this.shoulderCooldown - clampedDt);

    // Normalize contact info from IceWorld
    const bowInIce = typeof contact === 'object' && contact !== null
      ? contact.bowInIce
      : (contact ? 0.0 : 1.0);
    const portShoulderInIce = typeof contact === 'object' && contact !== null
      ? contact.portShoulderInIce
      : bowInIce;
    const stbdShoulderInIce = typeof contact === 'object' && contact !== null
      ? contact.stbdShoulderInIce
      : bowInIce;
    const inOpenWater = typeof contact === 'object' && contact !== null
      ? contact.inOpenWater
      : Boolean(contact);

    this.bowContact = bowInIce;
    this.portShoulderContact = portShoulderInIce;
    this.stbdShoulderContact = stbdShoulderInIce;

    const forward = this.keys.has('KeyW') || this.keys.has('ArrowUp');
    const backward = this.keys.has('KeyS') || this.keys.has('ArrowDown');
    const left = this.keys.has('KeyA') || this.keys.has('ArrowLeft');
    const right = this.keys.has('KeyD') || this.keys.has('ArrowRight');
    const brake = this.keys.has('Space');

    // -------------------------------------------------------------------------
    // 1. BRIDGE ENGINE-ORDER TELEGRAPH & HEAVY DIESEL-ELECTRIC SHAFT SPOOL LAG
    // -------------------------------------------------------------------------
    if (brake) {
      this.targetThrottle += (0 - this.targetThrottle) * Math.min(1, clampedDt * 3.4);
      if (Math.abs(this.targetThrottle) < 0.015) this.targetThrottle = 0;
    } else if (forward && !backward) {
      this.targetThrottle = Math.min(1.0, this.targetThrottle + clampedDt * 0.46);
    } else if (backward && !forward) {
      this.targetThrottle = Math.max(-0.50, this.targetThrottle - clampedDt * 0.50);
    }

    // Massive propulsion shaft inertia (~1.5-2.0s authoritative spool up/down)
    const spoolRate = Math.abs(this.targetThrottle) > Math.abs(this.throttle) ? 0.88 : 1.12;
    this.throttle += (this.targetThrottle - this.throttle) * Math.min(1, clampedDt * spoolRate);

    // -------------------------------------------------------------------------
    // 2. WEIGHTY HYDRAULIC RUDDER, ROTATIONAL MOMENTUM & SHOULDER ICE BUMPS
    // -------------------------------------------------------------------------
    let rudderInput = 0;
    if (left) rudderInput += 1;
    if (right) rudderInput -= 1;

    const rudderRate = rudderInput !== 0 ? 1.08 : 0.86;
    this.rudder += (rudderInput - this.rudder) * Math.min(1, clampedDt * rudderRate);

    // Turning bow shoulder into unbroken pack ice resists yaw & causes a glancing bump!
    const turningPort = this.angularVelocity > 0.025 || rudderInput > 0;
    const turningStbd = this.angularVelocity < -0.025 || rudderInput < 0;
    const portJustHit = portShoulderInIce > 0.55 && !this.wasPortShoulderInIce;
    const stbdJustHit = stbdShoulderInIce > 0.55 && !this.wasStbdShoulderInIce;

    if (this.shoulderCooldown <= 0) {
      if (portJustHit && turningPort && (Math.abs(this.angularVelocity) > 0.045 || Math.abs(this.speed) > 0.35)) {
        const hitS = Math.min(0.85, 0.28 + Math.abs(this.angularVelocity) * 2.4 + Math.abs(this.speed) * 0.10);
        this._triggerIceImpact(hitS, 'shoulder', 1);
        this.angularVelocity *= -0.26; // Tactile yaw bounce off thick port ice shelf!
        this.speed *= 0.86;
        this.shoulderCooldown = 0.65;
      } else if (stbdJustHit && turningStbd && (Math.abs(this.angularVelocity) > 0.045 || Math.abs(this.speed) > 0.35)) {
        const hitS = Math.min(0.85, 0.28 + Math.abs(this.angularVelocity) * 2.4 + Math.abs(this.speed) * 0.10);
        this._triggerIceImpact(hitS, 'shoulder', -1);
        this.angularVelocity *= -0.26;
        this.speed *= 0.86;
        this.shoulderCooldown = 0.65;
      }
    }
    this.wasPortShoulderInIce = portShoulderInIce > 0.55;
    this.wasStbdShoulderInIce = stbdShoulderInIce > 0.55;

    const shoulderBite = rudderInput > 0
      ? portShoulderInIce
      : rudderInput < 0
        ? stbdShoulderInIce
        : (portShoulderInIce + stbdShoulderInIce) * 0.5;
    const iceTurnDamp = 1.0 - shoulderBite * 0.44;

    const absSpeed = Math.abs(this.speed);
    const speedDir = this.speed >= -0.08 ? 1 : -1;
    // Prop wash over twin rudders gives modest slow-speed steering authority; dead-in-water barely swings
    const propWashAuth = Math.min(0.42, Math.max(0, this.throttle) * 0.58);
    const hullFlowAuth = Math.min(1.0, absSpeed / 3.9);
    const flowAuthority = Math.max(hullFlowAuth, propWashAuth * 0.72);
    const effectiveTurnAuthority = absSpeed < 0.14 && Math.abs(this.throttle) < 0.06
      ? 0.05
      : speedDir * (0.14 + 0.86 * flowAuthority);

    const maxYawRate = 0.215 * iceTurnDamp; // ~12.3 deg/s max — stately, heavy 15,000-ton vessel!
    const targetAngVel = this.rudder * maxYawRate * effectiveTurnAuthority;
    // Massive yaw inertia: reluctant to start turning, carries momentum well after releasing helm!
    const yawRate = Math.abs(targetAngVel) > Math.abs(this.angularVelocity) ? 0.74 : 0.92;
    this.angularVelocity += (targetAngVel - this.angularVelocity) * Math.min(1, clampedDt * yawRate);
    this.heading += this.angularVelocity * clampedDt;

    // -------------------------------------------------------------------------
    // 3. HEAVY DISPLACEMENT PROPULSION & LOW-SPEED ICE-CONTACT COLLISION PHYSICS
    // -------------------------------------------------------------------------
    const maxForwardOpen = 7.4;
    const maxForwardIce = 5.0;
    const maxReverse = 2.6;
    const yieldThreshold = 0.34; // Minimum effective breaking force to fracture solid pack ice!

    const bowHitFreshIce = bowInIce > 0.52 && !this.wasBowInIce;
    let climbTarget = 0;
    let lowSpeedPressing = false;
    this.isBreakingIce = false;

    // 3A. Fresh Open-Water -> Solid Pack-Ice Edge COLLISION!
    if (bowHitFreshIce && this.speed > 0.10 && this.reboundCooldown <= 0) {
      const impactSpeed = this.speed;
      const thrustPower = Math.max(0, this.throttle);
      const ramEnergy = thrustPower + impactSpeed * 0.22;

      if (impactSpeed < 1.85 && ramEnergy < 0.58 && thrustPower < yieldThreshold) {
        // LOW-SPEED TACTILE COLLISION: Thick unbroken ice arrests the heavy bow!
        // Spoon bow visibly rides UP onto the ice lip, pauses for ~0.2s under weight, then slides back!
        const bumpStrength = Math.min(0.95, 0.36 + impactSpeed * 0.38);
        this._triggerIceImpact(bumpStrength, 'bump', 0);
        this.speed = 0.02;
        this.contactStickTimer = 0.18 + Math.min(0.14, impactSpeed * 0.08);
        this.pendingReboundSpeed = -Math.min(0.58, 0.20 + impactSpeed * 0.28);
        this.iceStress = 0.85;
        this.reboundCooldown = 0.85;
      } else {
        // HIGH-SPEED / HIGH-THRUST RAMMING IMPACT: Dramatic momentum check + bow climbs & shatters ice!
        const ramStrength = Math.min(1.15, 0.56 + impactSpeed * 0.14);
        this._triggerIceImpact(ramStrength, 'ram', 0);
        this.speed *= (0.54 + Math.min(0.16, thrustPower * 0.16));
        this.iceBreakProgress = Math.max(this.iceBreakProgress, 0.62);
        this.reboundCooldown = 0.60;
      }
    }
    this.wasBowInIce = bowInIce > 0.52;

    // 3B. Handle momentary peak-climb stick phase right after a low-speed bow bump -> release slide-back!
    if (this.contactStickTimer > 0) {
      this.contactStickTimer = Math.max(0, this.contactStickTimer - clampedDt);
      // Hold bow visibly pitched up on the ice lip with tactile hull tremor before sliding off
      climbTarget = 0.058;
      this.speed *= Math.exp(-clampedDt * 10.0);
      this.shudderEnergy = Math.max(this.shudderEnergy, 0.34);
      if (this.contactStickTimer <= 0) {
        this.speed = this.pendingReboundSpeed;
        this.pendingReboundSpeed = 0;
      }
    }

    // 3C. Compute heavy propulsion target vs open-water / pack-ice yield resistance
    const turnSpeedScrub = 1.0 - Math.abs(this.rudder) * (0.16 + shoulderBite * 0.14);
    let desiredSpeed;
    if (this.throttle >= 0) {
      const cap = inOpenWater ? maxForwardOpen : maxForwardIce;
      desiredSpeed = this.throttle * cap * turnSpeedScrub;
    } else {
      desiredSpeed = this.throttle * maxReverse;
    }

    if (bowInIce > 0.48 && this.speed >= -0.06 && this.contactStickTimer <= 0) {
      const thrustPower = Math.max(0, this.throttle);
      const kineticCarry = Math.max(0, this.speed) * 0.20;
      const effectiveBreakForce = thrustPower + kineticCarry;

      if (thrustPower <= 0.03 && this.speed > 0.04 && this.speed < 1.35) {
        // Coasting gently into solid ice with engines stopped -> heavy cushioned stop & gentle slide-back!
        this.speed -= clampedDt * (1.35 + bowInIce * 1.15);
        climbTarget = Math.max(climbTarget, Math.min(0.038, 0.012 + this.speed * 0.028));
        this.shudderEnergy = Math.max(this.shudderEnergy, Math.min(0.26, this.speed * 0.24));
        if (this.speed <= 0.05 && this.reboundCooldown <= 0) {
          this._triggerIceImpact(0.36, 'bump', 0);
          this.contactStickTimer = 0.16;
          this.pendingReboundSpeed = -0.24;
          this.speed = 0.0;
          this.reboundCooldown = 1.15;
        }
      } else if (effectiveBreakForce < yieldThreshold && thrustPower > 0.02) {
        // LOW-THROTTLE PUSHING AGAINST SOLID ICE (below yield!):
        // Unbroken ice HOLDS the bow firmly — ship strains, climbs bow-up, shudders, and bumps/slips back!
        lowSpeedPressing = true;
        this.iceStress = Math.min(1.0, this.iceStress + clampedDt * (0.58 + thrustPower * 1.45));
        const ratio = effectiveBreakForce / yieldThreshold;
        const crawlCap = Math.max(0.0, (ratio - 0.35) * 0.18);
        desiredSpeed = Math.min(desiredSpeed, crawlCap);
        // Very visible bow climb-up & continuous heavy grinding shudder against ice edge
        climbTarget = Math.max(climbTarget, 0.032 + this.iceStress * 0.034);
        this.shudderEnergy = Math.max(this.shudderEnergy, 0.18 + thrustPower * 0.62);

        if (this.iceStress >= 0.96 && this.reboundCooldown <= 0) {
          if (thrustPower >= 0.27) {
            // Borderline grinding power: slowly fractures a single slab with a heavy stop-and-go lurch!
            this._triggerIceImpact(0.46 + thrustPower * 0.4, 'break', 0);
            this.speed = Math.max(this.speed, 0.62);
            this.isBreakingIce = true;
            this.iceStress = 0.18;
            this.reboundCooldown = 1.25;
          } else {
            // Too weak to break thick pack ice -> bow loses bite on ice lip and bumps sluggishly back!
            this._triggerIceImpact(0.38 + thrustPower * 0.85, 'bump', 0);
            this.contactStickTimer = 0.18;
            this.pendingReboundSpeed = -(0.22 + thrustPower * 0.65);
            this.speed = 0.0;
            this.iceStress = 0.15;
            this.reboundCooldown = 1.20;
          }
        }
      } else if (effectiveBreakForce >= yieldThreshold && this.speed > 0.12) {
        this.isBreakingIce = true;
        this.iceStress = Math.max(0, this.iceStress - clampedDt * 1.1);
      } else {
        this.iceStress = Math.max(0, this.iceStress - clampedDt * 1.2);
      }
    } else if (bowInIce <= 0.48) {
      this.iceStress = Math.max(0, this.iceStress - clampedDt * 1.8);
    }

    // 3D. Apply Heavy 15,000-Ton Longitudinal Mass-Inertia Integration
    if (this.contactStickTimer <= 0) {
      const sameDir = Math.sign(desiredSpeed) === Math.sign(this.speed || desiredSpeed);
      const isAccelerating = Math.abs(desiredSpeed) > Math.abs(this.speed) && sameDir;
      const isCoasting = Math.abs(this.throttle) < 0.035;
      let accelRate;
      if (lowSpeedPressing) {
        // Thick ice wall rapidly arrests forward crawl
        accelRate = 2.6;
      } else if (isCoasting) {
        // Long stately glide in open water, decisive crushing drag in pack ice!
        accelRate = inOpenWater ? 0.17 : 0.62;
      } else if (isAccelerating) {
        // Deliberate, weighty acceleration overcoming massive inertia
        accelRate = inOpenWater ? 0.30 : 0.24;
      } else {
        // Heavy stopping distance even under Space or astern thrust
        accelRate = brake ? 0.52 : 0.42;
      }

      this.speed += (desiredSpeed - this.speed) * Math.min(1, clampedDt * accelRate);
      if (brake && Math.abs(this.speed) < 0.035 && Math.abs(this.throttle) < 0.035 && inOpenWater) {
        this.speed = 0;
      }
    }

    // -------------------------------------------------------------------------
    // 4. INTEGRATE 2D WORLD POSITION (WITH SUBTLE HEAVY-TURN LEEWAY) & BREAK CYCLE
    // -------------------------------------------------------------------------
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    const rx = Math.cos(this.heading);
    const rz = -Math.sin(this.heading);

    // Realistic heavy-vessel lateral leeway drift during sweeping turns (damped strongly by ice walls)
    const targetSway = -this.angularVelocity * this.speed * (inOpenWater ? 0.42 : 0.14);
    const swayDamp = inOpenWater ? 1.25 : 3.2;
    this.swaySpeed += (targetSway - this.swaySpeed) * Math.min(1, clampedDt * swayDamp);

    const ds = this.speed * clampedDt;
    const dLat = this.swaySpeed * clampedDt;
    this.x += fx * ds + rx * dLat;
    this.z += fz * ds + rz * dLat;
    this.distanceSailed += Math.hypot(ds, dLat);

    const crushing = this.isBreakingIce && bowInIce > 0.45 && this.speed > 0.20
      ? Math.min(1.0, this.speed / 4.6) * bowInIce
      : 0;
    this.iceResistance = Math.max(crushing, lowSpeedPressing ? 0.55 : 0);

    if (crushing > 0.04) {
      // Rhythmic heavy ice-breaking cycle: bow climbs progressively onto each ~2.55m slab, slows slightly, then CRACKS!
      this.iceBreakProgress += Math.max(0, ds) / 2.55;
      const preSnapClimb = Math.pow(Math.min(1.0, this.iceBreakProgress), 1.5);
      climbTarget = Math.max(climbTarget, preSnapClimb * (0.022 + crushing * 0.024));
      this.speed *= (1.0 - preSnapClimb * crushing * clampedDt * 0.26);

      if (this.iceBreakProgress >= 1.0) {
        this.iceBreakProgress -= 1.0;
        const breakIntensity = Math.min(1.0, 0.42 + crushing * 0.52);
        this._triggerIceImpact(breakIntensity, 'break', 0);
        // Palpable heavy crunch check when fracturing each thick slab
        this.speed *= (1.0 - (0.08 + (1.0 - crushing) * 0.06));
      }
    } else if (!lowSpeedPressing) {
      this.iceBreakProgress = Math.max(0, this.iceBreakProgress - clampedDt * 0.35);
    }

    // Decay transient impact & structural shudder pulses
    this.iceImpactPulse = Math.max(0, this.iceImpactPulse - clampedDt * 1.65);
    this.impactCameraImpulse = Math.max(0, this.impactCameraImpulse - clampedDt * 2.15);
    this.impactCameraRecoil = Math.max(0, this.impactCameraRecoil - clampedDt * 2.45);
    this.shudderEnergy = Math.max(0, this.shudderEnergy - clampedDt * 2.4);
    this.shudderPhase += clampedDt * 46.0; // Deep heavy steel-hull rumble frequency

    // -------------------------------------------------------------------------
    // 5. SLOW, WEIGHTY METACENTRIC SPRING DYNAMICS (Heavy ~3.0s Natural Periods!)
    // -------------------------------------------------------------------------
    const oceanRoll = Math.sin(this._time * 0.92) * 0.0085 * (0.35 + this.iceResistance * 0.65);
    // Outward turn heel + subtle initial rudder torque kick for authentic ship dynamics!
    const turnHeel = -this.angularVelocity * (0.28 + Math.min(0.18, absSpeed * 0.032)) + this.rudder * 0.011;
    const targetRoll = turnHeel + oceanRoll;

    const oceanPitch = Math.sin(this._time * 0.72) * 0.0032;
    const targetPitch = -climbTarget + oceanPitch;

    const oceanHeave = Math.sin(this._time * 1.15) * 0.022 * (0.4 + this.iceResistance * 0.6);
    const targetHeave = climbTarget * 2.25 + oceanHeave;

    // Deep heavy-displacement stiffness & damping (~3.2s roll, ~2.6s pitch, ~2.4s heave)
    const rollK = 3.8, rollC = 1.95;
    const pitchK = 5.8, pitchC = 2.85;
    const heaveK = 6.8, heaveC = 3.20;

    this.rollVel += ((targetRoll - this.roll) * rollK - this.rollVel * rollC) * clampedDt;
    this.roll += this.rollVel * clampedDt;

    this.pitchVel += ((targetPitch - this.pitch) * pitchK - this.pitchVel * pitchC) * clampedDt;
    this.pitch += this.pitchVel * clampedDt;

    this.heaveVel += ((targetHeave - this.heave) * heaveK - this.heaveVel * heaveC) * clampedDt;
    this.heave += this.heaveVel * clampedDt;

    // Tactile low-frequency steel-hull tremor during ice collision / low-speed grinding
    const shudder = Math.sin(this.shudderPhase) * this.shudderEnergy;
    this.renderRoll = this.roll + shudder * 0.0052;
    this.renderPitch = this.pitch + shudder * 0.0040;
    this.renderHeave = this.heave + shudder * 0.012;
  }

  getForwardVector() {
    return { x: Math.sin(this.heading), z: Math.cos(this.heading) };
  }

  getSpeedKnots() {
    return this.speed * 1.65;
  }

  getHeadingDegrees() {
    let deg = ((-this.heading * 180) / Math.PI + 225) % 360;
    if (deg < 0) deg += 360;
    return deg;
  }
}
