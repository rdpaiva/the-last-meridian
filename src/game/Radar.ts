import type { Ship } from "./Ship";
import type { Mothership } from "./Mothership";
import type { Faction } from "./Faction";
import { GameConfig } from "./GameConfig";

/**
 * Basic tactical radar — a player-centered, north-up circular minimap drawn to
 * its own canvas in the bottom-right corner, redrawn every frame.
 *
 * Orientation matches the world camera (which does NOT rotate with the ship):
 * world +Z is up, +X is right. The player sits at the center as a heading
 * triangle; enemy fighters are dots and motherships are larger diamonds, all
 * faction-colored. Contacts beyond `rangeWorld` are clamped to the rim so the
 * player always gets a bearing to far things — most importantly the enemy
 * mothership objective.
 *
 * Read-only: it never feeds gameplay, so it's safe to draw straight from live
 * ship/mothership references each frame.
 */
export class Radar {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly sizePx: number;
  /** Center of the radar in CSS pixels (canvas is square). */
  private readonly center: number;
  /** World units → pixels. */
  private readonly scale: number;
  /** Drawable radius in pixels (a hair inside the canvas edge). */
  private readonly radiusPx: number;

  /** Canvas-friendly blip colors per faction (the emissive theme colors blow out). */
  private static readonly BLIP: Record<Faction, string> = {
    humans: "#89b4fa",
    machines: "#f38ba8",
  };

  constructor() {
    const cfg = GameConfig.radar;
    this.sizePx = cfg.sizePx;
    this.center = cfg.sizePx / 2;
    this.radiusPx = cfg.sizePx / 2 - 4;
    this.scale = this.radiusPx / cfg.rangeWorld;

    const canvas = document.createElement("canvas");
    canvas.id = "radar";
    // Backing store at device resolution for crisp blips; CSS size in logical px.
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cfg.sizePx * dpr;
    canvas.height = cfg.sizePx * dpr;
    canvas.style.position = "fixed";
    canvas.style.right = `${cfg.marginPx}px`;
    canvas.style.bottom = `${cfg.marginPx}px`;
    canvas.style.width = `${cfg.sizePx}px`;
    canvas.style.height = `${cfg.sizePx}px`;
    canvas.style.pointerEvents = "none";
    canvas.style.userSelect = "none";
    document.body.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("[Radar] 2D context unavailable");
    ctx.scale(dpr, dpr); // draw in logical pixels from here on
    this.ctx = ctx;
  }

  /**
   * Redraw the radar. `player` anchors the center; every other live ship and
   * both motherships are plotted relative to it.
   */
  update(
    player: Ship,
    shipsByFaction: Record<Faction, Ship[]>,
    motherships: Record<Faction, Mothership>,
  ): void {
    const ctx = this.ctx;
    const c = this.center;
    ctx.clearRect(0, 0, this.sizePx, this.sizePx);

    // Dish background + range ring + center crosshair.
    ctx.beginPath();
    ctx.arc(c, c, this.radiusPx, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(8, 11, 20, 0.55)";
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(120, 140, 200, 0.35)";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c, c, this.radiusPx * 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(120, 140, 200, 0.18)";
    ctx.stroke();

    // Motherships (drawn first so fighters sit on top): faction diamonds.
    this.plotDiamond(motherships.humans, player, "humans");
    this.plotDiamond(motherships.machines, player, "machines");

    // Fighters of both factions (the player is the center marker, not a blip).
    for (const faction of ["humans", "machines"] as Faction[]) {
      for (const ship of shipsByFaction[faction]) {
        if (ship === player || !ship.isAlive) continue;
        this.plotDot(ship.position.x - player.position.x, ship.position.z - player.position.z, faction);
      }
    }

    // Player heading triangle at center, pointing along rotationY.
    this.drawPlayer(player.rotationY, player.faction);
  }

  /** Maps a world offset (dx,dz) from the player to a clamped radar pixel point. */
  private project(dx: number, dz: number): { x: number; y: number; offEdge: boolean } {
    // +Z is up (screen -Y), +X is right.
    let px = dx * this.scale;
    let py = -dz * this.scale;
    const dist = Math.hypot(px, py);
    let offEdge = false;
    if (dist > this.radiusPx) {
      const k = this.radiusPx / dist;
      px *= k;
      py *= k;
      offEdge = true;
    }
    return { x: this.center + px, y: this.center + py, offEdge };
  }

  private plotDot(dx: number, dz: number, faction: Faction): void {
    const { x, y, offEdge } = this.project(dx, dz);
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, GameConfig.radar.fighterBlip, 0, Math.PI * 2);
    ctx.fillStyle = Radar.BLIP[faction];
    // Out-of-range contacts are dimmer so the rim doesn't read as "right here".
    ctx.globalAlpha = offEdge ? 0.55 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private plotDiamond(ms: Mothership, player: Ship, faction: Faction): void {
    if (!ms.isAlive) return;
    const { x, y, offEdge } = this.project(
      ms.position.x - player.position.x,
      ms.position.z - player.position.z,
    );
    const s = GameConfig.radar.mothershipBlip;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x, y - s);
    ctx.lineTo(x + s, y);
    ctx.lineTo(x, y + s);
    ctx.lineTo(x - s, y);
    ctx.closePath();
    ctx.fillStyle = Radar.BLIP[faction];
    ctx.globalAlpha = offEdge ? 0.7 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
    ctx.stroke();
  }

  private drawPlayer(rotationY: number, faction: Faction): void {
    const ctx = this.ctx;
    const c = this.center;
    const s = GameConfig.radar.playerMarker;
    // Forward (world +Z at rot 0) maps to screen up: (sin, -cos).
    const fx = Math.sin(rotationY);
    const fy = -Math.cos(rotationY);
    // Perpendicular for the triangle base.
    const px = -fy;
    const py = fx;
    ctx.beginPath();
    ctx.moveTo(c + fx * s, c + fy * s); // nose
    ctx.lineTo(c - fx * s * 0.6 + px * s * 0.7, c - fy * s * 0.6 + py * s * 0.7);
    ctx.lineTo(c - fx * s * 0.6 - px * s * 0.7, c - fy * s * 0.6 - py * s * 0.7);
    ctx.closePath();
    ctx.fillStyle = Radar.BLIP[faction];
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
