import { wrapAngle, type InputState } from "@space-duel/shared";

export const FLIGHT_SCHOOL_LESSONS = [
  "flight",
  "guns",
  "missile",
  "docking",
  "jump",
  "complete",
] as const;

export type FlightSchoolLesson = (typeof FLIGHT_SCHOOL_LESSONS)[number];

export interface FlightLessonChecklist {
  thrust: boolean;
  turn: boolean;
  strafe: boolean;
}

/**
 * Pure, deterministic course state. The DOM/game wrapper feeds it snapshots
 * and real sim events; keeping the rules here makes the tutorial progression
 * testable without Babylon or a browser.
 */
export class FlightSchoolProgress {
  lesson: FlightSchoolLesson = "flight";
  missileLaunched = false;
  readonly flight: FlightLessonChecklist = {
    thrust: false,
    turn: false,
    strafe: false,
  };

  private previousRotation: number | null = null;
  private accumulatedTurn = 0;
  private sawServicing = false;

  get lessonNumber(): number {
    const index = FLIGHT_SCHOOL_LESSONS.indexOf(this.lesson);
    return Math.min(index + 1, 5);
  }

  updateFlight(input: InputState, speed: number, rotationY: number): void {
    if (this.lesson !== "flight") return;

    if (input.thrust && speed >= 6) this.flight.thrust = true;
    if (input.strafeLeft || input.strafeRight) this.flight.strafe = true;

    if (this.previousRotation !== null) {
      const controlledTurn =
        input.rotateLeft ||
        input.rotateRight ||
        Math.abs(input.turn) > 0.05;
      if (controlledTurn) {
        this.accumulatedTurn += Math.abs(
          wrapAngle(rotationY - this.previousRotation),
        );
      }
    }
    this.previousRotation = rotationY;
    if (this.accumulatedTurn >= Math.PI / 3) this.flight.turn = true;

    if (this.flight.thrust && this.flight.turn && this.flight.strafe) {
      this.lesson = "guns";
    }
  }

  recordLaserHit(hitTargetDrone: boolean): void {
    if (this.lesson === "guns" && hitTargetDrone) this.lesson = "missile";
  }

  recordMissileLaunch(lockedToTargetDrone: boolean): void {
    if (this.lesson === "missile" && lockedToTargetDrone) {
      this.missileLaunched = true;
    }
  }

  recordMissileHit(hitTargetDrone: boolean): void {
    if (
      this.lesson === "missile" &&
      this.missileLaunched &&
      hitTargetDrone
    ) {
      this.lesson = "docking";
    }
  }

  updateDocking(serviceState: "servicing" | "docked" | null): void {
    if (this.lesson !== "docking") return;
    if (serviceState === "servicing") this.sawServicing = true;
    if (serviceState === "docked" && this.sawServicing) this.lesson = "jump";
  }

  recordJumpFired(): void {
    if (this.lesson === "jump") this.lesson = "complete";
  }
}
