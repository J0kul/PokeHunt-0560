# PokeHunt — Co-op PvP + Shiny Editor Fix

## Goal
1. Fix broken shiny editor (React editor patches readable JS that game didn't load)
2. Add co-op PvP versus mode (host = normal run; opponent controls ALL enemies incl wild; manual moves + switch)
Gate: co-op works (lobby/join, manual battles) w/o breaking single-player; shiny edits visibly affect game; `bun run build` clean; deliver on running port.

## Phase 0 — Fix foundation [DONE]
- [x] Server alive on :8080, game.html 200
- [x] Confirmed live pokelike.xyz only serves obfuscated bundle (e9e84cb924, 2.45MB) — no readable source anywhere online
- [x] BOOT TEST: readable source (data→battle→cloud-save→map→endless→ui→game) boots CLEAN — full v2.0 menu, all globals, ZERO console errors
- [x] All 6 "missing" handlers exist at runtime — grep static analysis was WRONG. SOURCE IS NOT STALE, it's the real complete v2.0.
- [x] Engine verified: MOVE_POOL keyed by type, calcDamage/runBattleScreen/animateBattleVisually present, state has full run structure
- [x] game.html swap PERMANENT: now loads 7 readable scripts in order (bundle line replaced). Removed test-readable.html.
- [x] BUG 2 FOUND+FIXED: API PUBLIC_JS resolved to packages/public/js (one dir too high) -> all readjs/writejs 404. Fixed join('../..')->join('..') in src/api/index.ts.
- [x] Verified FULL round-trip: readjs game.js 200 -> patch shiny 0.01->0.5 -> writejs ok -> disk changed (7 lines) -> game serves patched -> RESTORED to 0.02:0.01

## ARCHITECTURE DECISION
- runBattle() = whole fight synchronous, UI replays detailedLog. INCOMPATIBLE with interactive PvP.
- Co-op = round-by-round loop reusing pure helpers (calcDamage, getEffectiveStat, applyStageChange, stageMultiplier).
- HOST AUTHORITATIVE: host runs real game state + resolves each round. Server = in-memory relay/store, polled ~1s.
- ALL co-op logic in NEW packages/web/public/js/coop.js (loaded last). Single-player byte-identical, co-op behind state.coop flag.

## Co-op confirmed design (user answered)
- Opponent controls moves+switching only for game-spawned enemies (no species pick)
- Timer default 60s, host-configurable; expiry -> auto highest-damage move
- Moves v1: pure damage moves + STAT-BOOST moves (Swords Dance/Nasty Plot/Dragon Dance/Calm Mind/Agility/Iron Defense etc). NO weather/hazards/multi-turn/status/OHKO/gimmick. Switch costs the turn.
- Lobbies in-memory Map, reset on restart. No login (clientId+username).
- Match end: winner screen, host decides next.

## Phase 1 — Server + netcode + lobby UI [IN PROGRESS]
- [ ] Server: in-memory lobbies Map; endpoints create/join/get/action/battle-sync under /coop
- [ ] Client netcode in coop.js: clientId (localStorage), username, poll loop ~1s
- [ ] Lobby UI: main-menu "Co-op" entry -> create (code) / join (code) screens

## Phase 2 — Co-op move system (in coop.js)
- [ ] Derive 2 damage moves/species from MOVE_POOL (STAB + coverage) + stat-boost moves
- [ ] Legendary signatures (Mewtwo Psystrike, Rayquaza Dragon Ascent, etc)

## Phase 3 — Co-op interactive battle screen (in coop.js)
- [ ] Round-by-round loop: both submit action, host resolves via pure helpers, broadcast, both animate
- [ ] Manual move buttons + switch UI (switch costs turn), 60s timer + auto highest-damage
- [ ] Winner screen; host decides next

## Phase 4 — Regression + build + deliver + git push
- [ ] Single-player byte-identical; co-op only via state.coop
- [ ] `bun run build` clean; deliver website on :8080; optional git push

## Key facts
- Readable src: js/{data.js(getBestMove L159,MOVE_POOL L44),battle.js(runBattle L129,calcDamage L39),game.js(initGame L96,runBattleScreen L2181,DOMContentLoaded L3282),map.js,ui.js(animateBattleVisually L2463),endless.js,cloud-save.js}
- Load order for readable: data,battle,cloud-save,map,endless,ui,game
- React editor: packages/web/src/web/pages/index.tsx (tabs money/shiny/nodes/moves/level)
- API: packages/web/src/api/index.ts (Hono basePath('api'): /ping /health /readjs/:file /writejs)
- Single-player MUST stay byte-identical; co-op behind state.coop flag
- game.html.bak = backup of original (loads bundle)
