# Pokelike Desktop App with Editor

## Goal
- Electron desktop app (.exe)
- Left panel: iframe of the game (game.html in public/)
- Right panel: editor with tabs to tweak game values

## Editor Sections
1. **Shiny Rates** — shiny chance (default 1% / 2% with charm), shiny node chance (72% / 79%)
2. **Node Weights** — Gen1 per-layer weights (battle/catch/item/trainer/question/move_tutor/trade), Gen2 flat weights
3. **Move Power** — edit move power per type/tier
4. **Items** — edit item descriptions/effects text
5. **Level Gain** — XP/level gain multiplier (baseGainOverride)

## How it works
- Editor reads/patches the JS files in public/js/ at runtime via Electron IPC (readFile/writeFile)
- Uses regex to find and replace specific values
- Game is displayed in a webview/iframe loading /game.html
- "Apply Changes" button rewrites the JS files and reloads the iframe

## Architecture
- React app with two panels: game (iframe) + editor sidebar
- Desktop IPC: readFile / writeFile from template
- Editor parses known patterns in js files and presents UI controls

## Status
- [x] app_init done
- [x] game files copied to public/
- [ ] Build editor UI (pages/index.tsx)
- [ ] Wire up IPC read/write
- [ ] Test build
