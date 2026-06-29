# SIGMA ABYSS — Vampire-Survivors combat layer (contract)

Authoritative contract for the VS combat layer. The `sigmashake-vcs` panel and
`sigmashake-chat-elixir` overlay slices consume this file. It is precise on
every endpoint shape, character-state field, weapon id + stats, the synergy
matrix, and the gem/combat-snapshot shape. Source of truth for the data:
`shared/vampire-survivors.js`. Server routes: `server/server.js`. Trust
boundary: `server/validate.js`. Bridge: `sigmashake-obs/src/lib/vcs-bridge.ts`.

The whole layer is **opt-in**: a sigma with an empty `weapons` loadout never
enters any VS code, draws zero RNG, and is byte-identical to a pre-VS character
(the determinism firewall). The layer turns on the moment `weapons` is non-empty.

---

## 1. MMO HTTP endpoints (port 7777)

### `GET /api/weapon-catalog`  (public, static)

The full static catalog + synergy/evolution matrix + tunables. No auth, no
per-player state. Mirrors `GET /api/passive-tree`.

```jsonc
{
  "ok": true,
  "tunables": { /* VS_TUNABLES — see §5 */ },
  "maxSlots": 6,
  "weapons": [ /* WeaponDef[] — see §4 */ ],
  "evolutions": [ /* Evolution[] — see §6 */ ]
}
```

### `GET /api/sigma/:login/weapons`  (mints/resolves the sigma)

Current loadout + the available pool + the evolutions the loadout currently
triggers + a live combat snapshot. Always 200 for a valid login (mints like
`GET /api/sigma`).

```jsonc
{
  "ok": true,
  "login": "somechatter",
  "weapons": ["whip", "garlic"],     // current loadout (ids, order = slots)
  "activeWeapon": "garlic",          // the slot lost on a faint (or null)
  "available": ["whip","wand", ...], // all 10 catalog ids (WEAPON_IDS)
  "maxSlots": 6,
  "evolutions": [ /* Evolution[] currently triggered — see §6 */ ],
  "fainted": 0,                       // lifetime faint count
  "lostWeapon": null,                 // last weapon lost to a faint (or null)
  "combat": {                          // live combat snapshot (overlay animates)
    "gems": [ /* Gem[] — see §3 */ ],
    "fainted": 0,
    "lostWeapon": null
  }
}
```

### `POST /api/sigma/:login/weapons`  (requires an existing sigma → 404 if absent)

Set the loadout. Mirrors `POST /api/sigma/:login/passives` (coerce, never
reject). Body:

```jsonc
{
  "weapons": ["whip", "garlic", "nova"],  // ids; unknown dropped, de-duped, slot-capped
  "set": "garlic"                          // OPTIONAL active-weapon id (the faint slot).
                                           // alias: "active". omitted -> first weapon.
}
```

Validation (`vCharacter` → `vWeapons`/`vWeaponId`): unknown ids dropped, list
de-duped, capped to `maxSlots` (6), and `activeWeapon` reconciled to be one of
`weapons` (or `null` when empty). Returns the **same body as the GET** above.

> `set` here is the **active-weapon id**, NOT a build set "A"/"B". (The passives
> endpoint's `set` is "A"/"B"; weapons are a single account-side loadout, not yet
> dual-spec partitioned.)

### `GET /api/sigma/:login`  (additions)

The character snapshot's `sigma` object gains:

```jsonc
{
  "weapons": ["whip","garlic"],   // string[]  — the loadout (ids)
  "activeWeapon": "garlic",       // string|null — the faint slot
  "evolutions": ["bloody_tear"],  // string[]  — triggered evolution IDs
  "gems": [ /* Gem[] */ ],        // Gem[]     — live combat snapshot
  "fainted": 0,                   // number    — lifetime faint count
  "lostWeapon": null              // string|null — last weapon lost to a faint
}
```

---

## 2. Character-state additions (field names / types)

### Account-side (survives permadeath, like passives) — `character.*`

| field          | type            | default | notes |
|----------------|-----------------|---------|-------|
| `weapons`      | `string[]`      | `[]`    | loadout ids; de-duped, capped to `VS_TUNABLES.maxWeaponSlots` (6) |
| `activeWeapon` | `string \| null`| `null`  | the slot lost on a faint; reconciled to be one of `weapons` |
| `lostWeapon`   | `string \| null`| `null`  | last weapon lost to a faint (read-only feedback) |
| `fainted`      | `number`        | `0`     | lifetime faint count |

### Run-side (transient combat state, erased on permadeath) — `character.run.*`

| field     | type      | default | notes |
|-----------|-----------|---------|-------|
| `gems`    | `Gem[]`   | `[]`    | in-flight XP gems; capped to `VS_TUNABLES.gemMaxLive` (64) |
| `gemSeq`  | `number`  | `0`     | per-run counter for deterministic gem ids |

Any field not listed in `vCharacter`/`vRun` is silently dropped on save — these
are the only new persisted fields.

---

## 3. Gem (XP pickup) shape

A gem is the Vampire-Survivors XP drop. On enemy death one gem spawns at the
enemy's deterministic arena position; each tick gems magnetize toward the player
(the arena center `0,0`) and are collected within `gemPickupRadius`, granting
their `value` as run XP (the chat XP / "Sigma token" economy).

**Snapshot shape** (`combat.gems` and `sigma.gems`):

```jsonc
{
  "id": "g7_3",   // string — stable id ("g<tickIdx>_<seq>")
  "x": 3.42,      // number — current x, arena units (player at 0,0)
  "y": -1.18,     // number — current y
  "tx": 0,        // number — magnet target x (always the player center)
  "ty": 0,        // number — magnet target y
  "value": 12     // number — run XP granted on pickup
}
```

The client animates motion **between** snapshots: each gem travels from its
last `(x,y)` toward `(tx,ty)`; a gem that disappears from one snapshot to the
next was collected (play the pickup pop + a `+value` XP float). Persisted gems
are bounded to `gemMaxLive` (64) and positions clamp to `±arenaRadius*2`.

---

## 4. Weapon catalog (10 auto-fire types)

`WeaponDef` fields: `id`, `name`, `kind`, `fireRate`, `damage`, `count`,
`pierce`, `area`, `returns`, `tags[]`, `desc`. Damage model (pure, no RNG):

```
perHit = round(fighter.attack * damage * fireRate * weaponBaseScale * (evolved ? evolvedMult : 1))
splash = (typeof area === "number" && area > 0) ? area : 0
enemiesTouched = area === "all" ? allLive : min(allLive, count + pierce + splash)
returns:true  -> each hit lands twice
```

| id          | name           | kind       | fireRate | damage | count | pierce | area | returns | tags |
|-------------|----------------|------------|----------|--------|-------|--------|------|---------|------|
| `whip`      | Whip           | arc        | 1.0  | 0.90 | 1 | 1 | 0     | no  | physical, melee |
| `wand`      | Magic Wand     | projectile | 1.0  | 1.00 | 1 | 0 | 0     | no  | arcane, ranged |
| `knife`     | Throwing Knife | pierce     | 1.4  | 0.70 | 2 | 2 | 0     | no  | physical, ranged |
| `garlic`    | Garlic Aura    | aura       | 0.7  | 0.45 | 1 | 0 | `all` | no  | holy, aura |
| `bible`     | Orbiting Tome  | orbit      | 0.85 | 0.80 | 3 | 1 | 0     | no  | holy, orbit |
| `nova`      | Frost Nova     | area       | 0.5  | 1.30 | 1 | 0 | `all` | no  | arcane, area |
| `beam`      | Lance Beam     | beam       | 0.6  | 1.60 | 1 | 3 | 0     | no  | arcane, beam |
| `boomerang` | Boomerang      | boomerang  | 0.9  | 0.90 | 1 | 1 | 0     | yes | physical, ranged |
| `fireball`  | Fireball       | projectile | 0.7  | 1.10 | 1 | 0 | 2     | no  | fire, ranged |
| `lightning` | Lightning Ring | strike     | 0.85 | 1.05 | 2 | 0 | 0     | no  | lightning, ranged |

Weapons fire automatically every combat tick — there is no manual aim. The
volley resolves AFTER the fighter's basic swings inside `resolveEncounter` and
emits one `{"t":"weapon","src":-1,"tgt":<enemyIdx>,"wid":<id>,"amt":<dmg>}`
combat event per hit (the overlay can render a weapon FX per event).

---

## 5. Tunables (`VS_TUNABLES`)

Single labeled block in `shared/vampire-survivors.js`. Also returned verbatim
under `tunables` in `GET /api/weapon-catalog`.

| key                     | value | meaning |
|-------------------------|-------|---------|
| `maxWeaponSlots`        | 6     | loadout size cap |
| `weaponBaseScale`       | 0.6   | global weapon-damage scale |
| `evolvedMult`           | 1.7   | evolved-weapon damage multiplier |
| `arenaRadius`           | 6     | enemy/gem spawn ring radius |
| `gemBaseValue`          | 4     | base XP per gem |
| `gemValuePerThreat`     | 2     | + XP per point of enemy threat |
| `gemEliteMult`          | 3     | elite gem value multiplier |
| `gemBossMult`           | 9     | boss gem value multiplier |
| `gemPickupRadius`       | 1.6   | collect distance |
| `gemMagnetStep`         | 0.6   | gem travel per magnetize frame |
| `gemMagnetFramesPerTick`| 6     | magnetize frames per delveTick |
| `gemMaxLive`            | 64    | persisted in-flight gem cap |
| `faintReviveHpFrac`     | 0.5   | HP fraction restored after a faint |

**Balancing note.** Faints are made reachable by the VS combat posture: a VS
sigma stands and fights (`fleeHpFrac` forced to 0) instead of the autopilot's
flee-at-32%-HP guard — that guard (plus the `MAX_HIT_FRAC = 0.33` alpha-strike
cap, death-saves and second-wind) is exactly why "not a single person has
fainted". Weapons + gems are the counter-balance: they make hard packs winnable,
so faints land at a reasonable rate rather than constantly. Tune the faint rate
via `weaponBaseScale`/`evolvedMult` (lower = more faints) and the gem economy via
the `gem*` knobs.

---

## 6. Synergy / evolution matrix (complete)

`Evolution` fields: `id`, `name`, `base` (a weapon id), `requires`
(`{weapon}` OR `{passive}`), `stats` (combat-field overrides for the resolved
form), optional `fireRate`, `desc`. An evolution triggers when the loadout
contains `base` AND its requirement (the partner weapon, or the allocated
passive keystone id). Passive keystone ids come from `shared/passive-tree.js`
(`KEYSTONE_IDS`).

`activeEvolutions(weapons, passives)` returns the triggered list;
`resolveLoadout(weapons, passives)` rewrites the `base` weapon's spec to the
evolved form (and marks `evolved:true`) for the volley.

| id                | name             | base        | requires (weapon / passive) | evolved damage | area |
|-------------------|------------------|-------------|-----------------------------|----------------|------|
| `bloody_tear`     | Bloody Tear      | `whip`      | weapon `garlic`             | 1.6 | all |
| `holy_wand`       | Holy Wand        | `wand`      | weapon `bible`              | 1.4 (fireRate 1.3) | 0 |
| `thousand_edge`   | Thousand Edge    | `knife`     | weapon `nova`               | 1.2 (count 5, pierce 5) | 0 |
| `soul_eater`      | Soul Eater       | `garlic`    | weapon `boomerang`          | 1.0 (fireRate 1.2) | all |
| `unholy_vespers`  | Unholy Vespers   | `bible`     | weapon `beam`               | 1.4 (count 4, pierce 2) | 0 |
| `hellfire`        | Hellfire         | `nova`      | weapon `fireball`           | 2.2 | all |
| `death_ray`       | Death Ray        | `beam`      | weapon `lightning`          | 2.4 (pierce 6) | 0 |
| `returning_storm` | Returning Storm  | `boomerang` | weapon `whip`               | 1.4 (count 2, returns) | 0 |
| `phoenix`         | Phoenix          | `fireball`  | weapon `wand`               | 1.6 (count 2) | 3 |
| `thunderbolt`     | Thunderbolt      | `lightning` | weapon `knife`              | 1.4 (count 4) | 0 |
| `glass_lance`     | Glass Lance      | `wand`      | passive `ks_glass_cannon`   | 2.0 (pierce 4) | 0 |
| `solar_flare`     | Solar Flare      | `nova`      | passive `ks_avatar_of_fire` | 2.6 | all |
| `sanguine_aura`   | Sanguine Aura    | `garlic`    | passive `ks_blood_magic`    | 1.5 (fireRate 1.1) | all |

When two evolutions share a base, the first in catalog order wins
(deterministic). Full `stats` per evolution are in `GET /api/weapon-catalog`.

---

## 7. Faint → lose the active weapon

When a VS sigma's HP hits 0 in a fight it **faints** instead of permadying:

1. It loses its **active** weapon (`activeWeapon`, else `weapons[0]`) — removed
   from `weapons`, recorded in `lostWeapon`, `fainted` incremented. This frees a
   slot for a different combo. The lost weapon is **re-acquirable** (just
   `POST .../weapons` it back).
2. It stands back up at `faintReviveHpFrac` (50%) HP and the tick returns as a
   `retreat` (reason `"faint"`, with a `faint` payload) so the caller banks the
   haul, heals in town and redeploys. **The run survives** (`run.alive` stays
   true) — only the active weapon is lost.

The `delveTick` faint return shape (server-internal, surfaced to the overlay via
the snapshot fields above):

```jsonc
{
  "type": "retreat",
  "reason": "faint",
  "faint": { "lostWeapon": "whip", "activeWeapon": "knife", "weapons": ["knife"] },
  "vs": { "collectedXp": 0, "collected": 0, "liveGems": 2 }
}
```

> Permadeath still applies for non-VS characters and for the rare
> vital-organ-loss / plague deaths (those are not combat HP-zero faints).

---

## 8. Bridge (sigmashake-obs/src/lib/vcs-bridge.ts)

Two RPC paths added to `MMO_PATHS`, mirroring `combat-passive*` exactly:

| VCS RPC path                          | method | → MMO endpoint |
|---------------------------------------|--------|----------------|
| `/api/v1/vcs/combat-weapon-catalog`   | GET    | `GET /api/weapon-catalog` (public static; no login) |
| `/api/v1/vcs/combat-weapons`          | GET    | `GET /api/sigma/:login/weapons` |
| `/api/v1/vcs/combat-weapons`          | POST   | `POST /api/sigma/:login/weapons` (body `{weapons, set}`) |

`combat-weapon-catalog` needs no login/source (like `combat-passive-tree`).
`combat-weapons` is Twitch-login-scoped (login injected by the worker from the
request body, never client-supplied), same as every other `combat-*` path. The
bridge fail-soft 502/504 behavior is unchanged.

---

## 9. Determinism firewall (for sim/offline parity)

- A character with empty `weapons` enters **no** VS code: no `ai` override,
  `fighter.weapons` unset, no gem harvest, no faint conversion → byte-identical
  to pre-VS. (Canary: the full unit suite + `server/smoke.js` stay green.)
- All VS combat math is **pure** (no `Math.random`, no `Date.now`): the weapon
  volley is deterministic arithmetic; gem spawn/magnetize use only
  `Math.cos/sin/hypot` + fixed steps.
- The gem harvest + faint run **post-RNG-save** (after `run.rngState = rng.state`)
  and draw zero RNG, so offline↔live parity holds for VS players too (same seed →
  identical outcome, verified in `test/unit/vampire-survivors.test.js`).
