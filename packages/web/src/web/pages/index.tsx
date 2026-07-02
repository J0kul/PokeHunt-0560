import { useState, useRef, useEffect, useCallback } from "react";
import { useDesktop } from "../hooks/use-desktop";

// ── helpers ──────────────────────────────────────────────────────────────────

function pct(v: number) { return `${(v * 100).toFixed(1)}%`; }

// ── types ─────────────────────────────────────────────────────────────────────

interface ShinyConfig {
  baseRate: number;
  charmRate: number;
  nodeBase: number;
  nodeCharm: number;
}

type NodeWeightLayer = { battle: number; catch: number; item: number; trainer: number; question: number; pokecenter: number; move_tutor: number; trade: number; legendary: number };
type NodeWeightsConfig = { gen1: NodeWeightLayer[]; gen2: NodeWeightLayer };

type MovePool = { [type: string]: { physical: { name: string; power: number; desc: string }[]; special: { name: string; power: number; desc: string }[] } };

interface LevelConfig { baseGain: number; }

// ── parse helpers ─────────────────────────────────────────────────────────────

function parseShinyConfig(src: string): ShinyConfig {
  // rng() < (hasShinyCharm() ? 0.02 : 0.01)
  const m = src.match(/rng\(\)\s*<\s*\(hasShinyCharm\(\)\s*\?\s*([\d.]+)\s*:\s*([\d.]+)\)/);
  // node question shiny: if (r < (hasShinyCharm() ? 0.79 : 0.72))
  const m2 = src.match(/if\s*\(r\s*<\s*\(hasShinyCharm\(\)\s*\?\s*([\d.]+)\s*:\s*([\d.]+)\)\)/);
  return {
    charmRate: m ? parseFloat(m[1]) : 0.02,
    baseRate: m ? parseFloat(m[2]) : 0.01,
    nodeCharm: m2 ? parseFloat(m2[1]) : 0.79,
    nodeBase: m2 ? parseFloat(m2[2]) : 0.72,
  };
}

function applyShinyConfig(src: string, cfg: ShinyConfig): string {
  let out = src.replace(
    /rng\(\)\s*<\s*\(hasShinyCharm\(\)\s*\?\s*[\d.]+\s*:\s*[\d.]+\)/g,
    `rng() < (hasShinyCharm() ? ${cfg.charmRate} : ${cfg.baseRate})`
  );
  out = out.replace(
    /if\s*\(r\s*<\s*\(hasShinyCharm\(\)\s*\?\s*[\d.]+\s*:\s*[\d.]+\)\)/,
    `if (r < (hasShinyCharm() ? ${cfg.nodeCharm} : ${cfg.nodeBase}))`
  );
  return out;
}

function parseNodeWeights(src: string): NodeWeightsConfig {
  // NODE_WEIGHTS array
  const blockM = src.match(/const NODE_WEIGHTS\s*=\s*\[([\s\S]*?)\];/);
  const gen2M = src.match(/const GEN2_NODE_WEIGHTS\s*=\s*\{([^}]+)\}/);

  const defaultLayer = (): NodeWeightLayer => ({ battle: 0, catch: 0, item: 0, trainer: 0, question: 0, pokecenter: 0, move_tutor: 0, trade: 0, legendary: 0 });

  const parseLayer = (txt: string): NodeWeightLayer => {
    const l = defaultLayer();
    const keys: (keyof NodeWeightLayer)[] = ['battle','catch','item','trainer','question','pokecenter','move_tutor','trade','legendary'];
    for (const k of keys) {
      const m = txt.match(new RegExp(`${k}\\s*:\\s*(\\d+)`));
      if (m) (l as any)[k] = parseInt(m[1]);
    }
    return l;
  };

  const gen1: NodeWeightLayer[] = [];
  if (blockM) {
    const matches = [...blockM[1].matchAll(/\{([^}]+)\}/g)];
    for (const m of matches) gen1.push(parseLayer(m[1]));
  }

  const gen2 = gen2M ? parseLayer(gen2M[1]) : defaultLayer();
  return { gen1, gen2 };
}

function applyNodeWeights(src: string, cfg: NodeWeightsConfig): string {
  const serializeLayer = (l: NodeWeightLayer, indent: string) =>
    `{ battle: ${l.battle}, catch: ${l.catch}, item: ${l.item}, trainer: ${l.trainer}, question: ${l.question}, pokecenter: ${l.pokecenter},  move_tutor: ${l.move_tutor}, trade: ${l.trade}, legendary: ${l.legendary} }`;

  // Replace gen1 block
  let out = src.replace(/const NODE_WEIGHTS\s*=\s*\[[\s\S]*?\];/, () => {
    const layers = cfg.gen1.map((l, i) => `  // L${i + 1}\n  ${serializeLayer(l, '  ')}`).join(',\n');
    return `const NODE_WEIGHTS = [\n${layers},\n];`;
  });

  // Replace gen2 block
  const g2 = cfg.gen2;
  out = out.replace(/const GEN2_NODE_WEIGHTS\s*=\s*\{[^}]+\}/, 
    `const GEN2_NODE_WEIGHTS = {\n  battle: ${g2.battle}, catch: ${g2.catch}, item: ${g2.item}, trainer: ${g2.trainer}, question: ${g2.question}, pokecenter: ${g2.pokecenter}, move_tutor: ${g2.move_tutor}, trade: ${g2.trade}, legendary: ${g2.legendary},\n}`
  );
  return out;
}

// ── LevelConfig parse ─────────────────────────────────────────────────────────

// battle.js: `function getLevelGain(...) { return 2; }`
function parseLevelConfig(src: string): LevelConfig {
  const m = src.match(/function getLevelGain[^{]*\{[^}]*return\s+([\d.]+)\s*;/);
  return { baseGain: m ? parseFloat(m[1]) : 2 };
}

function applyLevelConfig(src: string, cfg: LevelConfig): string {
  return src.replace(
    /function getLevelGain[^{]*\{[^}]*return\s+[\d.]+\s*;[^}]*\}/,
    `function getLevelGain(team, bagItems) {\n  return ${cfg.baseGain};\n}`
  );
}

// ── component ─────────────────────────────────────────────────────────────────

const TYPES = ['Normal','Fire','Water','Electric','Grass','Ice','Fighting','Poison','Ground','Flying','Psychic','Bug','Rock','Ghost','Dragon','Dark','Steel','Fairy'];
const TIERS = ['Tier 0 (Early)', 'Tier 1 (Mid)', 'Tier 2 (Strong)'];
const LAYER_LABELS = ['Layer 1', 'Layer 2', 'Layer 3', 'Layer 4', 'Layer 5', 'Layer 6'];
const NODE_KEYS: (keyof NodeWeightLayer)[] = ['battle','catch','item','trainer','question','move_tutor','trade'];

export default function Index() {
  const desktop = useDesktop();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const moneyRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<'money'|'shiny'|'nodes'|'moves'|'level'>('money');
  const [editorOpen, setEditorOpen] = useState<boolean>(true);
  const [money, setMoney] = useState<number>(0);
  const [moneyInput, setMoneyInput] = useState<string>('0');
  const [status, setStatus] = useState('');
  const [shiny, setShiny] = useState<ShinyConfig>({ baseRate: 0.01, charmRate: 0.02, nodeBase: 0.72, nodeCharm: 0.79 });
  const [nodeWeights, setNodeWeights] = useState<NodeWeightsConfig>({ gen1: [], gen2: { battle:25,catch:5,item:10,trainer:40,question:10,pokecenter:0,move_tutor:5,trade:5,legendary:0 } });
  const [moves, setMoves] = useState<MovePool>({});
  const [levelCfg, setLevelCfg] = useState<LevelConfig>({ baseGain: 1 });
  const [loaded, setLoaded] = useState(false);
  const [gameKey, setGameKey] = useState(0);

  const readJs = useCallback(async (file: string): Promise<string> => {
    if (desktop) {
      try {
        const jsDir = await (window as any).electronAPI.getJsDir();
        // jsDir is an absolute path like /path/to/public/js
        const sep = jsDir.includes('/') ? '/' : '\\';
        const fullPath = jsDir + sep + file;
        const result = await (window as any).electronAPI.readFile(fullPath);
        if (result) return result;
      } catch {}
    }
    const res = await fetch(`/js/${file}?t=${Date.now()}`);
    return res.text();
  }, [desktop]);

  const writeJs = useCallback(async (file: string, content: string) => {
    if (desktop) {
      const jsDir = await (window as any).electronAPI.getJsDir();
      const sep = jsDir.includes('/') ? '/' : '\\';
      await (window as any).electronAPI.writeFile(jsDir + sep + file, content);
      return;
    }
    // In web mode, post to API
    await fetch(`/api/writejs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, content })
    });
  }, [desktop]);

  // ── Money (Poké Dollars) — live, via the game iframe ──────────────────────
  // Reads/writes through window.getPokedollars/setPokedollars inside the iframe,
  // falling back to the `poke_pokedollars` localStorage key. No reload needed.
  const getGameWin = useCallback((): any => {
    return iframeRef.current?.contentWindow ?? null;
  }, []);

  const readMoney = useCallback((): number => {
    const w = getGameWin();
    try {
      if (w && typeof w.getPokedollars === 'function') return w.getPokedollars();
      const raw = w?.localStorage?.getItem('poke_pokedollars');
      return raw ? parseInt(raw, 10) || 0 : 0;
    } catch { return 0; }
  }, [getGameWin]);

  const writeMoney = useCallback((value: number) => {
    const v = Math.max(0, Math.floor(value) || 0);
    const w = getGameWin();
    try {
      if (w && typeof w.setPokedollars === 'function') {
        w.setPokedollars(v);
      } else if (w?.localStorage) {
        w.localStorage.setItem('poke_pokedollars', String(v));
      }
    } catch {}
    setMoney(v);
    setMoneyInput(String(v));
  }, [getGameWin]);

  // Keep the displayed balance in sync with the game (poll lightly).
  useEffect(() => {
    const sync = () => {
      const w = getGameWin();
      if (!w) return;
      const cur = readMoney();
      setMoney(cur);
      setMoneyInput(prev => (document.activeElement === moneyRef.current ? prev : String(cur)));
    };
    const id = setInterval(sync, 1000);
    return () => clearInterval(id);
  }, [getGameWin, readMoney, gameKey]);

  // Load all configs on mount
  useEffect(() => {
    (async () => {
      try {
        const [gameSrc, mapSrc, dataSrc, battleSrc] = await Promise.all([
          readJs('game.js'),
          readJs('map.js'),
          readJs('data.js'),
          readJs('battle.js'),
        ]);

        setShiny(parseShinyConfig(gameSrc));
        setNodeWeights(parseNodeWeights(mapSrc));
        setLevelCfg(parseLevelConfig(battleSrc));

        // Parse move powers from data.js
        const poolMatch = dataSrc.match(/const MOVE_POOL\s*=\s*\{([\s\S]*?)\n\};\s*\n/);
        if (poolMatch) {
          const pool: MovePool = {};
          for (const type of TYPES) {
            const typeBlock = dataSrc.match(new RegExp(`${type}\\s*:\\s*\\{\\s*physical:\\s*\\[(.*?)\\],\\s*special:\\s*\\[(.*?)\\]`, 's'));
            if (!typeBlock) continue;
            const parseArr = (txt: string) => {
              const arr: { name: string; power: number; desc: string }[] = [];
              const entries = [...txt.matchAll(/\{name:'([^']+)',\s*power:(\d+),\s*desc:'([^']*)'\}/g)];
              for (const e of entries) arr.push({ name: e[1], power: parseInt(e[2]), desc: e[3] });
              return arr;
            };
            pool[type] = { physical: parseArr(typeBlock[1]), special: parseArr(typeBlock[2]) };
          }
          setMoves(pool);
        }

        setLoaded(true);
        setStatus('✓ Config loaded');
        setTimeout(() => setStatus(''), 2000);
      } catch (e) {
        setStatus('⚠ Could not load JS files');
        setLoaded(true);
      }
    })();
  }, [readJs]);

  const applyAll = async () => {
    setStatus('Saving…');
    try {
      // Patch game.js (shiny rates only)
      let gameSrc = await readJs('game.js');
      gameSrc = applyShinyConfig(gameSrc, shiny);
      await writeJs('game.js', gameSrc);

      // Patch battle.js (level gain)
      let battleSrc = await readJs('battle.js');
      battleSrc = applyLevelConfig(battleSrc, levelCfg);
      await writeJs('battle.js', battleSrc);

      // Patch map.js
      let mapSrc = await readJs('map.js');
      mapSrc = applyNodeWeights(mapSrc, nodeWeights);
      await writeJs('map.js', mapSrc);

      // Patch data.js for move powers
      let dataSrc = await readJs('data.js');
      for (const type of TYPES) {
        if (!moves[type]) continue;
        for (let tier = 0; tier < 3; tier++) {
          const phys = moves[type].physical[tier];
          const spec = moves[type].special[tier];
          if (phys) {
            dataSrc = dataSrc.replace(
              new RegExp(`(${type}.*?physical.*?\\{name:'${phys.name}',\\s*power:)\\d+(,)`, 's'),
              `$1${phys.power}$2`
            );
          }
          if (spec) {
            dataSrc = dataSrc.replace(
              new RegExp(`(${type}.*?special.*?\\{name:'${spec.name}',\\s*power:)\\d+(,)`, 's'),
              `$1${spec.power}$2`
            );
          }
        }
      }
      await writeJs('data.js', dataSrc);

      setStatus('✓ Saved! Reloading game…');
      setTimeout(() => {
        setGameKey(k => k + 1);
        setStatus('');
      }, 800);
    } catch (e: any) {
      setStatus('⚠ Save failed: ' + e.message);
    }
  };

  const updateNodeWeight = (gen: 'gen1' | 'gen2', key: keyof NodeWeightLayer, value: number, layerIdx?: number) => {
    setNodeWeights(prev => {
      if (gen === 'gen2') {
        return { ...prev, gen2: { ...prev.gen2, [key]: value } };
      } else {
        const newGen1 = [...prev.gen1];
        newGen1[layerIdx!] = { ...newGen1[layerIdx!], [key]: value };
        return { ...prev, gen1: newGen1 };
      }
    });
  };

  const updateMovePower = (type: string, kind: 'physical'|'special', tier: number, power: number) => {
    setMoves(prev => {
      if (!prev[type]) return prev;
      const arr = [...prev[type][kind]];
      arr[tier] = { ...arr[tier], power };
      return { ...prev, [type]: { ...prev[type], [kind]: arr } };
    });
  };

  // ── render ────────────────────────────────────────────────────────────────

  const tabBtnStyle = (t: string) => ({
    padding: '6px 12px',
    background: tab === t ? '#e8c840' : '#2a2a2a',
    color: tab === t ? '#111' : '#ccc',
    border: tab === t ? '2px solid #e8c840' : '2px solid #444',
    borderRadius: 4,
    cursor: 'pointer',
    fontFamily: "'Press Start 2P', monospace",
    fontSize: 8,
    fontWeight: 'bold',
  });

  const inputStyle: React.CSSProperties = {
    width: '70px',
    background: '#1a1a1a',
    color: '#e8c840',
    border: '1px solid #555',
    borderRadius: 3,
    padding: '3px 6px',
    fontFamily: 'monospace',
    fontSize: 12,
    textAlign: 'right',
  };

  const labelStyle: React.CSSProperties = {
    color: '#aaa',
    fontSize: 11,
    fontFamily: 'monospace',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '4px 0',
    borderBottom: '1px solid #222',
  };

  const sectionTitle: React.CSSProperties = {
    color: '#e8c840',
    fontFamily: "'Press Start 2P', monospace",
    fontSize: 9,
    marginBottom: 10,
    marginTop: 14,
  };

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#111', overflow: 'hidden', fontFamily: 'monospace' }}>
      {/* ── GAME IFRAME ────────────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0, position: 'relative', borderRight: '2px solid #333' }}>
        <iframe
          key={gameKey}
          ref={iframeRef}
          src={`/game.html?v=${gameKey}-${__BUILD_ID__}`}
          style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
          title="Pokelike Game"
        />
        {/* Toggle button — floats over the game, top-right */}
        <button
          onClick={() => setEditorOpen(o => !o)}
          title={editorOpen ? 'Hide editor' : 'Show editor'}
          style={{
            position: 'absolute', top: 12, right: 12, zIndex: 10,
            background: '#e8c840', color: '#111', border: 'none', borderRadius: 6,
            padding: '8px 12px', fontFamily: "'Press Start 2P', monospace", fontSize: 8,
            cursor: 'pointer', fontWeight: 'bold', boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
          }}
        >
          {editorOpen ? '✕ EDITOR' : '⚙ EDITOR'}
        </button>
      </div>

      {/* ── EDITOR SIDEBAR ─────────────────────────────────────────── */}
      {editorOpen && (
      <div style={{ width: 340, display: 'flex', flexDirection: 'column', background: '#161616', flexShrink: 0 }}>
        {/* Header */}
        <div style={{ background: '#1e1e1e', borderBottom: '2px solid #333', padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ color: '#e8c840', fontFamily: "'Press Start 2P', monospace", fontSize: 9 }}>⚙ EDITOR</span>
          <button
            onClick={applyAll}
            style={{ background: '#e8c840', color: '#111', border: 'none', borderRadius: 4, padding: '6px 12px', fontFamily: "'Press Start 2P', monospace", fontSize: 8, cursor: 'pointer', fontWeight: 'bold' }}
          >
            ▶ Apply
          </button>
        </div>

        {/* Status */}
        {status && (
          <div style={{ background: status.startsWith('⚠') ? '#3a1a1a' : '#1a3a1a', color: status.startsWith('⚠') ? '#f88' : '#8f8', padding: '5px 14px', fontSize: 10, fontFamily: 'monospace', borderBottom: '1px solid #333' }}>
            {status}
          </div>
        )}

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, padding: '8px 10px', borderBottom: '1px solid #333', flexWrap: 'wrap' }}>
          <button style={tabBtnStyle('money')} onClick={() => setTab('money')}>Money</button>
          <button style={tabBtnStyle('shiny')} onClick={() => setTab('shiny')}>Shiny</button>
          <button style={tabBtnStyle('nodes')} onClick={() => setTab('nodes')}>Nodes</button>
          <button style={tabBtnStyle('moves')} onClick={() => setTab('moves')}>Moves</button>
          <button style={tabBtnStyle('level')} onClick={() => setTab('level')}>Level</button>
        </div>

        {/* Tab content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
          {!loaded && <div style={{ color: '#888', fontSize: 11 }}>Loading…</div>}

          {/* ── SHINY TAB ── */}
          {tab === 'money' && (
            <div style={{ padding: '14px' }}>
              <div style={sectionTitle}>Poké Dollars</div>

              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '10px 0 16px' }}>
                <div style={{ color: '#888', fontSize: 10, fontFamily: 'monospace' }}>CURRENT BALANCE</div>
                <div style={{ color: '#e8c840', fontSize: 26, fontFamily: "'Press Start 2P', monospace", letterSpacing: 1 }}>
                  ₽{money.toLocaleString()}
                </div>
              </div>

              <div style={{ ...labelStyle, borderBottom: 'none', flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
                <span style={{ color: '#aaa', fontSize: 11 }}>Set exact amount</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    ref={moneyRef}
                    type="number"
                    min={0}
                    value={moneyInput}
                    onChange={e => setMoneyInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') writeMoney(parseInt(moneyInput, 10) || 0); }}
                    style={{ ...inputStyle, flex: 1, width: 'auto', textAlign: 'left' }}
                  />
                  <button
                    onClick={() => writeMoney(parseInt(moneyInput, 10) || 0)}
                    style={{ background: '#e8c840', color: '#111', border: 'none', borderRadius: 4, padding: '4px 12px', fontFamily: "'Press Start 2P', monospace", fontSize: 8, cursor: 'pointer', fontWeight: 'bold' }}
                  >Set</button>
                </div>
              </div>

              <div style={sectionTitle}>Quick Add</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {[100, 500, 1000, 5000, 10000].map(amt => (
                  <button
                    key={amt}
                    onClick={() => writeMoney(readMoney() + amt)}
                    style={{ background: '#2a2a2a', color: '#e8c840', border: '1px solid #555', borderRadius: 4, padding: '6px 10px', fontFamily: 'monospace', fontSize: 11, cursor: 'pointer' }}
                  >+{amt.toLocaleString()}</button>
                ))}
              </div>

              <div style={sectionTitle}>Presets</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <button onClick={() => writeMoney(0)} style={{ background: '#3a1a1a', color: '#f88', border: '1px solid #633', borderRadius: 4, padding: '6px 10px', fontFamily: 'monospace', fontSize: 11, cursor: 'pointer' }}>Reset (0)</button>
                <button onClick={() => writeMoney(999999)} style={{ background: '#1a3a1a', color: '#8f8', border: '1px solid #363', borderRadius: 4, padding: '6px 10px', fontFamily: 'monospace', fontSize: 11, cursor: 'pointer' }}>Max (999,999)</button>
              </div>

              <p style={{ color: '#666', fontSize: 10, fontFamily: 'monospace', lineHeight: 1.5, marginTop: 16 }}>
                Changes apply instantly to the running game — no reload needed. The shop / balance in the game updates live.
              </p>
            </div>
          )}

          {loaded && tab === 'shiny' && (
            <div>
              <p style={{ color: '#888', fontSize: 9, lineHeight: 1.6, marginBottom: 12 }}>
                Controls how often shiny Pokémon appear. Changes take effect after clicking Apply.
              </p>

              <div style={sectionTitle}>Wild Encounter Shiny Rate</div>
              <div style={labelStyle}>
                <span>Base rate <span style={{ color: '#666' }}>(no charm)</span></span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="number" style={inputStyle} step="0.001" min="0" max="1"
                    value={shiny.baseRate}
                    onChange={e => setShiny(s => ({ ...s, baseRate: parseFloat(e.target.value) || 0 }))}
                  />
                  <span style={{ color: '#666', fontSize: 10, width: 38, textAlign: 'right' }}>{pct(shiny.baseRate)}</span>
                </div>
              </div>
              <div style={labelStyle}>
                <span>With Shiny Charm</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="number" style={inputStyle} step="0.001" min="0" max="1"
                    value={shiny.charmRate}
                    onChange={e => setShiny(s => ({ ...s, charmRate: parseFloat(e.target.value) || 0 }))}
                  />
                  <span style={{ color: '#666', fontSize: 10, width: 38, textAlign: 'right' }}>{pct(shiny.charmRate)}</span>
                </div>
              </div>

              <div style={sectionTitle}>? Node Shiny Outcome</div>
              <p style={{ color: '#666', fontSize: 9, lineHeight: 1.5, marginBottom: 8 }}>
                When you hit a "?" node, this is the chance it resolves as a shiny encounter.
              </p>
              <div style={labelStyle}>
                <span>Base shiny node chance</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="number" style={inputStyle} step="0.01" min="0" max="1"
                    value={shiny.nodeBase}
                    onChange={e => setShiny(s => ({ ...s, nodeBase: parseFloat(e.target.value) || 0 }))}
                  />
                  <span style={{ color: '#666', fontSize: 10, width: 38, textAlign: 'right' }}>{pct(shiny.nodeBase)}</span>
                </div>
              </div>
              <div style={labelStyle}>
                <span>With Shiny Charm</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="number" style={inputStyle} step="0.01" min="0" max="1"
                    value={shiny.nodeCharm}
                    onChange={e => setShiny(s => ({ ...s, nodeCharm: parseFloat(e.target.value) || 0 }))}
                  />
                  <span style={{ color: '#666', fontSize: 10, width: 38, textAlign: 'right' }}>{pct(shiny.nodeCharm)}</span>
                </div>
              </div>

              <div style={{ marginTop: 16, padding: 10, background: '#1a1a1a', borderRadius: 6, border: '1px solid #333' }}>
                <div style={{ color: '#e8c840', fontSize: 9, fontFamily: "'Press Start 2P', monospace", marginBottom: 6 }}>Quick Presets</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {[
                    { label: 'Default (1%)', v: { baseRate: 0.01, charmRate: 0.02, nodeBase: 0.72, nodeCharm: 0.79 } },
                    { label: 'Easy (5%)', v: { baseRate: 0.05, charmRate: 0.1, nodeBase: 0.85, nodeCharm: 0.92 } },
                    { label: 'Always!', v: { baseRate: 1, charmRate: 1, nodeBase: 1, nodeCharm: 1 } },
                  ].map(p => (
                    <button key={p.label} onClick={() => setShiny(p.v as ShinyConfig)}
                      style={{ background: '#2a2a2a', color: '#ccc', border: '1px solid #555', borderRadius: 4, padding: '4px 8px', fontSize: 9, cursor: 'pointer', fontFamily: 'monospace' }}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── NODES TAB ── */}
          {loaded && tab === 'nodes' && (
            <div>
              <p style={{ color: '#888', fontSize: 9, lineHeight: 1.6, marginBottom: 8 }}>
                Controls the probability weights for each node type on the map. Higher = more common.
              </p>

              <div style={sectionTitle}>Gen 1 — Per Layer</div>
              {nodeWeights.gen1.map((layer, li) => (
                <div key={li} style={{ marginBottom: 12, background: '#1a1a1a', borderRadius: 6, padding: '8px 10px', border: '1px solid #2a2a2a' }}>
                  <div style={{ color: '#e8c840', fontSize: 8, fontFamily: "'Press Start 2P', monospace", marginBottom: 6 }}>{LAYER_LABELS[li]}</div>
                  {NODE_KEYS.map(key => (
                    <div key={key} style={labelStyle}>
                      <span style={{ textTransform: 'capitalize' }}>{key.replace('_', ' ')}</span>
                      <input
                        type="number" style={{ ...inputStyle, width: 55 }} min="0" max="100" step="1"
                        value={layer[key]}
                        onChange={e => updateNodeWeight('gen1', key, parseInt(e.target.value) || 0, li)}
                      />
                    </div>
                  ))}
                  <div style={{ color: '#555', fontSize: 9, textAlign: 'right', marginTop: 4 }}>
                    Total: {NODE_KEYS.reduce((s, k) => s + (layer[k] || 0), 0)}
                  </div>
                </div>
              ))}

              <div style={sectionTitle}>Gen 2 — Flat</div>
              <div style={{ background: '#1a1a1a', borderRadius: 6, padding: '8px 10px', border: '1px solid #2a2a2a' }}>
                {NODE_KEYS.map(key => (
                  <div key={key} style={labelStyle}>
                    <span style={{ textTransform: 'capitalize' }}>{key.replace('_', ' ')}</span>
                    <input
                      type="number" style={{ ...inputStyle, width: 55 }} min="0" max="100" step="1"
                      value={nodeWeights.gen2[key]}
                      onChange={e => updateNodeWeight('gen2', key, parseInt(e.target.value) || 0)}
                    />
                  </div>
                ))}
                <div style={{ color: '#555', fontSize: 9, textAlign: 'right', marginTop: 4 }}>
                  Total: {NODE_KEYS.reduce((s, k) => s + (nodeWeights.gen2[k] || 0), 0)}
                </div>
              </div>
            </div>
          )}

          {/* ── MOVES TAB ── */}
          {loaded && tab === 'moves' && (
            <div>
              <p style={{ color: '#888', fontSize: 9, lineHeight: 1.6, marginBottom: 8 }}>
                Base power for each move per type and tier. Tier 0 = early, Tier 2 = endgame.
              </p>
              {TYPES.map(type => (
                moves[type] ? (
                  <div key={type} style={{ marginBottom: 10, background: '#1a1a1a', borderRadius: 6, padding: '8px 10px', border: '1px solid #2a2a2a' }}>
                    <div style={{ color: '#e8c840', fontSize: 8, fontFamily: "'Press Start 2P', monospace", marginBottom: 6 }}>{type}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                      {(['physical','special'] as const).map(kind => (
                        <div key={kind}>
                          <div style={{ color: '#888', fontSize: 9, marginBottom: 4, textTransform: 'capitalize' }}>{kind}</div>
                          {(moves[type][kind] || []).map((mv, tier) => (
                            <div key={tier} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 0', borderBottom: '1px solid #222' }}>
                              <span style={{ color: '#aaa', fontSize: 9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 90 }} title={mv.name}>{mv.name}</span>
                              <input
                                type="number" style={{ ...inputStyle, width: 48 }} min="0" max="250" step="5"
                                value={mv.power}
                                onChange={e => updateMovePower(type, kind, tier, parseInt(e.target.value) || 0)}
                              />
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null
              ))}
            </div>
          )}

          {/* ── LEVEL TAB ── */}
          {loaded && tab === 'level' && (
            <div>
              <p style={{ color: '#888', fontSize: 9, lineHeight: 1.6, marginBottom: 12 }}>
                Controls the XP / level gain multiplier after each battle. 1 = normal, 2 = double levels, 0.5 = slower.
              </p>
              <div style={sectionTitle}>XP Gain Multiplier</div>
              <div style={labelStyle}>
                <span>Base gain multiplier</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="number" style={inputStyle} step="0.1" min="0.1" max="10"
                    value={levelCfg.baseGain}
                    onChange={e => setLevelCfg({ baseGain: parseFloat(e.target.value) || 1 })}
                  />
                  <span style={{ color: '#666', fontSize: 10 }}>×</span>
                </div>
              </div>

              <div style={{ marginTop: 16, padding: 10, background: '#1a1a1a', borderRadius: 6, border: '1px solid #333' }}>
                <div style={{ color: '#e8c840', fontSize: 9, fontFamily: "'Press Start 2P', monospace", marginBottom: 6 }}>Quick Presets</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {[
                    { label: 'Normal (1×)', v: 1 },
                    { label: 'Fast (2×)', v: 2 },
                    { label: 'Turbo (5×)', v: 5 },
                    { label: 'Slow (0.5×)', v: 0.5 },
                  ].map(p => (
                    <button key={p.label} onClick={() => setLevelCfg({ baseGain: p.v })}
                      style={{ background: '#2a2a2a', color: '#ccc', border: '1px solid #555', borderRadius: 4, padding: '4px 8px', fontSize: 9, cursor: 'pointer', fontFamily: 'monospace' }}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ marginTop: 16, color: '#555', fontSize: 9, lineHeight: 1.7 }}>
                <div style={{ color: '#e8c840', fontFamily: "'Press Start 2P', monospace", fontSize: 8, marginBottom: 6 }}>Note</div>
                The game uses a relative gain formula based on enemy level vs your team level.
                This multiplier scales the computed gain up or down uniformly.
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ borderTop: '1px solid #333', padding: '6px 14px', color: '#444', fontSize: 9, fontFamily: 'monospace', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Changes apply on next game load</span>
          <button onClick={() => setGameKey(k => k + 1)}
            style={{ background: 'transparent', color: '#666', border: '1px solid #444', borderRadius: 3, padding: '3px 8px', fontSize: 9, cursor: 'pointer' }}>
            ↺ Reload
          </button>
        </div>
      </div>
      )}
    </div>
  );
}
