/* PlanePhysicsController — the flight model for an arcade carrier-to-carrier plane game.
   A small, deterministic physics model: the plane flies at a cruise speed and holds a "trim" height with a damped
   spring (lift working against gravity); pickups give it an upward kick and raise its trim height, mines knock it
   back and down; it can glide onto a carrier deck and roll to a stop, or lose lift and go down into the sea.

   Coordinates are screen-style world units: x grows to the right, y grows DOWN (so "up" is −y). Time is in seconds.
   rotation is the pitch in radians, positive = nose down (the same sense as the screen's y axis).

   Usage:
     const plane = new PlanePhysicsController({ x, y, seaY, cruiseSpeed, trimY, onExplosion, onTouchdown, onStop, onSplash });
     plane.update(dt);              // every frame (or at a fixed step, to bake a path in advance)
     plane.onHitBooster(2);         // a pickup worth ×2 (or +2): up it goes
     plane.onHitMine();             // recoil, down, and an explosion callback
     plane.startLanding(deckX, deckY);
     plane.startDitch();            // lift gone: down into the sea
     plane.x, plane.y, plane.rotation, plane.altitude, plane.mode
*/
(function (global) {
  "use strict";

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  /* frame-rate independent smoothing: move a fraction of the way toward a target, the same over any dt */
  const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

  class PlanePhysicsController {
    /**
     * @param {object} o
     * @param {number} o.x, o.y           starting position (world units, y down)
     * @param {number} o.seaY             the water line; altitude is measured from here
     * @param {number} [o.cruiseSpeed=110] horizontal speed the engine settles to (units/s)
     * @param {number} [o.trimY]          the height the plane holds in level flight (defaults to its start)
     * @param {number} [o.ceilingY=20]    trim height can't go above this (it eases off as it nears it)
     * @param {number} [o.floorY]         trim height can't go below this
     * @param {number} [o.groundPitch=0]  pitch while sitting on its wheels (a tail-dragger sits nose-up, < 0)
     * @param {number} [o.descent=0]      how fast it keeps settling lower in flight (units/s); 0 holds its height
     * @param {function} [o.onExplosion]  (x, y) → called by onHitMine
     * @param {function} [o.onTouchdown]  (x, y) → wheels meet the deck
     * @param {function} [o.onStop]       (x, y) → rolled to a stop on deck
     * @param {function} [o.onSplash]     (x, y) → hit the water
     */
    constructor(o) {
      /* tuning: what makes it feel like a light, lively aircraft */
      this.gravity = 60;           // units/s² pulling down
      this.spring = 14;            // how hard lift pulls it back to its trim height
      this.damping = 6.8;          // how quickly bobbing dies away (critical ≈ 2·√spring = 7.5)
      this.speedRecover = 1.6;     // how fast it regains cruise speed after a knock (1/s)
      this.pitchRate = 7;          // how fast the nose follows its flight path (1/s)
      this.maxPitch = 0.45;        // clamp on the nose-up / nose-down angle in normal flight (rad)
      this.booster = { impulse: 46, climb: 26, kick: -0.34 };   // a pickup: upward speed, trim raise, nose-up kick
      this.mine = { impulse: 22, drop: 10, kick: 0.3, recoil: 0.7 };   // a mine: down speed, trim drop, nose-down, speed kept
      this.glide = { speed: 0.8, sink: 19, flareAlt: 9, touchSink: 5 };  // engine out: speed kept, sink rate, flare height, sink at the water
      this.brake = 70;             // deceleration rolling out on deck (units/s²)
      this.descent = o.descent || 0; // in level flight the trim height sinks this fast (units/s): the plane keeps
                                     // easing down as if coming in to land, until something lifts it again

      this.x = o.x;
      this.y = o.y;
      this.seaY = o.seaY;
      this.cruiseSpeed = o.cruiseSpeed || 110;
      this.vx = this.cruiseSpeed;
      this.vy = 0;
      this.trimY = o.trimY != null ? o.trimY : o.y;
      this.ceilingY = o.ceilingY != null ? o.ceilingY : 20;
      this.floorY = o.floorY != null ? o.floorY : o.seaY - 30;
      this.groundPitch = o.groundPitch || 0;
      this.rotation = 0;
      this.pitchKick = 0;          // an extra nose-up/down from a hit, decaying away
      this.mode = "flying";        // flying → landing → rolling → stopped  |  flying → ditching → sunk
      this.landing = null;         // { x, y } touchdown point while landing
      this.cb = { explosion: o.onExplosion, touchdown: o.onTouchdown, stop: o.onStop, splash: o.onSplash };
    }

    /** height above the water (world units) */
    get altitude() {
      return this.seaY - this.y;
    }

    /** advance the model by dt seconds */
    update(dt) {
      if (dt <= 0 || this.mode === "stopped" || this.mode === "sunk") return this;
      switch (this.mode) {
        case "flying": this._fly(dt); break;
        case "landing": this._land(dt); break;
        case "rolling": this._roll(dt); break;
        case "ditching": this._ditch(dt); break;
      }
      this._pitch(dt);
      return this;
    }

    /** a pickup: an upward shove, a higher trim height and a nose-up kick. Bigger multipliers kick a little harder. */
    onHitBooster(multiplier) {
      if (this.mode !== "flying") return;
      const k = 1 + Math.min(0.6, Math.log2(Math.max(1, multiplier || 1)) * 0.2);
      this.vy -= this.booster.impulse * k;
      this.trimY = this._softCeiling(this.trimY - this.booster.climb * k);
      this.pitchKick += this.booster.kick * k;
    }

    /** a mine: recoil (loses speed), a shove downward, a lower trim height, a nose-down kick, and the explosion */
    onHitMine() {
      if (this.mode !== "flying") return;
      this.vx *= this.mine.recoil;
      this.vy += this.mine.impulse;
      this.trimY = Math.min(this.floorY, this.trimY + this.mine.drop);
      this.pitchKick += this.mine.kick;
      if (this.cb.explosion) this.cb.explosion(this.x, this.y);
    }

    /** glide down onto a deck: a straight approach to the touchdown point, a flare just before it, then a rollout */
    startLanding(carrierX, carrierY) {
      if (this.mode !== "flying") return;
      this.mode = "landing";
      this.landing = { x: carrierX, y: carrierY };
    }

    /** engine failure (or out of fuel): the plane doesn't drop like a stone — it keeps flying, settles into a steady
        powerless glide with the nose a little down, flares just above the water and belly-lands on the sea */
    startDitch() {
      if (this.mode !== "flying") return;
      this.mode = "ditching";
    }

    /* ---------------- the phases ---------------- */
    _fly(dt) {
      /* always settling lower, as if on approach — down to the floor, where it levels off and waits for a lift */
      if (this.descent) this.trimY = Math.min(this.floorY, this.trimY + this.descent * dt);
      /* lift balances gravity at the trim height; away from it a damped spring pulls the plane back */
      const lift = this.gravity + this.spring * (this.y - this.trimY) + this.damping * this.vy;
      this.vy += (this.gravity - lift) * dt;
      this.vx = approach(this.vx, this.cruiseSpeed, this.speedRecover, dt);
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      /* never through the ceiling or below the floor in normal flight */
      if (this.y < this.ceilingY - 4) { this.y = this.ceilingY - 4; this.vy = Math.max(0, this.vy); }
      if (this.y > this.floorY + 6) { this.y = this.floorY + 6; this.vy = Math.min(0, this.vy); }
    }

    _land(dt) {
      const L = this.landing;
      this.vx = approach(this.vx, this.cruiseSpeed, this.speedRecover, dt);
      const dx = Math.max(2, L.x - this.x);
      /* the glide slope: the vertical speed that would bring it to the deck exactly at the touchdown point */
      const want = ((L.y - this.y) / dx) * this.vx;
      this.vy = approach(this.vy, want, 8, dt);
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      if (this.y >= L.y - 0.05 || this.x >= L.x) {
        this.y = L.y;
        this.vy = 0;
        this.mode = "rolling";
        if (this.cb.touchdown) this.cb.touchdown(this.x, this.y);
      }
    }

    _roll(dt) {
      this.vx = Math.max(0, this.vx - this.brake * dt);
      this.x += this.vx * dt;
      if (this.vx === 0) {
        this.mode = "stopped";
        if (this.cb.stop) this.cb.stop(this.x, this.y);
      }
    }

    _ditch(dt) {
      /* the glide: speed bleeds back to a steady gliding speed and the sink rate builds gently to a constant —
         the wings still fly. Near the water the pilot flares: the sink eases off before it touches down */
      const G = this.glide;
      this.vx = approach(this.vx, this.cruiseSpeed * G.speed, 0.9, dt);
      const sink = this.altitude > G.flareAlt ? G.sink : G.touchSink + (G.sink - G.touchSink) * (this.altitude / G.flareAlt);
      this.vy = approach(this.vy, sink, 1.6, dt);
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      if (this.y >= this.seaY - 1) {
        this.y = this.seaY - 1;
        this.mode = "sunk";
        if (this.cb.splash) this.cb.splash(this.x, this.y);
      }
    }

    /* the nose follows the flight path, plus any kick from a hit; it flattens for the flare and the rollout */
    _pitch(dt) {
      this.pitchKick = approach(this.pitchKick, 0, 3.2, dt);
      let target;
      if (this.mode === "rolling" || this.mode === "stopped") {
        /* back onto the tail wheel as it slows */
        target = this.groundPitch + (-0.1 - this.groundPitch) * (this.vx / this.cruiseSpeed);
      } else if (this.mode === "ditching" || this.mode === "sunk") {
        /* a glider's attitude: a little nose-down on the way, level for the flare */
        target = this.altitude > this.glide.flareAlt ? clamp(Math.atan2(this.vy, this.vx), -0.05, 0.3) : -0.04;
      } else {
        target = clamp(Math.atan2(this.vy, this.vx) * 1.1, -this.maxPitch, this.maxPitch) + this.pitchKick;
        if (this.mode === "landing") {
          /* the flare: in the last stretch before the wheels touch, the nose comes up to level */
          const left = this.landing.x - this.x;
          if (left < 34) target = target * (left / 34) - 0.1 * (1 - left / 34);
        }
      }
      this.rotation = approach(this.rotation, target, this.mode === "ditching" ? 3 : this.pitchRate, dt);
    }

    /* near the top of the sky the climb eases off rather than stopping dead */
    _softCeiling(y) {
      const soft = this.ceilingY + 10;
      return y >= soft ? y : soft - 10 * (1 - Math.exp(-(soft - y) / 10));
    }
  }

  global.PlanePhysicsController = PlanePhysicsController;
  if (typeof module !== "undefined" && module.exports) module.exports = PlanePhysicsController;
})(typeof window !== "undefined" ? window : globalThis);
