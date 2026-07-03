import { Hono } from 'hono';

/**
 * Co-op PvP relay — in-memory, host-authoritative.
 *
 * The host runs the real game and resolves every battle round. This server is a
 * dumb store/relay polled ~1s by both clients:
 *   - host writes `snapshot`  (authoritative view the guest renders)  -> guest reads it
 *   - guest writes `guestMsg` (its chosen action)                     -> host reads it
 * Each channel carries a monotonic `seq` so a poller can tell when something new
 * arrived. Lobbies live in a Map and are evicted after 30 min of inactivity.
 *
 * No login: clients identify with a locally-generated clientId + a username.
 */

type Channel = { seq: number; data: unknown };

interface Player {
  clientId: string;
  username: string;
  lastSeen: number;
}

interface Lobby {
  code: string;
  createdAt: number;
  lastActivity: number;
  turnTimer: number;            // seconds per turn, host-configured
  status: 'waiting' | 'playing' | 'ended';
  host: Player;
  guest: Player | null;
  host2guest: Channel;          // host-authoritative snapshot for the guest
  guest2host: Channel;          // guest's submitted action for the host
}

const lobbies = new Map<string, Lobby>();
const IDLE_MS = 30 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [code, l] of lobbies) {
    if (now - l.lastActivity > IDLE_MS) lobbies.delete(code);
  }
}

function genCode(): string {
  // Unambiguous uppercase set (no O/0/I/1)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  } while (lobbies.has(code));
  return code;
}

function publicView(l: Lobby, clientId: string) {
  const role = l.host.clientId === clientId ? 'host'
             : l.guest?.clientId === clientId ? 'guest'
             : 'spectator';
  return {
    code: l.code,
    status: l.status,
    turnTimer: l.turnTimer,
    role,
    host: { username: l.host.username, connected: Date.now() - l.host.lastSeen < 5000 },
    guest: l.guest ? { username: l.guest.username, connected: Date.now() - l.guest.lastSeen < 5000 } : null,
    // the poller receives BOTH channels; the client picks the one meant for its role
    host2guest: l.host2guest,
    guest2host: l.guest2host,
  };
}

const coop = new Hono()

  // Create a lobby. Returns the join code.
  .post('/create', async (c) => {
    sweep();
    const { clientId, username, turnTimer } = await c.req.json<{ clientId: string; username: string; turnTimer?: number }>();
    if (!clientId || !username) return c.json({ error: 'clientId and username required' }, 400);
    const now = Date.now();
    const code = genCode();
    const lobby: Lobby = {
      code, createdAt: now, lastActivity: now,
      turnTimer: Math.max(10, Math.min(300, Number(turnTimer) || 60)),
      status: 'waiting',
      host: { clientId, username: username.slice(0, 20), lastSeen: now },
      guest: null,
      host2guest: { seq: 0, data: null },
      guest2host: { seq: 0, data: null },
    };
    lobbies.set(code, lobby);
    return c.json({ code, view: publicView(lobby, clientId) }, 200);
  })

  // Join an existing lobby by code.
  .post('/join', async (c) => {
    sweep();
    const { clientId, username, code } = await c.req.json<{ clientId: string; username: string; code: string }>();
    if (!clientId || !username || !code) return c.json({ error: 'clientId, username, code required' }, 400);
    const lobby = lobbies.get(code.toUpperCase().trim());
    if (!lobby) return c.json({ error: 'Lobby not found' }, 404);
    const now = Date.now();
    // Rejoin support: same clientId re-entering keeps its seat.
    if (lobby.host.clientId === clientId) {
      lobby.host.lastSeen = now; lobby.lastActivity = now;
      return c.json({ view: publicView(lobby, clientId) }, 200);
    }
    if (lobby.guest && lobby.guest.clientId === clientId) {
      lobby.guest.lastSeen = now; lobby.lastActivity = now;
      return c.json({ view: publicView(lobby, clientId) }, 200);
    }
    if (lobby.guest) return c.json({ error: 'Lobby is full' }, 409);
    lobby.guest = { clientId, username: username.slice(0, 20), lastSeen: now };
    lobby.lastActivity = now;
    return c.json({ view: publicView(lobby, clientId) }, 200);
  })

  // Poll the lobby state. Both clients hit this ~1s.
  .get('/state', (c) => {
    const code = (c.req.query('code') || '').toUpperCase().trim();
    const clientId = c.req.query('clientId') || '';
    const lobby = lobbies.get(code);
    if (!lobby) return c.json({ error: 'Lobby not found' }, 404);
    const now = Date.now();
    if (lobby.host.clientId === clientId) lobby.host.lastSeen = now;
    else if (lobby.guest?.clientId === clientId) lobby.guest.lastSeen = now;
    lobby.lastActivity = now;
    return c.json({ view: publicView(lobby, clientId) }, 200);
  })

  // Host pushes the authoritative snapshot the guest renders.
  .post('/snapshot', async (c) => {
    const { clientId, code, data } = await c.req.json<{ clientId: string; code: string; data: unknown }>();
    const lobby = lobbies.get((code || '').toUpperCase().trim());
    if (!lobby) return c.json({ error: 'Lobby not found' }, 404);
    if (lobby.host.clientId !== clientId) return c.json({ error: 'Only host can push snapshot' }, 403);
    lobby.host2guest = { seq: lobby.host2guest.seq + 1, data };
    lobby.host.lastSeen = Date.now();
    lobby.lastActivity = Date.now();
    return c.json({ seq: lobby.host2guest.seq }, 200);
  })

  // Guest submits an action (move/switch) for the host to resolve.
  .post('/action', async (c) => {
    const { clientId, code, data } = await c.req.json<{ clientId: string; code: string; data: unknown }>();
    const lobby = lobbies.get((code || '').toUpperCase().trim());
    if (!lobby) return c.json({ error: 'Lobby not found' }, 404);
    if (lobby.guest?.clientId !== clientId) return c.json({ error: 'Only guest can submit action' }, 403);
    lobby.guest2host = { seq: lobby.guest2host.seq + 1, data };
    lobby.guest.lastSeen = Date.now();
    lobby.lastActivity = Date.now();
    return c.json({ seq: lobby.guest2host.seq }, 200);
  })

  // Host flips lobby status (waiting -> playing -> ended). Guest may only set 'ended' on leave.
  .post('/status', async (c) => {
    const { clientId, code, status, turnTimer } = await c.req.json<{ clientId: string; code: string; status: Lobby['status']; turnTimer?: number }>();
    const lobby = lobbies.get((code || '').toUpperCase().trim());
    if (!lobby) return c.json({ error: 'Lobby not found' }, 404);
    if (lobby.host.clientId !== clientId) return c.json({ error: 'Only host can set status' }, 403);
    if (status) lobby.status = status;
    if (turnTimer !== undefined) lobby.turnTimer = Math.max(10, Math.min(300, Number(turnTimer) || 60));
    lobby.lastActivity = Date.now();
    return c.json({ view: publicView(lobby, clientId) }, 200);
  })

  // Leave / close a lobby.
  .post('/leave', async (c) => {
    const { clientId, code } = await c.req.json<{ clientId: string; code: string }>();
    const lobby = lobbies.get((code || '').toUpperCase().trim());
    if (!lobby) return c.json({ ok: true }, 200);
    if (lobby.host.clientId === clientId) {
      lobby.status = 'ended';
      lobbies.delete(lobby.code);
    } else if (lobby.guest?.clientId === clientId) {
      lobby.guest = null;
      lobby.status = 'waiting';
      lobby.lastActivity = Date.now();
    }
    return c.json({ ok: true }, 200);
  });

export default coop;
