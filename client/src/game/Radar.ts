import type { Ship } from "@space-duel/shared";
import type { Mothership } from "@space-duel/shared";
import type { AsteroidSim } from "@space-duel/shared";
import type { Missile } from "@space-duel/shared";
import { opposing, type Faction } from "@space-duel/shared";
import { GameConfig } from "@space-duel/shared";
import type { SensorContact, ConcealmentZone } from "@space-duel/shared";

/**
 * What the radar needs to draw one capture station — structurally satisfied
 * by the sim CaptureStation (offline) and NetworkGame's replicated
 * client-side copies (online).
 */
export interface StationBlip {
  position: { x: number; z: number };
  owner: Faction | null;
  capturingFaction: Faction | null;
  progress: number;
  contested: boolean;
}

/**
 * Tactical radar — a player-centered circular minimap drawn to its own
 * canvas in the bottom-right corner, redrawn every frame.
 *
 * Orientation matches the world camera (which does NOT rotate with the ship):
 * north-up (world +Z up, +X right) by default, or rotated 180° when the
 * player's view is flipped (`flipped` — the north-end pilot's camera looks
 * toward -Z, see CameraRig). Up on the radar is ALWAYS up on the screen.
 * The player sits at the center as a heading
 * triangle. FRIENDLY fighters draw from ground truth (your own wing shares
 * its telemetry); HOSTILE fighters draw from the player faction's SENSOR
 * PICTURE — fresh contacts are solid dots, lost contacts linger as fading
 * ghost rings at their last-known position, and ships that broke contact
 * (e.g. inside a nebula) simply aren't there. Motherships are always-known
 * diamonds (stationary, pre-briefed). Contacts beyond `rangeWorld` clamp to
 * the rim so the player always gets a bearing — most importantly to the
 * enemy mothership objective.
 *
 * Read-only: it never feeds gameplay, so it's safe to draw straight from live
 * ship/contact references each frame.
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

  /** +1 north-up, -1 when the view is flipped (mirrors both axes = 180°). */
  private readonly viewSign: number;

  constructor(flipped = false) {
    this.viewSign = flipped ? -1 : 1;
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
   * Redraw the radar. `player` anchors the center; `friendlies` are the
   * player faction's ships (ground truth), `contacts` the player faction's
   * sensor picture of the enemy, `missileThreats` the live enemy missiles
   * homing on the player (from MissileWarning).
   */
  update(
    player: Ship,
    friendlies: Ship[],
    contacts: SensorContact[],
    missileThreats: ReadonlyArray<Missile>,
    motherships: Record<Faction, Mothership>,
    asteroids: AsteroidSim[],
    nebulaZones: ReadonlyArray<ConcealmentZone>,
    stormZones: ReadonlyArray<ConcealmentZone>,
    /** Capture stations (strategic layer; empty on station-free maps).
     *  Structural — the sim CaptureStation and NetworkGame's replicated
     *  client-side copies both qualify. Always drawn (strategic beacons,
     *  not sensor-gated), owner-colored, blinking while contested. */
    stations: ReadonlyArray<StationBlip>,
    nowMs: number,
    /**
     * Ships flown by a HUMAN pilot right now (multiplayer honesty rule:
     * humans are tagged, bots are plain). Their blips get a white halo ring,
     * friend or foe. Omitted offline — everyone but you is a bot.
     */
    humanPiloted?: ReadonlySet<Ship>,
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

    // Nebula cover zones (terrain, under everything): faint violet discs so
    // the player can SEE where breaking contact is possible.
    for (const zone of nebulaZones) {
      this.plotZone(zone, player);
    }

    // Ion storm zones: electric-cyan discs matching the world clouds — the
    // "route around this or burn" read, distinct from the violet cover.
    for (const zone of stormZones) {
      this.plotStormZone(zone, player);
    }

    // Asteroids (terrain — drawn under the contacts). In-range only; clamping
    // ambient rocks to the rim would clutter the bearing to real contacts.
    for (const rock of asteroids) {
      if (!rock.isAlive) continue;
      this.plotRock(rock, player);
    }

    // Motherships (drawn first so fighters sit on top): faction diamonds.
    // Always shown — carriers are stationary and pre-briefed, not sensor-gated.
    this.plotDiamond(motherships.humans, player, "humans");
    this.plotDiamond(motherships.machines, player, "machines");

    // Capture stations: owner-colored squares (neutral = grey outline),
    // capture-progress arc while flipping, blink while contested.
    for (const st of stations) {
      this.plotStation(st, player, nowMs);
    }

    // Friendlies: ground truth (the wing shares its own telemetry).
    for (const ship of friendlies) {
      if (ship === player || !ship.isAlive) continue;
      this.plotDot(
        ship.position.x - player.position.x,
        ship.position.z - player.position.z,
        player.faction,
        1,
        false,
        humanPiloted?.has(ship) ?? false,
      );
    }

    // Hostiles: the sensor picture. Fresh = solid dot; stale = ghost ring
    // fading out over the track's memory window at its last-known position.
    const enemyFaction = opposing(player.faction);
    const memoryMs = GameConfig.sensors.memorySec * 1000;
    for (const contact of contacts) {
      if (!contact.isAlive) continue;
      if (contact.fresh) {
        this.plotDot(
          contact.position.x - player.position.x,
          contact.position.z - player.position.z,
          enemyFaction,
          1,
          false,
          humanPiloted?.has(contact.ship) ?? false,
        );
        // A detected hostile charging its jump drive gets a filling ring —
        // "how close is he to gone?" — the "kill the runner" telegraph
        // (docs/JUMP-DRIVE-AND-RESUPPLY.md → Detection).
        if (contact.ship.isSpoolingJump) {
          this.plotSpoolRing(
            contact.position.x - player.position.x,
            contact.position.z - player.position.z,
            contact.ship.jumpSpoolProgress,
          );
        }
      } else {
        const ageFrac = Math.min(1, (nowMs - contact.lastSeenMs) / memoryMs);
        this.plotDot(
          contact.position.x - player.position.x,
          contact.position.z - player.position.z,
          enemyFaction,
          0.7 * (1 - ageFrac) + 0.1,
          true,
        );
      }
    }

    // Inbound missiles — the warning's "from where?" cue, drawn on top of
    // everything but the player marker. Deliberately GROUND TRUTH, not the
    // sensor picture: these are rounds ALREADY homing on you (the RWR hears
    // their seeker), and a warning channel has to be reliable to be trusted.
    // Enemy missiles chasing someone else don't show — the blip means YOU.
    for (const missile of missileThreats) {
      this.plotMissile(missile, player);
    }

    // Your OWN jump spool gets the same filling ring around the center marker
    // (the clock both sides can read — here it's yours).
    if (player.isSpoolingJump) {
      this.plotSpoolRing(
        0,
        0,
        player.jumpSpoolProgress,
        GameConfig.radar.playerMarker + 4,
      );
    }

    // Player heading triangle at center, pointing along rotationY.
    this.drawPlayer(player.rotationY, player.faction);
  }

  /** Maps a world offset (dx,dz) from the player to a clamped radar pixel point. */
  private project(dx: number, dz: number): { x: number; y: number; offEdge: boolean } {
    // Default view: +Z is up (screen -Y), +X is right. viewSign mirrors both
    // axes for the flipped (north-end) view so the radar matches the screen.
    let px = dx * this.scale * this.viewSign;
    let py = -dz * this.scale * this.viewSign;
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

  /**
   * Filling ring around a spooling hostile's blip: a dim full ring (the
   * track) plus a bright alarm-colored arc sweeping clockwise from 12 o'clock
   * as the drive charges (0 → full at jump-fire). Both sides can read the
   * clock, so this is the shared "he's about to be gone" telegraph.
   */
  private plotSpoolRing(
    dx: number,
    dz: number,
    progress: number,
    radius = GameConfig.radar.fighterBlip + 4,
  ): void {
    const { x, y } = this.project(dx, dz);
    const ctx = this.ctx;
    const r = radius;
    const frac = Math.max(0, Math.min(1, progress));
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(243, 139, 168, 0.35)";
    ctx.stroke();
    const start = -Math.PI / 2; // 12 o'clock
    ctx.beginPath();
    ctx.arc(x, y, r, start, start + Math.PI * 2 * frac);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#f38ba8";
    ctx.stroke();
  }

  /**
   * One fighter blip. `ghost` draws a hollow ring (a stale last-known
   * position) instead of a solid dot; `alpha` carries the track's fade.
   */
  private plotDot(
    dx: number,
    dz: number,
    faction: Faction,
    alpha: number,
    ghost: boolean,
    human = false,
  ): void {
    const { x, y, offEdge } = this.project(dx, dz);
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, GameConfig.radar.fighterBlip, 0, Math.PI * 2);
    // Out-of-range contacts are dimmer so the rim doesn't read as "right here".
    ctx.globalAlpha = (offEdge ? 0.55 : 1) * alpha;
    if (ghost) {
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = Radar.BLIP[faction];
      ctx.stroke();
    } else {
      ctx.fillStyle = Radar.BLIP[faction];
      ctx.fill();
    }
    // Human-pilot halo (honesty rule): a white ring around the blip, friend
    // or foe — bots stay plain dots.
    if (human) {
      ctx.beginPath();
      ctx.arc(x, y, GameConfig.radar.fighterBlip + 2.5, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * One capture-station marker: a square (structure, distinct from fighter
   * dots / carrier diamonds), outlined grey while neutral and filled with
   * the owner's faction color once held; a capture arc sweeps around it
   * while a flip is in progress; contested = fast blink.
   */
  private plotStation(st: StationBlip, player: Ship, nowMs: number): void {
    const { x, y, offEdge } = this.project(
      st.position.x - player.position.x,
      st.position.z - player.position.z,
    );
    const ctx = this.ctx;
    const blink =
      st.contested && Math.floor(nowMs / 250) % 2 === 0 ? 0.35 : 1;
    ctx.globalAlpha = (offEdge ? 0.5 : 1) * blink;
    const s = 3.5;
    ctx.beginPath();
    ctx.rect(x - s, y - s, s * 2, s * 2);
    if (st.owner) {
      ctx.fillStyle = Radar.BLIP[st.owner];
      ctx.fill();
    }
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = st.owner ? Radar.BLIP[st.owner] : "rgba(200, 210, 230, 0.8)";
    ctx.stroke();
    // Capture meter: an arc in the capturing faction's color.
    if (st.capturingFaction && st.progress > 0) {
      const start = -Math.PI / 2;
      ctx.beginPath();
      ctx.arc(x, y, s + 3, start, start + Math.PI * 2 * Math.min(1, st.progress));
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = Radar.BLIP[st.capturingFaction];
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** Faint violet disc marking a nebula concealment zone. In-range only. */
  private plotZone(zone: ConcealmentZone, player: Ship): void {
    const { x, y, offEdge } = this.project(
      zone.x - player.position.x,
      zone.z - player.position.z,
    );
    if (offEdge) return;
    const r = Math.max(2, zone.radius * this.scale);
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(140, 90, 200, 0.16)";
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(160, 110, 220, 0.3)";
    ctx.stroke();
  }

  /** Electric-cyan disc marking an ion-storm damage zone. In-range only.
   *  Brighter stroke than the nebula discs — a hazard boundary should read
   *  crisper than cover. */
  private plotStormZone(zone: ConcealmentZone, player: Ship): void {
    const { x, y, offEdge } = this.project(
      zone.x - player.position.x,
      zone.z - player.position.z,
    );
    if (offEdge) return;
    const r = Math.max(2, zone.radius * this.scale);
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(70, 190, 240, 0.14)";
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(110, 220, 255, 0.5)";
    ctx.stroke();
  }

  /** Neutral grey dot for a rock, sized from its radius. In-range only. */
  private plotRock(rock: AsteroidSim, player: Ship): void {
    const { x, y, offEdge } = this.project(
      rock.position.x - player.position.x,
      rock.position.z - player.position.z,
    );
    if (offEdge) return;
    const r = Math.max(1.2, rock.radius * this.scale);
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(150, 144, 134, 0.55)";
    ctx.fill();
  }

  /**
   * Hot amber blip for an enemy missile homing on the player. Amber, not a
   * faction color — it reads as ORDNANCE, distinct from both sides' fighter
   * dots; the white rim makes the tiny dot pop against terrain underneath.
   * (Inbound missiles are always well inside radar range — the AI launch
   * envelope tops out far closer than the rim — so no off-edge dimming.)
   */
  private plotMissile(missile: Missile, player: Ship): void {
    const { x, y } = this.project(
      missile.position.x - player.position.x,
      missile.position.z - player.position.z,
    );
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, GameConfig.radar.missileBlip, 0, Math.PI * 2);
    ctx.fillStyle = "#fab387";
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
    ctx.stroke();
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
    // Forward (world +Z at rot 0) maps to screen up: (sin, -cos) — mirrored
    // by viewSign on the flipped view, same as project().
    const fx = Math.sin(rotationY) * this.viewSign;
    const fy = -Math.cos(rotationY) * this.viewSign;
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
