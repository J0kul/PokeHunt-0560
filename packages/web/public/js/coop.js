// coop.js — Co-op PvP versus mode (loaded LAST, after game.js).
//
// Design (see task.md): HOST plays a normal run. The OPPONENT (guest) controls
// every enemy team the game spawns (trainers, bosses, wild) — moves + switching
// only, no species picking. Single-player is byte-identical: everything here is
// gated behind `state.coop.active`, and runBattle()/the original runBattleScreen
// are never touched on the single-player path.
//
// Transport: short polling (~1s) against /api/coop (in-memory relay). Host is
// authoritative — it resolves each battle round with the same pure helpers the
// engine uses (calcDamage / getEffectiveStat / applyStageChange / stageMultiplier),
// pushes an authoritative snapshot to the guest, and both sides animate it.
//
// No login: a locally-generated clientId + a username identify each client.

(function () {
  'use strict';

  // ------------------------------------------------------------------ config
  const API = '/api/coop';
  const POLL_MS = 1000;
  const DEFAULT_TIMER = 60;

  // ------------------------------------------------------------- coop state
  // state.coop is created lazily; keep a module-local mirror for the netcode.
  const CO = {
    clientId: null,
    username: null,
    code: null,
    role: null,          // 'host' | 'guest'
    turnTimer: DEFAULT_TIMER,
    lastHostSeq: 0,      // last host2guest seq the guest processed
    lastGuestSeq: 0,     // last guest2host seq the host processed
    guestPoll: null,     // interval id for the guest's main loop
    lobbyPoll: null,     // interval id for the waiting-room refresh
    battleId: 0,         // increments per co-op battle
  };

  function getClientId() {
    if (CO.clientId) return CO.clientId;
    let id = null;
    try { id = localStorage.getItem('coop_client_id'); } catch (_) {}
    if (!id) {
      id = 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      try { localStorage.setItem('coop_client_id', id); } catch (_) {}
    }
    CO.clientId = id;
    return id;
  }

  // ------------------------------------------------------------- API helpers
  async function apiPost(path, body) {
    const res = await fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
    return json;
  }
  async function apiGetState(code) {
    const url = `${API}/state?code=${encodeURIComponent(code)}&clientId=${encodeURIComponent(getClientId())}`;
    const res = await fetch(url);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
    return json.view;
  }
  const pushSnapshot = (data) => apiPost('/snapshot', { clientId: getClientId(), code: CO.code, data });
  const pushAction = (data) => apiPost('/action', { clientId: getClientId(), code: CO.code, data });
  const setStatus = (status, turnTimer) => apiPost('/status', { clientId: getClientId(), code: CO.code, status, turnTimer });

  // =========================================================================
  // MOVE SYSTEM
  // Each Pokémon gets exactly 2 selectable moves:
  //   move 1 — its primary STAB damage move (the engine's getBestMove pick)
  //   move 2 — legendary signature, OR dual-type coverage, OR a stat-boost move
  // Only pure-damage + stat-boost moves (no weather/hazards/status/OHKO/gimmick).
  // =========================================================================

  const BOOST_MOVES = {
    swords_dance:  { name: 'Swords Dance',  boost: { atk: 2 },              desc: 'Sharply raises Attack.' },
    nasty_plot:    { name: 'Nasty Plot',    boost: { special: 2 },          desc: 'Sharply raises Sp. Atk.' },
    dragon_dance:  { name: 'Dragon Dance',  boost: { atk: 1, speed: 1 },    desc: 'Raises Attack and Speed.' },
    calm_mind:     { name: 'Calm Mind',     boost: { special: 1, spdef: 1 },desc: 'Raises Sp. Atk and Sp. Def.' },
    agility:       { name: 'Agility',       boost: { speed: 2 },            desc: 'Sharply raises Speed.' },
    iron_defense:  { name: 'Iron Defense',  boost: { def: 2 },              desc: 'Sharply raises Defense.' },
  };

  // Legendary signature 2nd moves (pure damage). speciesId -> move.
  const SIGNATURES = {
    150: { name: 'Psystrike',       power: 100, type: 'Psychic',  isSpecial: true },
    151: { name: 'Aura Sphere',     power: 80,  type: 'Fighting', isSpecial: true },
    144: { name: 'Blizzard',        power: 110, type: 'Ice',      isSpecial: true },
    145: { name: 'Thunder',         power: 110, type: 'Electric', isSpecial: true },
    146: { name: 'Fire Blast',      power: 110, type: 'Fire',     isSpecial: true },
    249: { name: 'Aeroblast',       power: 100, type: 'Flying',   isSpecial: true },
    250: { name: 'Sacred Fire',     power: 100, type: 'Fire',     isSpecial: false },
    382: { name: 'Origin Pulse',    power: 130, type: 'Water',    isSpecial: true },
    383: { name: 'Precipice Blades',power: 120, type: 'Ground',   isSpecial: false },
    384: { name: 'Dragon Ascent',   power: 120, type: 'Flying',   isSpecial: false },
    386: { name: 'Psycho Boost',    power: 140, type: 'Psychic',  isSpecial: true },
    483: { name: 'Roar of Time',    power: 120, type: 'Dragon',   isSpecial: true },
    484: { name: 'Spacial Rend',    power: 100, type: 'Dragon',   isSpecial: true },
    487: { name: 'Shadow Force',    power: 120, type: 'Ghost',    isSpecial: false },
    493: { name: 'Judgment',        power: 100, type: 'Normal',   isSpecial: true },
    643: { name: 'Blue Flare',      power: 130, type: 'Fire',     isSpecial: true },
    644: { name: 'Bolt Strike',     power: 130, type: 'Electric', isSpecial: false },
    646: { name: 'Ice Burn',        power: 130, type: 'Ice',      isSpecial: true },
    647: { name: 'Secret Sword',    power: 85,  type: 'Fighting', isSpecial: false },
    648: { name: 'Boomburst',       power: 140, type: 'Normal',   isSpecial: true },
    649: { name: 'Techno Blast',    power: 120, type: 'Steel',    isSpecial: true },
  };

  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();

  // Derive & cache the 2 co-op moves for a Pokémon instance.
  function getCoopMoves(pokemon) {
    if (pokemon._coopMoves) return pokemon._coopMoves;

    const types = pokemon.types || ['Normal'];
    const isSpecial = (pokemon.baseStats?.special || 0) >= (pokemon.baseStats?.atk || 0);
    const tier = Math.max(0, Math.min(2, pokemon.moveTier ?? 1));

    // Move 1 — the engine's default STAB damage move.
    const m1raw = getBestMove(types, pokemon.baseStats, pokemon.speciesId, tier, pokemon.heldItem);
    const move1 = { name: m1raw.name, power: m1raw.power || 0, type: m1raw.type || 'Normal',
                    isSpecial: !!m1raw.isSpecial, noDamage: !!m1raw.noDamage };

    // Move 2 — signature > coverage > stat-boost.
    let move2;
    const sig = SIGNATURES[pokemon.speciesId];
    if (sig) {
      move2 = { ...sig };
    } else {
      // Coverage: a damage move on a different type than move 1 (prefer 2nd type).
      const coverageType = types.map(cap).find((c) => c !== move1.type && MOVE_POOL[c]);
      if (coverageType) {
        const pool = isSpecial ? MOVE_POOL[coverageType].special : MOVE_POOL[coverageType].physical;
        const mv = pool[tier];
        move2 = { name: mv.name, power: mv.power, type: coverageType, isSpecial };
      } else {
        // Mono-type / no coverage → a stat-boost move fitting the attacker profile.
        const key = isSpecial ? 'nasty_plot' : 'swords_dance';
        const b = BOOST_MOVES[key];
        move2 = { name: b.name, boost: b.boost, isSpecial, noDamage: false, isBoost: true };
      }
    }
    // Fallback if move 1 is a no-damage gimmick (Splash/Teleport): give a real hit.
    if (move1.noDamage && !move2.isBoost) {
      // keep move2 as the damage option; add Struggle as move1
      move1.name = 'Struggle'; move1.power = 50; move1.type = 'Normal';
      move1.typeless = true; move1.noDamage = false;
    }

    pokemon._coopMoves = [move1, move2];
    return pokemon._coopMoves;
  }

  // Rough damage estimate for the turn-timer auto-pick (no RNG). Boost moves = 0.
  function estimateDamage(attacker, defender, move) {
    if (!move || move.isBoost || move.noDamage) return 0;
    const isSpecial = (attacker.baseStats?.special || 0) >= (attacker.baseStats?.atk || 0);
    const atk = getEffectiveStat(attacker, isSpecial ? 'special' : 'atk', attacker.heldItem ? [attacker.heldItem] : [], attacker.stages);
    const def = getEffectiveStat(defender, isSpecial ? 'spdef' : 'def', defender.heldItem ? [defender.heldItem] : [], defender.stages);
    const lvl = attacker.level;
    let dmg = Math.floor((2 * lvl / 5 + 2) * (move.power || 40) * atk / def / 50 + 2);
    const eff = move.typeless ? 1 : getTypeEffectiveness(move.type, defender.types || ['Normal']);
    dmg = Math.floor(dmg * eff);
    if ((attacker.types || []).some((t) => t.toLowerCase() === (move.type || '').toLowerCase())) dmg = Math.floor(dmg * 1.5);
    return dmg;
  }

  // Auto-pick the higher-damage move index (used on timer expiry).
  function autoMoveIdx(attacker, defender) {
    const moves = getCoopMoves(attacker);
    const d0 = estimateDamage(attacker, defender, moves[0]);
    const d1 = estimateDamage(attacker, defender, moves[1]);
    return d1 > d0 ? 1 : 0;
  }

  // =========================================================================
  // ROUND RESOLUTION (host-authoritative). Mirrors the engine's math but is
  // driven by the two chosen actions instead of getBestMove auto-selection.
  // Returns { events } — teams are mutated in place.
  // =========================================================================
  function firstAlive(team) { return team.findIndex((p) => p.currentHp > 0); }

  function ensureBattleState(p) {
    if (!p.stages) p.stages = { atk: 0, def: 0, speed: 0, special: 0, spdef: 0 };
    if (p.status === undefined) p.status = null;
    return p;
  }

  // action = { type:'move', moveIdx } | { type:'switch', targetIdx }
  function resolveRound(hostTeam, enemyTeam, hostAction, enemyAction) {
    const events = [];
    const hIdx = firstAlive(hostTeam);
    const eIdx = firstAlive(enemyTeam);
    if (hIdx < 0 || eIdx < 0) return { events };

    // --- Switches happen first and cost the turn for the switching side. ---
    const doSwitch = (team, side, action) => {
      if (!action || action.type !== 'switch') return false;
      const t = action.targetIdx;
      if (t == null || !team[t] || team[t].currentHp <= 0 || t === firstAlive(team)) return false;
      // Move the chosen Pokémon to the front-alive position by swapping.
      const cur = firstAlive(team);
      const tmp = team[cur]; team[cur] = team[t]; team[t] = tmp;
      ensureBattleState(team[cur]);
      events.push({ t: 'switch', side, name: team[cur].nickname || team[cur].name, idx: cur });
      return true;
    };
    const hSwitched = doSwitch(hostTeam, 'host', hostAction);
    const eSwitched = doSwitch(enemyTeam, 'enemy', enemyAction);

    // Recompute actives after any switch.
    const ha = hostTeam[firstAlive(hostTeam)];
    const ea = enemyTeam[firstAlive(enemyTeam)];
    ensureBattleState(ha); ensureBattleState(ea);

    // Build the ordered attack list (only sides that did NOT switch attack).
    const acts = [];
    if (!hSwitched) acts.push({ side: 'host', attacker: ha, target: ea, targetSide: 'enemy', action: hostAction, aTeam: hostTeam, tTeam: enemyTeam });
    if (!eSwitched) acts.push({ side: 'enemy', attacker: ea, target: ha, targetSide: 'host', action: enemyAction, aTeam: enemyTeam, tTeam: hostTeam });

    // Speed order (stages applied). Ties: host first.
    acts.sort((a, b) => {
      const sa = getEffectiveStat(a.attacker, 'speed', a.attacker.heldItem ? [a.attacker.heldItem] : [], a.attacker.stages);
      const sb = getEffectiveStat(b.attacker, 'speed', b.attacker.heldItem ? [b.attacker.heldItem] : [], b.attacker.stages);
      if (sa === sb) return a.side === 'host' ? -1 : 1;
      return sb - sa;
    });

    for (const act of acts) {
      const { side, attacker, target, targetSide } = act;
      if (attacker.currentHp <= 0 || target.currentHp <= 0) continue;
      const moves = getCoopMoves(attacker);
      let idx = act.action && act.action.type === 'move' ? act.action.moveIdx : autoMoveIdx(attacker, target);
      if (idx !== 0 && idx !== 1) idx = 0;
      const move = moves[idx];
      const aName = attacker.nickname || attacker.name;

      // Stat-boost move
      if (move.isBoost || move.boost) {
        for (const [stat, delta] of Object.entries(move.boost)) {
          applyStageChange(attacker, stat, delta, side, 0, /*log*/[]);
        }
        events.push({ t: 'boost', side, name: aName, moveName: move.name, boost: move.boost });
        continue;
      }

      // Damage move — reuse the engine's calcDamage for identical math.
      const aItems = attacker.heldItem ? [attacker.heldItem] : [];
      const tItems = target.heldItem ? [target.heldItem] : [];
      const { damage, typeEff, crit } = calcDamage(attacker, target, move, aItems, tItems);
      const before = target.currentHp;
      target.currentHp = Math.max(0, target.currentHp - damage);
      const tIdx = act.tTeam.indexOf(target);
      events.push({
        t: 'move', side, attackerName: aName, targetSide,
        moveName: move.name, moveType: move.type || 'Normal',
        damage, typeEff, crit, targetIdx: tIdx,
        targetName: target.nickname || target.name,
        targetHpBefore: before, targetHpAfter: target.currentHp,
        targetMaxHp: target.maxHp,
      });
      if (target.currentHp <= 0) {
        events.push({ t: 'faint', side: targetSide, idx: tIdx, name: target.nickname || target.name });
        // Send out the next alive Pokémon on the fainted side, if any.
        const next = firstAlive(act.tTeam);
        if (next >= 0) {
          const np = act.tTeam[next]; ensureBattleState(np);
          events.push({ t: 'sendout', side: targetSide, idx: next, name: np.nickname || np.name });
        }
      }
    }
    return { events };
  }

  // =========================================================================
  // SNAPSHOT SERIALIZATION — what the guest needs to render + choose.
  // =========================================================================
  function serTeam(team, withMoves) {
    return team.map((p) => {
      const o = {
        speciesId: p.speciesId, name: p.name, nickname: p.nickname || null,
        level: p.level, currentHp: p.currentHp, maxHp: p.maxHp,
        spriteUrl: p.spriteUrl || '', types: p.types || ['Normal'],
        isShiny: !!p.isShiny, baseStats: p.baseStats,
        stages: p.stages || null,
      };
      if (withMoves) o.moves = getCoopMoves(p).map((m) => ({
        name: m.name, power: m.power || 0, type: m.type || null,
        isBoost: !!(m.isBoost || m.boost), boost: m.boost || null,
      }));
      return o;
    });
  }

  // =========================================================================
  // COOP BATTLE — HOST SIDE (interactive, replaces the auto-sim for co-op).
  // Reproduces the original runBattleScreen's post-battle flow so single-player
  // stays untouched but co-op battles are round-by-round + guest-controlled.
  // =========================================================================
  async function runCoopHostBattle(origFn, enemyTeam, isBoss, onWin, onLose, enemyName, enemyItems, baseGainOverride, showPlayerPortrait, traitsConfig, forceAllParticipants) {
    const battleGen = runGeneration;
    const aborted = () => battleGen !== runGeneration;
    state._escapedViaRope = false;

    const bId = ++CO.battleId;
    showScreen('battle-screen');
    const showPlayer = showPlayerPortrait !== null && showPlayerPortrait !== undefined ? showPlayerPortrait : !!(isBoss || enemyName);
    renderTrainerIcons(state.trainer, enemyName || null, showPlayer);

    // Working copies (host authoritative). Host team = the run team.
    const hostTeam = state.team.map((p) => ensureBattleState({ ...p, stages: null, status: null }));
    const eTeam = enemyTeam.map((p) => ensureBattleState({
      ...p,
      currentHp: p.currentHp !== undefined ? p.currentHp : calcHp(p.baseStats.hp, p.level),
      maxHp: p.maxHp !== undefined ? p.maxHp : calcHp(p.baseStats.hp, p.level),
      stages: null, status: null,
    }));

    renderBattleField(hostTeam, eTeam);
    coopMountBattleUI('host');

    const participants = new Set();
    const MAX_ROUNDS = 300;
    let round = 0;
    let playerWon = false;

    // Announce start to guest.
    await pushSnapshot({ kind: 'battle_start', battleId: bId, enemyName: enemyName || null,
      hostTeam: serTeam(hostTeam, false), enemyTeam: serTeam(eTeam, true), turnTimer: CO.turnTimer }).catch(() => {});

    while (hostTeam.some((p) => p.currentHp > 0) && eTeam.some((p) => p.currentHp > 0) && round < MAX_ROUNDS) {
      round++;
      if (aborted()) return;
      const hIdx = firstAlive(hostTeam);
      participants.add(hIdx);

      // Ask the guest to submit the enemy's action for this round.
      await pushSnapshot({ kind: 'await_actions', battleId: bId, round,
        hostTeam: serTeam(hostTeam, false), enemyTeam: serTeam(eTeam, true),
        activeHostIdx: hIdx, activeEnemyIdx: firstAlive(eTeam), turnTimer: CO.turnTimer }).catch(() => {});

      // Host picks its own action via the UI (with timer); guest action arrives via poll.
      const hostAction = await coopHostChooseAction(hostTeam, eTeam, round);
      if (aborted()) return;
      const enemyAction = await coopWaitGuestAction(bId, round, eTeam, hostTeam);
      if (aborted()) return;

      const { events } = resolveRound(hostTeam, eTeam, hostAction, enemyAction);

      // Broadcast the resolved round, then both animate.
      await pushSnapshot({ kind: 'round_result', battleId: bId, round, events,
        hostTeam: serTeam(hostTeam, false), enemyTeam: serTeam(eTeam, true) }).catch(() => {});
      await coopAnimateRound(events, hostTeam, eTeam, 'host');
      if (aborted()) return;
    }

    playerWon = hostTeam.some((p) => p.currentHp > 0);
    coopUnmountBattleUI();
    renderBattleField(hostTeam, eTeam);

    // Tell the guest the outcome (from the guest's POV: enemyWon = !playerWon).
    await pushSnapshot({ kind: 'battle_end', battleId: bId, hostWon: playerWon,
      hostTeam: serTeam(hostTeam, false), enemyTeam: serTeam(eTeam, true) }).catch(() => {});

    // ---- Post-battle flow (mirrors original runBattleScreen) ----
    const skipBtn = document.getElementById('btn-auto-battle');
    if (skipBtn) skipBtn.style.display = 'none';
    const continueEl = document.getElementById('btn-continue-battle');

    if (playerWon) {
      for (let i = 0; i < state.team.length; i++) if (hostTeam[i]) state.team[i].currentHp = hostTeam[i].currentHp;
      const maxEnemyLevel = Math.max(...eTeam.map((p) => p.level));
      const effectiveParticipants = forceAllParticipants ? new Set(state.team.map((_, i) => i)) : participants;
      const levelUps = applyLevelGain(state.team, state.nuzlockeMode ? [] : state.items, effectiveParticipants, maxEnemyLevel, state.nuzlockeMode, baseGainOverride, state.isEndlessMode ? Infinity : 100);
      await animateLevelUp(levelUps);
      if (aborted()) return;

      if (state.nuzlockeMode && enemyName !== 'silver') {
        const fainted = state.team.filter((p) => p.currentHp <= 0);
        for (const p of fainted) if (p.heldItem) state.items.push(p.heldItem);
        state.team = state.team.filter((p) => p.currentHp > 0);
        if (fainted.length > 0) { renderTeamBar(state.team); renderItemBadges(state.items); }
        if (state.team.length === 0) { showGameOver(); return false; }
      }
      await checkAndEvolveTeam();
      if (aborted()) return;
      // Clear per-battle move caches so evolutions/new stats re-derive moves.
      for (const p of state.team) delete p._coopMoves;
      if (onWin) onWin();
      await coopWaiting();
      return true;
    } else {
      // Escape Rope (non-boss, non-endless, non-nuzlocke) — same as single-player.
      const ropeIdx = (!isBoss && !state.isEndlessMode && !state.nuzlockeMode)
        ? state.items.findIndex((it) => it.id === 'escape_rope') : -1;
      if (ropeIdx !== -1) {
        state.items.splice(ropeIdx, 1);
        for (const p of state.team) p.currentHp = 0;
        const lastIdx = state.team.length - 1;
        if (state.team[lastIdx]) state.team[lastIdx].currentHp = 1;
        renderTeamBar(state.team); renderItemBadges(state.items);
        state._escapedViaRope = true;
        if (onWin) onWin();
        await coopWaiting();
        return true;
      }
      if (onLose) onLose();
      await coopWaiting();
      return false;
    }
  }

  // Host: wait for the guest's action for (battleId, round). Falls back to an
  // auto highest-damage move if the guest never answers within a grace window
  // (2× the turn timer) so a disconnected guest can't freeze the host forever.
  function coopWaitGuestAction(battleId, round, enemyTeam, hostTeam) {
    return new Promise((resolve) => {
      const startSeq = CO.lastGuestSeq;
      const grace = (CO.turnTimer * 2 + 5) * 1000;
      const t0 = Date.now();
      const tick = async () => {
        try {
          const view = await apiGetState(CO.code);
          const ch = view && view.guest2host;
          if (ch && ch.seq > startSeq && ch.data && ch.data.kind === 'action'
              && ch.data.battleId === battleId && ch.data.round === round) {
            CO.lastGuestSeq = ch.seq;
            clearInterval(iv);
            resolve(validateEnemyAction(ch.data.action, enemyTeam, hostTeam));
            return;
          }
        } catch (_) {}
        if (Date.now() - t0 > grace) {
          clearInterval(iv);
          resolve({ type: 'move', moveIdx: autoMoveIdx(enemyTeam[firstAlive(enemyTeam)], hostTeam[firstAlive(hostTeam)]) });
        }
      };
      const iv = setInterval(tick, POLL_MS);
      tick();
    });
  }

  function validateEnemyAction(action, enemyTeam, hostTeam) {
    if (action && action.type === 'switch') {
      const t = action.targetIdx;
      if (enemyTeam[t] && enemyTeam[t].currentHp > 0 && t !== firstAlive(enemyTeam)) return action;
      // invalid switch -> auto move
    }
    if (action && action.type === 'move' && (action.moveIdx === 0 || action.moveIdx === 1)) return action;
    return { type: 'move', moveIdx: autoMoveIdx(enemyTeam[firstAlive(enemyTeam)], hostTeam[firstAlive(hostTeam)]) };
  }

  // =========================================================================
  // GUEST SIDE — main poll loop + battle rendering + action submission.
  // The guest never runs the map; it renders host snapshots and controls the
  // enemy team.
  // =========================================================================
  let guestBattleState = null; // { battleId, round, awaiting }

  function startGuestLoop() {
    if (CO.guestPoll) return;
    CO.guestPoll = setInterval(guestPollTick, POLL_MS);
    guestPollTick();
  }
  function stopGuestLoop() { if (CO.guestPoll) { clearInterval(CO.guestPoll); CO.guestPoll = null; } }

  async function guestPollTick() {
    let view;
    try { view = await apiGetState(CO.code); } catch (_) { return; }
    if (!view) return;
    if (view.status === 'ended') { showCoopScreen('coop-guest-waiting', 'The host ended the match.'); return; }
    const ch = view.host2guest;
    if (!ch || ch.seq <= CO.lastHostSeq || !ch.data) return;
    CO.lastHostSeq = ch.seq;
    handleHostSnapshot(ch.data);
  }

  function handleHostSnapshot(snap) {
    switch (snap.kind) {
      case 'waiting':
        guestBattleState = null;
        showCoopScreen('coop-guest-waiting', snap.msg || 'Waiting for the host…');
        break;
      case 'battle_start':
        guestBattleState = { battleId: snap.battleId };
        renderGuestBattle(snap, 'The battle begins!');
        break;
      case 'await_actions':
        guestBattleState = { battleId: snap.battleId, round: snap.round, awaiting: true };
        renderGuestBattle(snap, `Round ${snap.round} — choose the enemy's move!`);
        startGuestActionTimer(snap);
        break;
      case 'round_result':
        clearGuestTimer();
        renderGuestRoundResult(snap);
        break;
      case 'battle_end':
        clearGuestTimer();
        renderGuestBattle(snap, snap.hostWon ? 'The host won this battle.' : 'You defeated the host\'s team!');
        break;
    }
  }

  // ------------------------------------------------------------- guest render
  function renderGuestBattle(snap, caption) {
    showCoopScreen('coop-guest-battle');
    // Guest sees the enemy team as "theirs" (left) and host team as opponent (right).
    const mine = document.getElementById('coop-g-my-side');
    const foe = document.getElementById('coop-g-foe-side');
    const eTeam = snap.enemyTeam || guestBattleState?._enemyTeam || [];
    const hTeam = snap.hostTeam || [];
    if (snap.enemyTeam) guestBattleState._enemyTeam = snap.enemyTeam;
    if (mine) mine.innerHTML = coopSideHtml(eTeam, true);
    if (foe) foe.innerHTML = coopSideHtml(hTeam, false);
    const cap = document.getElementById('coop-g-caption');
    if (cap && caption) cap.textContent = caption;
    // Action buttons only while awaiting.
    const controls = document.getElementById('coop-g-controls');
    if (!controls) return;
    if (snap.kind === 'await_actions') {
      controls.style.display = '';
      renderGuestControls(snap);
    } else {
      controls.style.display = 'none';
    }
  }

  function coopSideHtml(team, mine) {
    const activeIdx = team.findIndex((p) => p.currentHp > 0);
    return team.map((p, i) => {
      const fainted = p.currentHp <= 0;
      const active = i === activeIdx;
      return `<div class="battle-pokemon ${fainted ? 'fainted' : ''} ${active ? 'active-pokemon' : ''}">
        <div class="battle-poke-name">${p.nickname || p.name} Lv${p.level}</div>
        <div class="poke-hp">${renderHpBar(p.currentHp, p.maxHp)}</div>
        <img src="${p.spriteUrl || ''}" alt="${p.name}" class="battle-sprite" onerror="this.src=''">
      </div>`;
    }).join('');
  }

  function renderGuestControls(snap) {
    const eTeam = snap.enemyTeam;
    const activeIdx = snap.activeEnemyIdx != null ? snap.activeEnemyIdx : eTeam.findIndex((p) => p.currentHp > 0);
    const active = eTeam[activeIdx];
    const moveWrap = document.getElementById('coop-g-moves');
    const switchWrap = document.getElementById('coop-g-switches');
    if (!active) return;
    moveWrap.innerHTML = (active.moves || []).map((m, i) => {
      const label = m.isBoost ? '↑ ' + m.name : `${m.name}`;
      const meta = m.isBoost ? 'Boost' : `${m.type} · ${m.power}`;
      return `<button class="btn-primary btn-md coop-move-btn" data-move="${i}">
        <span class="coop-move-name">${label}</span><span class="coop-move-meta">${meta}</span></button>`;
    }).join('');
    moveWrap.querySelectorAll('.coop-move-btn').forEach((b) => {
      b.onclick = () => submitGuestAction({ type: 'move', moveIdx: Number(b.dataset.move) });
    });
    // Switch options (alive, non-active).
    const benched = eTeam.map((p, i) => ({ p, i })).filter((x) => x.p.currentHp > 0 && x.i !== activeIdx);
    switchWrap.innerHTML = benched.length
      ? '<div class="coop-switch-label">Switch (costs the turn):</div>' + benched.map((x) =>
          `<button class="btn-primary btn-sm coop-switch-btn" data-switch="${x.i}">${x.p.nickname || x.p.name}</button>`).join('')
      : '';
    switchWrap.querySelectorAll('.coop-switch-btn').forEach((b) => {
      b.onclick = () => submitGuestAction({ type: 'switch', targetIdx: Number(b.dataset.switch) });
    });
  }

  let _guestSubmitted = false;
  async function submitGuestAction(action) {
    if (_guestSubmitted || !guestBattleState || !guestBattleState.awaiting) return;
    _guestSubmitted = true;
    clearGuestTimer();
    const controls = document.getElementById('coop-g-controls');
    if (controls) controls.style.display = 'none';
    const cap = document.getElementById('coop-g-caption');
    if (cap) cap.textContent = 'Action locked in — waiting for the host to resolve…';
    try { await pushAction({ kind: 'action', battleId: guestBattleState.battleId, round: guestBattleState.round, action }); } catch (_) {}
    guestBattleState.awaiting = false;
  }

  // Guest turn timer — on expiry auto-submit the higher-damage move.
  let _guestTimer = null, _guestTimerEnd = 0;
  function startGuestActionTimer(snap) {
    clearGuestTimer();
    _guestSubmitted = false;
    const secs = snap.turnTimer || CO.turnTimer || DEFAULT_TIMER;
    _guestTimerEnd = Date.now() + secs * 1000;
    const el = document.getElementById('coop-g-timer');
    const update = () => {
      const left = Math.max(0, Math.ceil((_guestTimerEnd - Date.now()) / 1000));
      if (el) el.textContent = `⏱ ${left}s`;
      if (left <= 0) {
        clearGuestTimer();
        // Auto-pick higher-damage move index from the snapshot's move powers.
        const eTeam = snap.enemyTeam;
        const active = eTeam[snap.activeEnemyIdx != null ? snap.activeEnemyIdx : eTeam.findIndex((p) => p.currentHp > 0)];
        const moves = (active && active.moves) || [];
        let idx = 0;
        if (moves[1] && !moves[1].isBoost && (moves[1].power || 0) > (moves[0].power || 0)) idx = 1;
        if (moves[0] && moves[0].isBoost && moves[1] && !moves[1].isBoost) idx = 1;
        submitGuestAction({ type: 'move', moveIdx: idx });
      }
    };
    update();
    _guestTimer = setInterval(update, 250);
  }
  function clearGuestTimer() { if (_guestTimer) { clearInterval(_guestTimer); _guestTimer = null; } }

  async function renderGuestRoundResult(snap) {
    // Animate using the shared coop animator, from the guest's perspective:
    // the guest's "my side" = enemyTeam, "foe side" = hostTeam.
    await coopAnimateRound(snap.events, snap.hostTeam, snap.enemyTeam, 'guest');
    renderGuestBattle(snap, 'Waiting for the next round…');
  }

  // =========================================================================
  // SHARED ROUND ANIMATOR — legible, paced beats (the "rhythm" the user wants).
  // perspective: 'host' updates #player-side/#enemy-side; 'guest' updates the
  // guest battle screen's two columns.
  // =========================================================================
  function coopSetCaption(perspective, text) {
    const id = perspective === 'host' ? 'coop-h-caption' : 'coop-g-caption';
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function coopAnimateRound(events, hostTeam, enemyTeam, perspective) {
    for (const ev of events) {
      if (ev.t === 'switch') {
        coopSetCaption(perspective, `${ev.name} was sent in!`);
        coopRerender(perspective, hostTeam, enemyTeam);
        await sleep(750);
      } else if (ev.t === 'boost') {
        const stats = Object.keys(ev.boost).map((s) => s.toUpperCase()).join(' & ');
        coopSetCaption(perspective, `${ev.name} used ${ev.moveName}! ${stats} rose!`);
        coopRerender(perspective, hostTeam, enemyTeam);
        await sleep(900);
      } else if (ev.t === 'move') {
        let eff = '';
        if (ev.typeEff >= 2) eff = ' Super effective!';
        else if (ev.typeEff === 0) eff = ' No effect!';
        else if (ev.typeEff < 1) eff = ' Not very effective…';
        coopSetCaption(perspective, `${ev.attackerName} used ${ev.moveName}!${ev.crit ? ' Critical hit!' : ''}${eff}`);
        await coopAnimateHp(perspective, ev, hostTeam, enemyTeam);
        await sleep(650);
      } else if (ev.t === 'faint') {
        coopSetCaption(perspective, `${ev.name} fainted!`);
        coopRerender(perspective, hostTeam, enemyTeam);
        await sleep(900);
      } else if (ev.t === 'sendout') {
        coopSetCaption(perspective, `${ev.name} was sent out!`);
        coopRerender(perspective, hostTeam, enemyTeam);
        await sleep(750);
      }
    }
  }

  function coopColEls(perspective) {
    if (perspective === 'host') return { my: document.getElementById('player-side'), foe: document.getElementById('enemy-side') };
    return { my: document.getElementById('coop-g-my-side'), foe: document.getElementById('coop-g-foe-side') };
  }

  function coopRerender(perspective, hostTeam, enemyTeam) {
    if (perspective === 'host') {
      renderBattleField(hostTeam, enemyTeam);
    } else {
      const { my, foe } = coopColEls('guest');
      if (my) my.innerHTML = coopSideHtml(enemyTeam, true);
      if (foe) foe.innerHTML = coopSideHtml(hostTeam, false);
    }
  }

  // Animate the HP bar of the move's target on the correct column.
  async function coopAnimateHp(perspective, ev, hostTeam, enemyTeam) {
    // Determine which visual column the target lives in.
    // targetSide is 'host' or 'enemy' (from resolveRound).
    let colEl;
    if (perspective === 'host') {
      colEl = ev.targetSide === 'host' ? coopColEls('host').my : coopColEls('host').foe;
    } else {
      // guest: enemy team is "my" column, host team is "foe" column
      colEl = ev.targetSide === 'enemy' ? coopColEls('guest').my : coopColEls('guest').foe;
    }
    if (!colEl) return;
    const node = colEl.children[ev.targetIdx];
    const hpWrap = node && node.querySelector('.poke-hp');
    if (!hpWrap) return;
    await animateHpBar(hpWrap, ev.targetHpBefore, ev.targetHpAfter, ev.targetMaxHp, 400);
  }

  // =========================================================================
  // HOST BATTLE UI — move/switch buttons + timer injected into #battle-screen.
  // =========================================================================
  let _hostResolveAction = null, _hostTimer = null, _hostTimerEnd = 0;

  function coopMountBattleUI() {
    let bar = document.getElementById('coop-h-controls');
    if (!bar) {
      const screen = document.getElementById('battle-screen');
      bar = document.createElement('div');
      bar.id = 'coop-h-controls';
      bar.className = 'coop-battle-controls';
      bar.innerHTML = `
        <div class="coop-battle-topline">
          <span id="coop-h-caption" class="coop-caption"></span>
          <span id="coop-h-timer" class="coop-timer"></span>
        </div>
        <div id="coop-h-moves" class="coop-move-row"></div>
        <div id="coop-h-switches" class="coop-switch-row"></div>`;
      screen.appendChild(bar);
    }
    bar.style.display = '';
  }
  function coopUnmountBattleUI() {
    clearHostTimer();
    const bar = document.getElementById('coop-h-controls');
    if (bar) bar.style.display = 'none';
    // Hide the single-player skip/continue buttons during co-op (unused).
    const skipBtn = document.getElementById('btn-auto-battle');
    if (skipBtn) skipBtn.style.display = 'none';
  }

  function coopHostChooseAction(hostTeam, enemyTeam, round) {
    return new Promise((resolve) => {
      coopMountBattleUI();
      const hIdx = firstAlive(hostTeam);
      const active = hostTeam[hIdx];
      const moves = getCoopMoves(active);
      coopSetCaption('host', `Round ${round} — your move, ${active.nickname || active.name}!`);

      const moveWrap = document.getElementById('coop-h-moves');
      moveWrap.innerHTML = moves.map((m, i) => {
        const label = (m.isBoost || m.boost) ? '↑ ' + m.name : m.name;
        const meta = (m.isBoost || m.boost) ? 'Boost' : `${m.type} · ${m.power}`;
        return `<button class="btn-primary btn-md coop-move-btn" data-move="${i}">
          <span class="coop-move-name">${label}</span><span class="coop-move-meta">${meta}</span></button>`;
      }).join('');

      const switchWrap = document.getElementById('coop-h-switches');
      const benched = hostTeam.map((p, i) => ({ p, i })).filter((x) => x.p.currentHp > 0 && x.i !== hIdx);
      switchWrap.innerHTML = benched.length
        ? '<div class="coop-switch-label">Switch (costs the turn):</div>' + benched.map((x) =>
            `<button class="btn-primary btn-sm coop-switch-btn" data-switch="${x.i}">${x.p.nickname || x.p.name} <small>${x.p.currentHp}/${x.p.maxHp}</small></button>`).join('')
        : '';

      const finish = (action) => {
        clearHostTimer();
        moveWrap.querySelectorAll('button').forEach((b) => (b.disabled = true));
        switchWrap.querySelectorAll('button').forEach((b) => (b.disabled = true));
        _hostResolveAction = null;
        resolve(action);
      };
      _hostResolveAction = finish;

      moveWrap.querySelectorAll('.coop-move-btn').forEach((b) => {
        b.onclick = () => finish({ type: 'move', moveIdx: Number(b.dataset.move) });
      });
      switchWrap.querySelectorAll('.coop-switch-btn').forEach((b) => {
        b.onclick = () => finish({ type: 'switch', targetIdx: Number(b.dataset.switch) });
      });

      // Timer — expiry auto-picks the higher-damage move.
      startHostTimer(() => finish({ type: 'move', moveIdx: autoMoveIdx(active, enemyTeam[firstAlive(enemyTeam)]) }));
    });
  }

  function startHostTimer(onExpire) {
    clearHostTimer();
    const secs = CO.turnTimer || DEFAULT_TIMER;
    _hostTimerEnd = Date.now() + secs * 1000;
    const el = document.getElementById('coop-h-timer');
    const update = () => {
      const left = Math.max(0, Math.ceil((_hostTimerEnd - Date.now()) / 1000));
      if (el) el.textContent = `⏱ ${left}s`;
      if (left <= 0) { clearHostTimer(); onExpire(); }
    };
    update();
    _hostTimer = setInterval(update, 250);
  }
  function clearHostTimer() { if (_hostTimer) { clearInterval(_hostTimer); _hostTimer = null; } }

  // Host: push a "waiting" snapshot so the guest sees a holding screen between
  // battles (map / catch / shop happen only on the host).
  async function coopWaiting() {
    if (CO.role !== 'host') return;
    await pushSnapshot({ kind: 'waiting', msg: 'Host is exploring… next battle soon.' }).catch(() => {});
  }

  // =========================================================================
  // LOBBY UI — Co-op menu entry + create/join/waiting screens injected into DOM.
  // =========================================================================
  function injectStyles() {
    if (document.getElementById('coop-styles')) return;
    const css = document.createElement('style');
    css.id = 'coop-styles';
    css.textContent = `
      .coop-panel{max-width:520px;margin:0 auto;text-align:center;display:flex;flex-direction:column;gap:16px;padding:24px}
      .coop-panel h2{margin:0}
      .coop-field{display:flex;flex-direction:column;gap:6px;text-align:left}
      .coop-field label{font-size:13px;opacity:.8}
      .coop-field input,.coop-field select{padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(0,0,0,.35);color:inherit;font-size:15px}
      .coop-code-display{font-size:34px;letter-spacing:8px;font-weight:800;padding:14px;border-radius:12px;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.18)}
      .coop-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
      .coop-players{display:flex;flex-direction:column;gap:8px;margin-top:8px}
      .coop-player{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-radius:10px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.12)}
      .coop-dot{width:10px;height:10px;border-radius:50%;background:#666;display:inline-block;margin-right:8px}
      .coop-dot.on{background:#00FF4A;box-shadow:0 0 8px #00FF4A}
      .coop-err{color:#ff6b6b;font-size:14px;min-height:18px}
      .coop-battle-controls{max-width:720px;margin:12px auto 0;display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:12px;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.12)}
      .coop-battle-topline{display:flex;justify-content:space-between;align-items:center;gap:12px}
      .coop-caption{font-weight:600;font-size:15px}
      .coop-timer{font-weight:800;font-variant-numeric:tabular-nums;opacity:.9}
      .coop-move-row{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
      .coop-move-btn{display:flex;flex-direction:column;gap:2px;min-width:140px;align-items:center}
      .coop-move-name{font-weight:700}
      .coop-move-meta{font-size:12px;opacity:.8}
      .coop-switch-row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;align-items:center}
      .coop-switch-label{width:100%;text-align:center;font-size:12px;opacity:.7;margin-bottom:2px}
      #coop-guest-battle .battle-field{display:flex;gap:24px;justify-content:center;flex-wrap:wrap}
      #coop-guest-battle .battle-side{flex:1;min-width:240px}
      .coop-guest-caption{text-align:center;font-weight:600;font-size:16px;margin:10px 0;min-height:22px}
    `;
    document.head.appendChild(css);
  }

  function el(tag, attrs, html) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (html != null) e.innerHTML = html;
    return e;
  }

  function injectScreens() {
    if (document.getElementById('coop-create')) return;

    // Create lobby
    const create = el('div', { id: 'coop-create', class: 'screen' });
    create.appendChild(el('div', { class: 'coop-panel' }, `
      <h2>Create Co-op Match</h2>
      <p class="screen-desc">You host a normal run. Your opponent controls every enemy team you face.</p>
      <div class="coop-field"><label>Your name</label><input id="coop-create-name" maxlength="20" placeholder="Trainer"></div>
      <div class="coop-field"><label>Seconds per turn</label>
        <select id="coop-create-timer">
          <option value="30">30s</option><option value="45">45s</option>
          <option value="60" selected>60s</option><option value="90">90s</option><option value="120">120s</option>
        </select></div>
      <div class="coop-err" id="coop-create-err"></div>
      <div class="coop-row">
        <button class="btn-primary btn-md" id="coop-create-go">Create Lobby</button>
        <button class="btn-primary btn-md" id="coop-create-back">Back</button>
      </div>`));
    document.body.appendChild(create);

    // Join lobby
    const join = el('div', { id: 'coop-join', class: 'screen' });
    join.appendChild(el('div', { class: 'coop-panel' }, `
      <h2>Join Co-op Match</h2>
      <p class="screen-desc">Enter the 5-letter code your host shared. You'll control the enemy teams.</p>
      <div class="coop-field"><label>Your name</label><input id="coop-join-name" maxlength="20" placeholder="Rival"></div>
      <div class="coop-field"><label>Lobby code</label><input id="coop-join-code" maxlength="5" placeholder="ABCDE" style="text-transform:uppercase;letter-spacing:6px;font-weight:700"></div>
      <div class="coop-err" id="coop-join-err"></div>
      <div class="coop-row">
        <button class="btn-primary btn-md" id="coop-join-go">Join</button>
        <button class="btn-primary btn-md" id="coop-join-back">Back</button>
      </div>`));
    document.body.appendChild(join);

    // Host waiting room
    const wait = el('div', { id: 'coop-lobby', class: 'screen' });
    wait.appendChild(el('div', { class: 'coop-panel' }, `
      <h2>Lobby</h2>
      <p class="screen-desc">Share this code with your opponent. The match starts when they join.</p>
      <div class="coop-code-display" id="coop-lobby-code">·····</div>
      <div class="coop-players" id="coop-lobby-players"></div>
      <div class="coop-err" id="coop-lobby-err"></div>
      <div class="coop-row">
        <button class="btn-primary btn-md" id="coop-lobby-start" disabled>Start Match</button>
        <button class="btn-primary btn-md" id="coop-lobby-leave">Leave</button>
      </div>`));
    document.body.appendChild(wait);

    // Guest waiting (between battles / pre-start)
    const gwait = el('div', { id: 'coop-guest-waiting', class: 'screen' });
    gwait.appendChild(el('div', { class: 'coop-panel' }, `
      <h2>Co-op</h2>
      <div class="coop-guest-caption" id="coop-guest-wait-msg">Connected. Waiting for the host to start…</div>
      <div class="coop-row"><button class="btn-primary btn-md" id="coop-guest-leave">Leave</button></div>`));
    document.body.appendChild(gwait);

    // Guest battle screen (enemy controller)
    const gbattle = el('div', { id: 'coop-guest-battle', class: 'screen' });
    gbattle.appendChild(el('div', null, `
      <div class="coop-guest-caption" id="coop-g-caption"></div>
      <div class="battle-field">
        <div class="battle-side">
          <div class="battle-side-label">Enemy Team (you)</div>
          <div id="coop-g-my-side"></div>
        </div>
        <div class="battle-side">
          <div class="battle-side-label">Host's Team</div>
          <div id="coop-g-foe-side"></div>
        </div>
      </div>
      <div class="coop-battle-controls" id="coop-g-controls" style="display:none">
        <div class="coop-battle-topline"><span class="coop-caption">Choose a move</span><span id="coop-g-timer" class="coop-timer"></span></div>
        <div id="coop-g-moves" class="coop-move-row"></div>
        <div id="coop-g-switches" class="coop-switch-row"></div>
      </div>`));
    document.body.appendChild(gbattle);

    wireScreens();
  }

  function showCoopScreen(id, guestWaitMsg) {
    showScreen(id);
    if (id === 'coop-guest-waiting' && guestWaitMsg) {
      const m = document.getElementById('coop-guest-wait-msg');
      if (m) m.textContent = guestWaitMsg;
    }
  }

  function wireScreens() {
    // Create
    document.getElementById('coop-create-back').onclick = () => showScreen('title-screen');
    document.getElementById('coop-create-go').onclick = async () => {
      const name = (document.getElementById('coop-create-name').value || '').trim() || 'Host';
      const timer = Number(document.getElementById('coop-create-timer').value) || DEFAULT_TIMER;
      const err = document.getElementById('coop-create-err');
      err.textContent = '';
      try {
        const res = await apiPost('/create', { clientId: getClientId(), username: name, turnTimer: timer });
        CO.code = res.code; CO.role = 'host'; CO.username = name; CO.turnTimer = timer;
        document.getElementById('coop-lobby-code').textContent = res.code;
        showScreen('coop-lobby');
        startLobbyPoll();
      } catch (e) { err.textContent = e.message || 'Could not create lobby.'; }
    };

    // Join
    document.getElementById('coop-join-back').onclick = () => showScreen('title-screen');
    document.getElementById('coop-join-go').onclick = async () => {
      const name = (document.getElementById('coop-join-name').value || '').trim() || 'Guest';
      const code = (document.getElementById('coop-join-code').value || '').trim().toUpperCase();
      const err = document.getElementById('coop-join-err');
      err.textContent = '';
      if (code.length !== 5) { err.textContent = 'Enter the 5-letter code.'; return; }
      try {
        const res = await apiPost('/join', { clientId: getClientId(), username: name, code });
        CO.code = code; CO.role = 'guest'; CO.username = name;
        CO.turnTimer = res.view?.turnTimer || DEFAULT_TIMER;
        CO.lastHostSeq = 0;
        state.coop = { active: true, role: 'guest', code };
        showCoopScreen('coop-guest-waiting', 'Connected. Waiting for the host to start…');
        startGuestLoop();
      } catch (e) { err.textContent = e.message || 'Could not join.'; }
    };

    // Host lobby
    document.getElementById('coop-lobby-leave').onclick = async () => {
      stopLobbyPoll();
      try { await apiPost('/leave', { clientId: getClientId(), code: CO.code }); } catch (_) {}
      resetCoop();
      showScreen('title-screen');
    };
    document.getElementById('coop-lobby-start').onclick = async () => {
      try { await setStatus('playing'); } catch (_) {}
      stopLobbyPoll();
      state.coop = { active: true, role: 'host', code: CO.code };
      // Kick off a normal run; every battle now routes through the co-op wrapper.
      await pushSnapshot({ kind: 'waiting', msg: 'Host is setting up the run…' }).catch(() => {});
      const gen2 = Number(localStorage.getItem('poke_selected_gen')) === 2;
      startNewRun(false, gen2);
    };

    // Guest leave
    document.getElementById('coop-guest-leave').onclick = async () => {
      stopGuestLoop();
      try { await apiPost('/leave', { clientId: getClientId(), code: CO.code }); } catch (_) {}
      resetCoop();
      showScreen('title-screen');
    };
  }

  function resetCoop() {
    stopGuestLoop(); stopLobbyPoll(); clearHostTimer(); clearGuestTimer();
    if (typeof state !== 'undefined') state.coop = { active: false };
    CO.code = null; CO.role = null; CO.lastHostSeq = 0; CO.lastGuestSeq = 0;
    guestBattleState = null;
  }

  // Host lobby poll — enable Start when a guest is present.
  function startLobbyPoll() {
    stopLobbyPoll();
    CO.lobbyPoll = setInterval(async () => {
      let view; try { view = await apiGetState(CO.code); } catch (_) { return; }
      if (!view) return;
      const box = document.getElementById('coop-lobby-players');
      const startBtn = document.getElementById('coop-lobby-start');
      const rows = [];
      rows.push(playerRow(view.host, 'Host'));
      rows.push(view.guest ? playerRow(view.guest, 'Opponent') : `<div class="coop-player"><span><span class="coop-dot"></span>Waiting for opponent…</span></div>`);
      if (box) box.innerHTML = rows.join('');
      if (startBtn) startBtn.disabled = !view.guest;
    }, POLL_MS);
  }
  function stopLobbyPoll() { if (CO.lobbyPoll) { clearInterval(CO.lobbyPoll); CO.lobbyPoll = null; } }
  function playerRow(p, role) {
    return `<div class="coop-player"><span><span class="coop-dot ${p.connected ? 'on' : ''}"></span>${p.username}</span><span style="opacity:.7">${role}</span></div>`;
  }

  // Add a "Co-op" mode card to the title screen.
  function injectMenuEntry() {
    const cards = document.querySelector('.title-mode-cards');
    if (!cards || document.getElementById('coop-title-col')) return;
    const col = el('div', { class: 'title-mode-col', id: 'coop-title-col' });
    col.appendChild(el('button', { type: 'button', id: 'btn-coop-run', class: 'title-mode-card title-mode-card--challenge' }, `
      <span class="title-mode-card-title">Co-op Versus</span>
      <span class="title-mode-card-figure">
        <span class="title-mode-card-action">Play a Friend</span>
      </span>`));
    cards.appendChild(col);
    const createBtn = el('button', { id: 'btn-coop-create', class: 'title-mode-resume title-mode-resume--challenge' }, 'Create Match');
    const joinBtn = el('button', { id: 'btn-coop-join', class: 'title-mode-resume title-mode-resume--challenge' }, 'Join with Code');
    joinBtn.style.marginTop = '6px';
    col.appendChild(createBtn);
    col.appendChild(joinBtn);

    const openCreate = () => { resetCoop(); showScreen('coop-create'); };
    const openJoin = () => { resetCoop(); showScreen('coop-join'); };
    document.getElementById('btn-coop-run').onclick = openCreate;
    createBtn.onclick = openCreate;
    joinBtn.onclick = openJoin;
  }

  // =========================================================================
  // BOOTSTRAP — wrap runBattleScreen (co-op host path) + inject UI. Runs after
  // game.js's DOMContentLoaded (this script is last), so initGame has run.
  // =========================================================================
  function boot() {
    getClientId();
    injectStyles();
    injectScreens();
    injectMenuEntry();

    // Wrap the global runBattleScreen. Single-player path is byte-identical:
    // the wrapper only diverts when the local player is the co-op HOST.
    if (typeof window.runBattleScreen === 'function' && !window.runBattleScreen._coopWrapped) {
      const orig = window.runBattleScreen;
      const wrapped = function (...args) {
        if (typeof state !== 'undefined' && state.coop && state.coop.active && state.coop.role === 'host') {
          return runCoopHostBattle(orig, ...args);
        }
        return orig.apply(this, args);
      };
      wrapped._coopWrapped = true;
      window.runBattleScreen = wrapped;
    }

    // Re-inject the menu entry whenever the title screen is shown again
    // (initGame may rebuild parts of it). Cheap idempotent guard inside.
    injectMenuEntry();
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }

  // Expose a tiny debug handle.
  window.Coop = { CO, getCoopMoves, resolveRound, boot };
})();
