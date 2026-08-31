import type {
  ControllerWorld,
  InputState,
  Mothership,
  Ship,
  ShipController,
  SimEventBus,
} from "@space-duel/shared";
import { markFlightSchoolComplete } from "./Loadout";
import {
  FLIGHT_SCHOOL_LESSONS,
  FlightSchoolProgress,
  type FlightSchoolLesson,
} from "./FlightSchoolProgress";

const IDLE_INPUT: InputState = {
  thrust: false,
  reverse: false,
  rotateLeft: false,
  rotateRight: false,
  turn: 0,
  strafeLeft: false,
  strafeRight: false,
  fire: false,
  fireMissile: false,
  jumpPressed: false,
  zoomIn: false,
  zoomOut: false,
};

/** A deliberately inert drone: real Ship target, no combat decisions. */
export class TrainingTargetController implements ShipController {
  update(_deltaSeconds: number, _self: Ship, _world: ControllerWorld): InputState {
    return IDLE_INPUT;
  }
}

interface FlightSchoolOptions {
  player: Ship;
  target: Ship;
  home: Mothership;
  input: InputState;
  events: SimEventBus;
  resetPlayerTrails(): void;
}

/**
 * Client-side instructor for the solo Flight School scenario. It never
 * simulates a substitute mechanic: it observes the real Ship and SimEventBus,
 * and only stages each exercise (target placement, service damage, jump range).
 */
export class FlightSchool {
  private readonly progress = new FlightSchoolProgress();
  private readonly root: HTMLDivElement;
  private lastRenderKey = "";
  private active = false;

  constructor(private readonly opts: FlightSchoolOptions) {
    this.root = document.createElement("div");
    this.root.id = "flight-school";
    this.root.className = "flight-school hidden";
    document.body.appendChild(this.root);

    // Nobody can die or accidentally end the exercise. Hits and ammo use are
    // still real, so weapon/service feedback remains representative.
    opts.player.debugInvulnerable = true;
    opts.target.debugInvulnerable = true;

    opts.events.on("laserHit", ({ target, shooter }) => {
      if (shooter !== opts.player) return;
      const before = this.progress.lesson;
      this.progress.recordLaserHit(target === opts.target);
      this.afterProgress(before);
    });
    opts.events.on("missileFired", ({ ship, target }) => {
      if (ship !== opts.player) return;
      const before = this.progress.lesson;
      this.progress.recordMissileLaunch(target === opts.target);
      // A ballistic practice shot should not strand the pilot with an empty
      // rack. It still visibly launches; restoring one round only makes the
      // exercise retryable.
      if (before === "missile" && target !== opts.target) {
        opts.player.missileAmmo = Math.max(1, opts.player.missileAmmo);
      }
      this.afterProgress(before);
      if (before === "missile" && target === opts.target) this.render(true);
    });
    opts.events.on("missileHit", ({ struck, shooter }) => {
      if (shooter !== opts.player) return;
      const before = this.progress.lesson;
      this.progress.recordMissileHit(struck === opts.target);
      this.afterProgress(before);
    });
    opts.events.on("jumpFired", ({ ship }) => {
      if (ship !== opts.player) return;
      const before = this.progress.lesson;
      this.progress.recordJumpFired();
      this.afterProgress(before);
    });
  }

  /** Called once per live gameplay frame, after the sim has advanced. */
  update(
    ready: boolean,
    serviceState: "servicing" | "docked" | null,
  ): void {
    if (!ready) return;
    if (!this.active) {
      this.active = true;
      this.root.classList.remove("hidden");
      this.render();
    }

    const before = this.progress.lesson;
    this.progress.updateFlight(
      this.opts.input,
      this.opts.player.speed,
      this.opts.player.rotationY,
    );
    this.progress.updateDocking(serviceState);
    this.afterProgress(before);

    // Docking copy includes live range/speed, so refresh it at HUD cadence.
    if (this.progress.lesson === "docking") this.render();
  }

  private afterProgress(before: FlightSchoolLesson): void {
    const after = this.progress.lesson;
    if (after === before) {
      if (after === "flight") this.render();
      return;
    }
    if (after === "guns") this.stageTargetDrone();
    if (after === "docking") this.prepareDockingLesson();
    if (after === "jump") this.prepareJumpLesson();
    if (after === "complete") markFlightSchoolComplete();
    this.render(true);
  }

  private stageTargetDrone(): void {
    const player = this.opts.player;
    const fwd = player.forward();
    const right = player.right();
    this.opts.target.position.set(
      player.position.x + fwd.x * 55 + right.x * 22,
      0,
      player.position.z + fwd.z * 55 + right.z * 22,
    );
    this.opts.target.velocity.set(0, 0, 0);
    this.opts.target.rotationY = player.rotationY + Math.PI;
  }

  private prepareDockingLesson(): void {
    const player = this.opts.player;
    player.hp = Math.max(1, player.maxHp * 0.55);
    player.cannonAmmo = Math.min(player.cannonAmmo, player.maxCannonAmmo * 0.2);
    player.missileAmmo = 0;

    // Clear the drone out of the carrier circuit. It remains a real sensor
    // contact, but far enough away that the docking lesson is visually quiet.
    const fwd = this.opts.home.getLaunchForward();
    this.opts.target.position.set(
      this.opts.home.position.x - fwd.x * 650,
      0,
      this.opts.home.position.z - fwd.z * 650,
    );
    this.opts.target.velocity.set(0, 0, 0);
  }

  private prepareJumpLesson(): void {
    const fwd = this.opts.home.getLaunchForward();
    const player = this.opts.player;
    // respawn() is the sim's clean full-state reset: it also clears any drive
    // cooldown caused by an inquisitive early J press, so the final lesson can
    // never be stranded behind a stale recharge timer.
    player.respawn(
      this.opts.home.position.x + fwd.x * 520,
      this.opts.home.position.z + fwd.z * 520,
      this.opts.home.rotationY,
    );
    this.opts.resetPlayerTrails();
  }

  private render(force = false): void {
    const lesson = this.progress.lesson;
    const dx = this.opts.player.position.x - this.opts.home.position.x;
    const dz = this.opts.player.position.z - this.opts.home.position.z;
    const renderKey =
      lesson === "flight"
        ? `${lesson}:${Number(this.progress.flight.thrust)}${Number(this.progress.flight.turn)}${Number(this.progress.flight.strafe)}`
        : lesson === "docking"
          ? `${lesson}:${Math.round(Math.hypot(dx, dz) / 10)}`
          : lesson;
    if (!force && renderKey === this.lastRenderKey) return;
    this.lastRenderKey = renderKey;

    const card = this.lessonCard(lesson);
    const dots = FLIGHT_SCHOOL_LESSONS.slice(0, 5)
      .map((id, index) => {
        const current = lesson === id;
        const complete =
          lesson === "complete" ||
          FLIGHT_SCHOOL_LESSONS.indexOf(lesson) > index;
        return `<span class="fs-dot${current ? " current" : ""}${complete ? " done" : ""}"></span>`;
      })
      .join("");

    this.root.innerHTML = `
      <section class="fs-card${lesson === "complete" ? " complete" : ""}">
        <div class="fs-topline">
          <span>FLIGHT SCHOOL</span>
          <span>${lesson === "complete" ? "COURSE COMPLETE" : `LESSON ${this.progress.lessonNumber} / 5`}</span>
        </div>
        <div class="fs-progress">${dots}</div>
        <h2>${card.title}</h2>
        <p>${card.body}</p>
        ${card.checklist ?? ""}
        <div class="fs-hint">${card.hint}</div>
        ${lesson === "complete" ? `<button id="flight-school-finish">RETURN TO MENU</button>` : ""}
      </section>`;

    this.root
      .querySelector<HTMLButtonElement>("#flight-school-finish")
      ?.addEventListener("click", () => window.location.reload());
  }

  private lessonCard(lesson: FlightSchoolLesson): {
    title: string;
    body: string;
    hint: string;
    checklist?: string;
  } {
    if (lesson === "flight") {
      const item = (done: boolean, label: string): string =>
        `<li class="${done ? "done" : ""}"><span>${done ? "✓" : "○"}</span>${label}</li>`;
      return {
        title: "Basic Flight",
        body: "Build speed, change your heading, then use lateral thrust without turning the nose.",
        hint: "W / RT THRUST · A/D, MOUSE OR STICK TURN · Q/E OR LB/RB STRAFE",
        checklist: `<ul class="fs-checklist">
          ${item(this.progress.flight.thrust, "Accelerate under forward thrust")}
          ${item(this.progress.flight.turn, "Turn through roughly 60°")}
          ${item(this.progress.flight.strafe, "Use a lateral thruster")}
        </ul>`,
      };
    }
    if (lesson === "guns") {
      return {
        title: "Gunnery",
        body: "The TARGET DRONE may begin outside your camera view. Find its red blip on the radar, turn and close until the marked drone is onscreen, then put one real cannon bolt on it.",
        hint: "RADAR BOTTOM-RIGHT · SPACE / LMB / GAMEPAD A — FIRE CANNON",
      };
    }
    if (lesson === "missile") {
      if (this.progress.missileLaunched) {
        return {
          title: "Missile Away",
          body: "The seeker is live. Keep the drone in view—or follow both contacts on the radar—and watch the missile complete its run.",
          hint: "HOLD COURSE · OBSERVE THE IMPACT",
        };
      }
      return {
        title: "Heat-Seeker Lock",
        body: "Point at the drone until the HUD lock row turns green, then launch. A seeker fired without LOCK will fly ballistic.",
        hint: "SHIFT / RMB / GAMEPAD X — LAUNCH ON GREEN LOCK",
      };
    }
    if (lesson === "docking") {
      const dx = this.opts.player.position.x - this.opts.home.position.x;
      const dz = this.opts.player.position.z - this.opts.home.position.z;
      const distance = Math.round(Math.hypot(dx, dz));
      return {
        title: "Carrier Service",
        body: `Your hull and magazines have been depleted. Return to your carrier's launch bays, slow below service speed, and remain docked until the HUD reads DOCKED. Carrier range: ${distance}u.`,
        hint: "APPROACH THE FRIENDLY CARRIER · REDUCE SPEED BELOW 7 U/S",
      };
    }
    if (lesson === "jump") {
      return {
        title: "Meridian Drive",
        body: "You have been repositioned deep in the training area. Arm the drive and survive the full spool; it will return you to your carrier's service ring.",
        hint: "J / GAMEPAD Y — ARM DRIVE · PRESS AGAIN BEFORE COMMIT TO CANCEL",
      };
    }
    return {
      title: "Flight Certification Earned",
      body: "You demonstrated flight control, cannon fire, missile lock, carrier service, and a Meridian jump. You're cleared for combat sorties.",
      hint: "FLIGHT SCHOOL REMAINS AVAILABLE FROM THE MODE SCREEN",
    };
  }
}
