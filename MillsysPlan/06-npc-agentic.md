# Phase 6: NPC Agentic Behavior

## Goal
Wire existing NPC planner to use live Gemma via `server/llm.js`.

## Files to Modify

### Modify: `server/sigmacraft-npc-agents.js`

#### Replace `callGemma` (lines 123-127)

```js
// REPLACE the throw with:
import { chat } from "./llm.js";
import { vNpcProposal } from "./validate.js";

async function callGemma(npcId, world, env) {
  const npc = NPCS[npcId];
  if (!npc) return makeNpcFallbackProposal(npcId, world);
  
  const rec = world.npcs?.[npcId] || {
    zoneId: npc.homeZone,
    schedulePhase: "wandering",
    moodValue: 50,
    recentIncidents: []
  };
  
  const playersHere = Object.entries(world.sigmacraft?.actorPlaces || {})
    .filter(([_, z]) => z === rec.zoneId).length;
  
  const prompt = buildNpcPrompt(npc, rec, playersHere, world);
  
  try {
    const raw = await chat([{ role: "user", content: prompt }], { 
      temp: 0.7, 
      maxTokens: 600 
    });
    
    const clean = vNpcProposal([raw])[0]; // Drops if invalid
    if (!clean) return makeNpcFallbackProposal(npcId, world);
    
    return { ...clean, source: "gemma" };
  } catch (e) {
    return makeNpcFallbackProposal(npcId, world);
  }
}
```

#### Prompt Builder

```js
function buildNpcPrompt(npc, rec, playersHere, world) {
  const zone = world?.zones?.[rec.zoneId] || { name: rec.zoneId, tier: 0 };
  const nearbyNpcs = Object.values(world?.npcs || {})
    .filter(n => n.zoneId === rec.zoneId)
    .map(n => NPCS[n.id]?.name || n.id)
    .join(", ");
  
  return `
You are ${npc.name} (${npc.role}, ${npc.factionId}).
Personality: ${npc.traitIds?.join(", ") || "neutral"}
Mood: ${dispositionForMood(rec.moodValue)} (${rec.moodValue}/100)
Location: ${zone.name} (tier ${zone.tier})
Players nearby: ${playersHere}
Nearby NPCs: ${nearbyNpcs || "none"}
Schedule: ${rec.schedulePhase}
Recent events: ${JSON.stringify(rec.recentIncidents?.slice(-3) || [])}
Current goal: ${rec.currentGoal || "none"}

Choose ONE action:
- move: { "kind": "move", "targetId": "zone_id" }
- talk: { "kind": "talk", "targetId": "npc_id" }
- craft: { "kind": "craft", "itemSpec": { "baseType": "vaal_axe", "intent": "faction_gear", "context": "player reached rank 3" }, "target": "drop|gift|market|vault", "recipient": "player_login" }
- market: { "kind": "market", "action": "buy|sell", "item": "item_id", "price": 1000 }

Output ONLY valid JSON:
{
  "goal": "string (max 96 chars)",
  "dialogue": "string (max 140 chars)",
  "step": { "kind": "move|talk|craft|market", ... }
}
`;
}
```

#### NPC Behavior Biases (optional — add to prompt or fallback)

```js
const NPC_BEHAVIORS = {
  kael: { // Quartermaster
    craftBias: true,
    preferredBases: ["vaal_axe", "plate_hauberk", "iron_hammer"],
    intent: "faction_gear"
  },
  vyre: { // Warbringer
    craftBias: true,
    preferredBases: ["coral_sword", "void_dagger", "hollow_greatsword"],
    intent: "war_weapons"
  },
  mireth: { // Loremaster
    craftBias: true,
    preferredBases: ["hollow_staff", "void_wand", "arcane_relic"],
    intent: "arcane_focus"
  },
  goldwyn: { // Merchant
    marketBias: true,
    preferredBases: ["coral_ring", "void_charm", "gold_relic"],
    intent: "profit_craft"
  },
  the_hollow: { // Oracle
    craftBias: true,
    preferredBases: ["abyssal_relic", "fate_charm", "doom_weapon"],
    intent: "prophetic_item"
  }
};
```

## Validation
- Uses existing `vNpcProposal` from `validate.js`
- `craft`/`market` step kinds already defined in `vNpcProposalStep`
- Drops invalid proposals → falls back to deterministic

## Integration
- NPC planner runs every 15s (supervised interval in `server.js`)
- Proposals stored in `world.sigmacraft.npcAgents[npcId]`
- Consumed by `sigmacraft.js` advance() — 1 per tick

## Testing
1. Set `NPC_PLANNER_LIVE=1` and `LLM_BASE_URL`
2. Observe feed: `npc_dialogue`, `narrative` with Gemma-generated content
3. NPCs propose `craft` steps → items generated via enrichment path
4. NPCs propose `market` steps → interact with market system