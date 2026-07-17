# The Last Meridian — Strategic and Persistent Gameplay Design Brief

## Purpose

This document outlines how to evolve **The Last Meridian** from a simple mothership-versus-mothership arcade battle into a longer, more strategic, and potentially persistent multiplayer experience.

The key goal is to preserve the fast, direct-control arcade combat while adding strategic decisions around:

- Objectives
- Resource control
- Mothership systems
- Faction progression
- Persistent territory
- Match phases
- Player roles

The game should **not become a full real-time strategy game**. Players should continue spending most of their time flying ships, fighting enemies, escorting allies, capturing objectives, and attacking capital ships.

The central design principle is:

> **Strategy decides where the battle goes. Arcade skill decides who wins the fight.**

---

## 1. Core Gameplay Structure

The game should use two connected layers.

### 1.1 Battle Layer

This is the existing arcade combat experience.

Players directly control fighters and other ships while attempting to weaken and ultimately destroy the enemy mothership.

The battle layer should include:

- Dogfighting
- Escort missions
- Bomber runs
- Objective capture
- Capital-ship attacks
- Defensive operations
- Resource raids
- Loom-related events

### 1.2 Strategic Layer

The strategic layer determines:

- Which objectives matter
- What upgrades become available
- How the mothership changes during battle
- Which sector is controlled after the match
- What bonuses a faction receives
- How the larger war progresses

Players should interact with strategy through simple choices rather than complex menus.

Possible strategic interaction methods:

- Automatic upgrade thresholds
- Team voting
- Commander-selected upgrades
- Three-option upgrade choices during respawn
- Pre-match loadout decisions

---

## 2. Mothership Subsystems

The mothership should not function as only one large health bar.

Instead, divide it into destructible or disableable subsystems.

### Suggested Subsystems

#### Shield Generators

- Protect the main hull or command core
- Must be disabled before the final attack
- Can potentially recharge if not fully destroyed

#### Hangars

- Control fighter launch rates
- Affect player respawn times
- Determine which ship classes can be launched
- Can temporarily prevent heavy craft deployment

#### Engines

- Affect mothership movement
- Control retreat or repositioning
- May prevent escape at the end of the match
- Could affect turning or battlefield orientation

#### Weapons Arrays

- Provide automated defensive fire
- Protect important approach lanes
- Can be disabled to create safe attack corridors

#### Sensor Relays

- Reveal enemies
- Detect stealth craft
- Improve targeting range
- Reveal neutral objectives and Loom events

#### Command Core

- Final victory target
- Remains protected until key defenses are disabled
- Destruction ends the match

### Design Benefit

Subsystems create meaningful attack choices.

Examples:

- Destroying the enemy hangar slows reinforcements.
- Destroying a sensor relay enables stealth attacks.
- Destroying weapon arrays makes bomber runs safer.
- Destroying engines prevents the mothership from repositioning.
- Destroying shield generators exposes the command core.

---

## 3. Battlefield Objectives

Each battlefield should contain several neutral or contested objectives.

Players capture these locations through normal arcade gameplay.

### Suggested Objective Types

#### Mining Stations

- Generate raw materials
- Contribute to ship or mothership upgrades

#### Energy Relays

- Generate energy
- Power shields, abilities, and special weapons

#### Communications Arrays

- Improve team visibility
- Reveal enemy locations
- Reduce fog of war

#### Repair Platforms

- Repair friendly ships
- Repair mothership subsystems
- Serve as forward operating positions

#### Derelict Ships

- Can be salvaged
- May unlock temporary weapons or reinforcements
- Could contain random hazards

#### Loom Fragments

- Provide powerful temporary abilities
- May trigger unpredictable effects
- Can be contested by both factions

#### FTL Beacons

- Allow faster travel
- Enable forward deployment
- Create alternate attack routes

### Capture Rules

Possible capture implementation:

- A player must remain within the objective radius.
- Capture progress pauses when enemies are present.
- Multiple allies increase capture speed.
- Some objectives require destroying defenses first.
- Captured objectives can be recaptured.
- Ownership persists until the match ends.

---

## 4. Simplified Resource Economy

The game can borrow the strategic value of resources from games like StarCraft without adding workers, manual construction, or detailed base management.

### Resource Flow

1. Players capture resource objectives.
2. Controlled objectives generate resources automatically.
3. Resources are deposited into a shared faction pool.
4. Upgrades or reinforcements become available.
5. Players continue fighting while the economy operates in the background.

### Potential Resources

Keep the system simple.

#### Option A: One Resource

Use a single resource such as:

- Energy
- Command Points
- Strategic Power
- Meridian Resources

This is the simplest system to balance.

#### Option B: Two Resources

Use two resource types:

- **Energy** for abilities, shields, and support actions
- **Materials** for ships, repairs, and physical upgrades

Avoid adding more than two resource types in the first version.

### Resource Spending Options

Resources could be used to:

- Repair a mothership subsystem
- Strengthen shields
- Deploy a Breaker Gunship
- Deploy a Reaver Gunship
- Launch AI-controlled support fighters
- Activate a sensor sweep
- Build or activate defensive turrets
- Improve respawn speed
- Upgrade fighter weapons
- Charge a mothership superweapon
- Deploy temporary mines
- Reinforce a captured station

---

## 5. Match Phases

Longer battles should evolve naturally rather than feeling like the same activity repeated for thirty minutes.

A match can be divided into four phases.

## Phase 1: Reconnaissance

### Goals

- Scout the map
- Discover neutral objectives
- Capture early resource locations
- Identify enemy movements
- Locate Loom anomalies

### Gameplay

- Mostly light fighters
- Limited upgrades
- Smaller skirmishes
- High mobility

---

## Phase 2: Expansion

### Goals

- Secure resource stations
- Establish forward positions
- Unlock upgrades
- Defend captured territory

### Gameplay

- More coordinated team combat
- First support ships become available
- Stations and lanes become strategically important

---

## Phase 3: Raids

### Goals

- Attack enemy infrastructure
- Disable mothership subsystems
- Escort bombers
- Disrupt resource generation
- Defend friendly objectives

### Gameplay

- Heavy fighters and gunships appear
- Bomber and escort roles become important
- Strategic attacks begin to shape the final outcome

---

## Phase 4: Final Assault

### Goals

- Disable the remaining shield systems
- Open a path to the command core
- Launch a coordinated mothership attack
- Prevent the enemy from recovering

### Gameplay

- Concentrated combat around the mothership
- High-value abilities become available
- Defensive systems are weakened or destroyed
- The match reaches a clear climax

### Suggested Match Duration

Target approximately:

- Short mode: 10–15 minutes
- Standard mode: 20–30 minutes
- Extended campaign battle: 30–45 minutes

---

## 6. Dynamic Events

Dynamic events should interrupt predictable match patterns.

The Loom is an ideal narrative explanation for these events.

### Event Examples

#### Loom Fragment Activation

- A fragment appears or awakens
- Both factions race to control it
- The winner receives a powerful temporary ability

#### FTL Corridor Opening

- A temporary shortcut appears
- Allows access behind enemy lines
- Creates a new attack route

#### Solar Storm

- Disables sensors
- Reduces targeting range
- Makes stealth and close-range combat more important

#### Derelict Cruiser

- A damaged capital ship appears
- Can be repaired or salvaged
- May become a temporary allied unit

#### Rogue Defense Station

- Activates and attacks both factions
- Can be destroyed or hacked
- Rewards the faction that gains control

#### Civilian or Supply Convoy

- One team must escort it
- The opposing team can intercept it
- Successful delivery provides resources or reinforcements

#### Loom Interference

- Temporarily alters ship controls, weapons, shields, or targeting
- Should be clearly telegraphed
- Must not feel random or unfair

### Event Design Rules

- Events should create opportunities, not simply punish players.
- Players should receive clear warnings.
- Events should have visible objectives.
- Events should usually benefit the faction that responds best.
- Avoid effects that remove player control for long periods.

---

## 7. Player Roles

Players should have different ways to contribute.

Every role should still involve direct ship control.

### Interceptor

Purpose:

- Hunt enemy fighters
- Protect bombers
- Respond quickly to threatened objectives

Characteristics:

- Fast
- Agile
- Lightly armored
- Strong against fighters

### Bomber

Purpose:

- Attack mothership subsystems
- Destroy stations
- Damage capital ships

Characteristics:

- Heavy weapons
- Lower maneuverability
- Requires escort

### Escort

Purpose:

- Protect bombers, transports, and support ships
- Defend vulnerable teammates

Characteristics:

- Balanced weapons
- Defensive abilities
- Strong team utility

### Scout

Purpose:

- Discover objectives
- Reveal enemies
- Capture distant points

Characteristics:

- High speed
- Long-range sensors
- Low durability

### Engineer or Support Pilot

Purpose:

- Repair ships
- Reinforce stations
- Restore disabled systems

Characteristics:

- Repair beams or drones
- Defensive tools
- Limited direct damage

### Gunship Pilot

Purpose:

- Attack large targets
- Hold territory
- Provide heavy fire support

Characteristics:

- High durability
- Heavy weapons
- Low speed

### Saboteur

Purpose:

- Infiltrate enemy defenses
- Disable sensors or weapons
- Attack vulnerable subsystems

Characteristics:

- Stealth or electronic warfare
- Precision damage
- Limited survivability when detected

---

## 8. Persistence Models

Persistence can be added in stages.

## 8.1 Match Persistence

This is the easiest form of persistence.

The following remain active for the duration of the current match:

- Captured stations
- Resource production
- Mothership damage
- Disabled subsystems
- Team upgrades
- Deployed structures
- Loom effects

This should be implemented first.

---

## 8.2 Player Progression

Players can unlock additional options over time.

Focus on sidegrades rather than permanent power advantages.

### Possible Unlocks

- Alternate fighter variants
- Weapon loadouts
- Support abilities
- Cosmetic ship modifications
- Pilot titles
- Faction insignia
- Alternate Spitfire configurations
- Alternate Wraith configurations
- Alternate Breaker configurations
- Alternate Reaver configurations

### Progression Rule

Veteran players should have more choices, not simply stronger ships.

Avoid:

- Permanent damage bonuses
- Permanent shield advantages
- Large stat differences
- Pay-to-win upgrades

---

## 8.3 Persistent Faction War

Each multiplayer match changes a larger strategic map of the Last Meridian.

### Sector Map

The map may contain:

- Colonies
- Resource fields
- Dead stations
- FTL routes
- Loom ruins
- Defensive lines
- Unexplored sectors

### Match Consequences

A victory may:

- Capture a sector
- Defend a sector
- Unlock an adjacent sector
- Damage an enemy stronghold
- Reveal a Loom location
- Provide a faction-wide bonus

### Seasonal Structure

The war should reset periodically.

Suggested season length:

- Two weeks
- Four weeks
- Six weeks

At the end of a season:

- One faction wins the campaign
- Players receive cosmetic rewards
- The strategic map resets or changes
- A new Loom-related story chapter begins

This prevents one faction from permanently dominating.

---

## 8.4 Squadron Persistence

This is a later-stage feature.

Players can form squadrons or clans.

Possible squadron features:

- Shared insignia
- Squadron rankings
- Seasonal objectives
- Shared carrier
- Squadron achievement history
- Custom colour schemes
- Territory contribution score

Do not make squadron progression mandatory for normal play.

---

## 9. Recommended First Version

The first strategic version should remain small and testable.

### Minimum Strategic Battle Feature Set

1. Add three neutral capture stations.
2. Add one shared faction resource called Energy.
3. Captured stations automatically generate Energy.
4. Add four mothership subsystems.
5. Require two shield generators to be disabled before the core is vulnerable.
6. Add three automatic faction upgrade thresholds.
7. Add one Loom event per match.
8. Record the winning faction and sector.
9. Display sector ownership on a simple campaign map.

### Example Upgrade Thresholds

#### 100 Energy

Choose or automatically unlock:

- Faster respawn
- Sensor sweep
- Improved fighter shields

#### 250 Energy

Choose or automatically unlock:

- Support fighter wing
- Defensive turret activation
- Mothership subsystem repair

#### 500 Energy

Choose or automatically unlock:

- Breaker or Reaver Gunship deployment
- Mothership superweapon charge
- Large shield reinforcement

---

## 10. Suggested Mothership Layout

Each faction mothership should have equivalent gameplay systems with different visual presentation.

### Meridian Commonwealth

Possible systems:

- Port shield generator
- Starboard shield generator
- Spitfire hangar
- Breaker launch bay
- Main battery
- Command bridge

### Novari Ascendancy

Possible systems:

- Harmonic shield node
- Resonance shield node
- Wraith birthing chamber or launch chamber
- Reaver deployment chamber
- Choir weapon array
- Neural command core

The names and visuals can differ while the underlying gameplay remains balanced.

---

## 11. Victory Conditions

The primary victory condition should remain destruction of the opposing mothership.

### Recommended Sequence

1. Capture or contest battlefield objectives.
2. Generate resources.
3. Unlock stronger units and abilities.
4. Disable enemy defensive subsystems.
5. Destroy the required shield generators.
6. Expose the command core.
7. Destroy the command core.

### Optional Secondary Victory Conditions

These can be explored later:

- Force the enemy mothership to retreat
- Capture all strategic stations for a fixed time
- Complete a Loom activation sequence
- Deplete enemy reinforcements
- Escort a superweapon into firing range

The first version should use only the mothership destruction condition.

---

## 12. Comeback Mechanics

Long matches need mechanisms that prevent an early advantage from becoming unstoppable.

### Possible Comeback Systems

- Objectives closer to the losing team generate slightly more resources.
- Destroyed enemy ships drop salvage.
- A damaged mothership receives stronger defensive fire.
- The losing faction receives a temporary emergency mission.
- Loom events favour neutral or contested regions.
- Resource production has diminishing returns.
- The leading faction has longer reinforcement travel times.

### Design Rule

Comeback mechanics should create opportunities without making early success meaningless.

---

## 13. Avoiding Excessive Complexity

Do not initially add:

- Worker units
- Manual base construction
- Large technology trees
- Complicated crafting
- More than two resources
- Dozens of ship classes
- Detailed economic management
- Persistent stat advantages
- Long commander menus
- Player-controlled production queues

Each new strategic system should answer one of these questions:

- Does this create a reason to fly somewhere?
- Does this create a meaningful target?
- Does this create a team decision?
- Does this make the battle evolve?
- Does this support the story of the Last Meridian?

If the answer is no, the system may not belong in the game.

---

## 14. Technical Implementation Order

### Phase A: Objective Framework

Implement:

- Capture zones
- Ownership states
- Capture progress
- Contested state
- Objective UI
- Team notifications

### Phase B: Resource Framework

Implement:

- Shared faction resource
- Resource generation over time
- Resource UI
- Upgrade thresholds
- Server-authoritative resource state

### Phase C: Mothership Subsystems

Implement:

- Individual subsystem health
- Subsystem targeting
- Disabled states
- Shield dependency rules
- Core vulnerability rules
- Visual damage states

### Phase D: Upgrade System

Implement:

- Automatic upgrades first
- Team voting later
- Upgrade effects
- Upgrade notifications
- Balancing configuration

### Phase E: Dynamic Events

Implement:

- Event manager
- Timed event triggers
- One Loom event
- Objective markers
- Event rewards

### Phase F: Campaign Map

Implement:

- Sector definitions
- Sector ownership
- Match result persistence
- Faction totals
- Simple campaign UI
- Seasonal reset support

---

## 15. Suggested Data Model

The exact implementation will depend on the current architecture, but the following conceptual models may be useful.

### Match State

```ts
interface MatchState {
  matchId: string;
  sectorId: string;
  phase: "recon" | "expansion" | "raid" | "final_assault";
  humanEnergy: number;
  novariEnergy: number;
  objectives: ObjectiveState[];
  motherships: {
    human: MothershipState;
    novari: MothershipState;
  };
  activeEvent?: DynamicEventState;
  startedAt: number;
  endedAt?: number;
  winner?: "human" | "novari";
}
```

### Objective State

```ts
interface ObjectiveState {
  id: string;
  type: "energy" | "repair" | "sensor" | "loom" | "ftl";
  owner: "human" | "novari" | "neutral";
  captureProgress: number;
  contested: boolean;
  resourceRate: number;
}
```

### Mothership State

```ts
interface MothershipState {
  hullHealth: number;
  coreVulnerable: boolean;
  subsystems: MothershipSubsystemState[];
}
```

### Mothership Subsystem State

```ts
interface MothershipSubsystemState {
  id: string;
  type:
    | "shield_generator"
    | "hangar"
    | "engine"
    | "weapon_array"
    | "sensor_relay"
    | "command_core";
  health: number;
  maxHealth: number;
  disabled: boolean;
  destroyed: boolean;
}
```

### Campaign Sector

```ts
interface CampaignSector {
  id: string;
  name: string;
  owner: "human" | "novari" | "neutral";
  adjacentSectorIds: string[];
  strategicBonus?: string;
  loomFragmentPresent: boolean;
}
```

---

## 16. Server Authority Requirements

For multiplayer integrity, the server should control:

- Objective ownership
- Capture progress
- Resource generation
- Upgrade unlocks
- Mothership subsystem health
- Core vulnerability
- Dynamic event state
- Match phases
- Victory conditions
- Campaign sector ownership

Clients should display and predict state where appropriate, but they should not be authoritative for strategic systems.

---

## 17. Balancing Configuration

Important values should be data-driven rather than hardcoded.

Create configuration for:

- Capture time
- Resource generation rate
- Upgrade costs
- Upgrade effects
- Subsystem health
- Respawn delays
- Event timing
- Event rewards
- Match phase thresholds
- Gunship limits
- Repair rates
- Shield regeneration
- Comeback modifiers

A JSON or TypeScript configuration object should make balancing easier without requiring major code changes.

---

## 18. Success Criteria

The strategic expansion is successful if:

- Players still spend most of the match directly piloting ships.
- Players have meaningful reasons to move around the battlefield.
- Teams must decide what to attack and defend.
- A match develops through recognizable stages.
- Mothership attacks require preparation.
- Losing teams still have comeback opportunities.
- Different player roles feel useful.
- Match results contribute to a larger conflict.
- The Loom feels active and important to the universe.
- The game remains understandable to new players.

---

## 19. Final Recommended Direction

The recommended overall design is:

> A multiplayer arcade space battle with capture points, shared resources, destructible mothership subsystems, dynamic Loom events, and a persistent sector war.

The first implementation should avoid becoming a complete RTS.

Start with:

- Three capture points
- One resource
- Four mothership subsystems
- Three upgrade tiers
- One dynamic Loom event
- One persistent sector result

This provides a strong strategic foundation while protecting the identity of **The Last Meridian** as an arcade space combat game.
