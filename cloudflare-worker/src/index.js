import { DurableObject } from 'cloudflare:workers';

const EMOJIS = new Set(['😝', '🤬', '😭', '🤣', '🖕']);
const ROOM_CODE_RE = /^\d{4}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY = 16_384;
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGIN || '';
  if (allowed && origin !== allowed) return {};
  return {
    'access-control-allow-origin': origin || allowed || '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,apikey',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) throw new HttpError(413, '요청 크기가 너무 커.');
  let body;
  try { body = await request.json(); } catch { throw new HttpError(400, '요청 JSON을 읽을 수 없어.'); }
  if (JSON.stringify(body).length > MAX_BODY) throw new HttpError(413, '요청 크기가 너무 커.');
  return body;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function authenticate(request, env) {
  const bearer = request.headers.get('Authorization') || '';
  const token = bearer.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError(401, '로그인한 계정만 이용할 수 있어.');
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new HttpError(401, '로그인 정보가 만료됐어. 다시 로그인해줘.');
  const user = await res.json();
  if (!UUID_RE.test(user.id || '') || user.is_anonymous) throw new HttpError(401, '계정 정보를 확인할 수 없어.');
  return { id: user.id, token, ownerName: String(user.user_metadata?.owner_name || '구단주').slice(0, 32) };
}

async function rateLimit(request, env, key, max = 12, windowMs = 60_000) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const id = env.RATE_LIMITER.idFromName(`${key}:${ip}`);
  const response = await env.RATE_LIMITER.get(id).fetch('https://limit/check', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ max, windowMs }),
  });
  if (!response.ok) throw new HttpError(429, '요청이 너무 많아. 잠시 뒤 다시 시도해줘.');
}

async function roomCall(env, code, path, body = {}, method = 'POST') {
  const id = env.MATCH_ROOMS.idFromName(`room:${code}`);
  return env.MATCH_ROOMS.get(id).fetch(`https://match-room${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body),
  });
}

async function inboxCall(env, userId, path, body = {}, method = 'POST') {
  const id = env.MATCH_ROOMS.idFromName(`inbox:${userId}`);
  return env.MATCH_ROOMS.get(id).fetch(`https://match-inbox${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body),
  });
}

async function verifyFriends(env, token, me, friendId) {
  if (!UUID_RE.test(friendId || '') || friendId === me) throw new HttpError(400, '친구 계정을 확인할 수 없어.');
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/social_friendships`);
  url.searchParams.set('select', 'id');
  url.searchParams.set('status', 'eq.accepted');
  url.searchParams.set('or', `(and(requester_id.eq.${me},addressee_id.eq.${friendId}),and(requester_id.eq.${friendId},addressee_id.eq.${me}))`);
  const res = await fetch(url, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new HttpError(403, '친구 목록을 확인하지 못했어. Supabase 친구 RLS를 확인해줘.');
  const rows = await res.json();
  if (!rows.length) throw new HttpError(403, '수락된 친구에게만 매치를 신청할 수 있어.');
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') {
      if (!Object.keys(cors).length) return new Response('허용되지 않은 Origin', { status: 403 });
      return new Response(null, { status: 204, headers: cors });
    }
    const url = new URL(request.url);
    try {
      if (request.headers.get('Origin') && !Object.keys(cors).length) throw new HttpError(403, '허용되지 않은 사이트야.');
      if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true, service: 'yfm-online-friendly' }, 200, cors);
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        const wsMatch = url.pathname.match(/^\/v1\/rooms\/(\d{4})\/ws$/);
        if (!wsMatch) throw new HttpError(404, 'WebSocket 경로를 찾을 수 없어.');
        const code = wsMatch[1];
        const ticket = url.searchParams.get('ticket') || '';
        if (!ticket) throw new HttpError(401, '접속권이 없어.');
        const id = env.MATCH_ROOMS.idFromName(`room:${code}`);
        const target = new URL(`https://match-room/internal/upgrade?ticket=${encodeURIComponent(ticket)}`);
        return env.MATCH_ROOMS.get(id).fetch(new Request(target, request));
      }

      const user = await authenticate(request, env);
      const path = url.pathname;

      if (path === '/v1/rooms' && request.method === 'POST') {
        await rateLimit(request, env, 'create', 8);
        for (let i = 0; i < 20; i++) {
          const code = String(crypto.getRandomValues(new Uint16Array(1))[0] % 10000).padStart(4, '0');
          const response = await roomCall(env, code, '/internal/create', { user: { id: user.id, ownerName: user.ownerName }, code });
          if (response.status === 201) return json(await response.json(), 201, cors);
        }
        throw new HttpError(503, '방 코드를 만들지 못했어. 다시 시도해줘.');
      }

      let m = path.match(/^\/v1\/rooms\/(\d{4})\/(join|ticket|invite|state)$/);
      if (m) {
        const [, code, action] = m;
        if (!ROOM_CODE_RE.test(code)) throw new HttpError(400, '방 코드는 숫자 4자리야.');
        if (action === 'join' && request.method === 'POST') {
          await rateLimit(request, env, 'join', 12);
          const response = await roomCall(env, code, '/internal/join', { user: { id: user.id, ownerName: user.ownerName } });
          return json(await response.json(), response.status, cors);
        }
        if (action === 'ticket' && request.method === 'POST') {
          const response = await roomCall(env, code, '/internal/ticket', { user: { id: user.id, ownerName: user.ownerName } });
          return json(await response.json(), response.status, cors);
        }
        if (action === 'state' && request.method === 'GET') {
          const response = await roomCall(env, code, '/internal/member-state', { user: { id: user.id } });
          return json(await response.json(), response.status, cors);
        }
        if (action === 'invite' && request.method === 'POST') {
          await rateLimit(request, env, 'invite', 10);
          const { friendId } = await readJson(request);
          await verifyFriends(env, user.token, user.id, friendId);
          const room = await (await roomCall(env, code, '/internal/member-state', { user: { id: user.id } })).json();
          if (!room.ok) throw new HttpError(403, '먼저 이 매치 방에 참가해줘.');
          const inviteId = crypto.randomUUID();
          const invited = await inboxCall(env, friendId, '/internal/push', {
            id: inviteId, roomCode: code, fromUserId: user.id, fromOwnerName: user.ownerName,
            createdAt: Date.now(), expiresAt: Date.now() + 5 * 60_000,
          });
          if (!invited.ok) throw new HttpError(409, '친구의 초대함이 가득 찼거나 요청이 만료됐어.');
          return json({ ok: true, inviteId }, 201, cors);
        }
      }

      if (path === '/v1/invites' && request.method === 'GET') {
        const response = await inboxCall(env, user.id, '/internal/list', {}, 'GET');
        return json(await response.json(), response.status, cors);
      }
      m = path.match(/^\/v1\/invites\/([0-9a-f-]+)\/(accept|decline)$/i);
      if (m && request.method === 'POST') {
        const [, inviteId, action] = m;
        const response = await inboxCall(env, user.id, '/internal/consume', { id: inviteId });
        const inviteResult = await response.json();
        if (!response.ok || !inviteResult.invite) throw new HttpError(404, '친구 초대가 없거나 만료됐어.');
        const invite = inviteResult.invite;
        if (action === 'decline') return json({ ok: true, declined: true }, 200, cors);
        await verifyFriends(env, user.token, user.id, invite.fromUserId);
        const joined = await roomCall(env, invite.roomCode, '/internal/join', { user: { id: user.id, ownerName: user.ownerName } });
        return json({ ...(await joined.json()), roomCode: invite.roomCode }, joined.status, cors);
      }
      throw new HttpError(404, '요청 경로를 찾을 수 없어.');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('online-friendly Worker error', error);
      return json({ error: status === 500 ? '서버 오류가 발생했어.' : error.message }, status, cors);
    }
  },
};

export class MatchRoom extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; this.env = env; }
  async load() { return await this.ctx.storage.get('room') || null; }
  async save(room) { await this.ctx.storage.put('room', room); }
  reply(data, status = 200) { return json(data, status); }
  broadcast(data, exceptUser = null) {
    const text = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      const userId = ws.deserializeAttachment()?.userId;
      if (exceptUser && userId === exceptUser) continue;
      try { ws.send(text); } catch {}
    }
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/internal/inbox') || url.pathname.startsWith('/internal/push') || url.pathname.startsWith('/internal/list') || url.pathname.startsWith('/internal/consume')) return this.inbox(request, url);
    if (url.pathname === '/internal/create') {
      const existing = await this.load();
      if (existing && existing.expiresAt > Date.now()) return this.reply({ error: 'occupied' }, 409);
      const { user, code } = await request.json();
      const room = { kind: 'room', createdAt: Date.now(), expiresAt: Date.now() + 90 * 60_000, phase: 'waiting', half: 1, players: [{ id: user.id, ownerName: user.ownerName, ready: false }], pauseCounts: {}, pausedBy: null, tickets: {} };
      room.code = code;
      await this.save(room); await this.ctx.storage.setAlarm(room.expiresAt);
      return this.reply({ ok: true, code, room: this.publicRoom(room) }, 201);
    }
    let room = await this.load();
    if (url.pathname === '/internal/join') {
      const { user } = await request.json();
      if (!room || room.expiresAt <= Date.now()) return this.reply({ error: '방이 없거나 만료됐어.' }, 404);
      if (room.players.some(p => p.id === user.id)) return this.reply({ ok: true, room: this.publicRoom(room), role: room.players[0].id === user.id ? 'home' : 'away' });
      if (room.phase !== 'waiting' || room.players.length >= 2) return this.reply({ error: '이미 두 명이 참가했거나 경기가 시작됐어.' }, 409);
      room.players.push({ id: user.id, ownerName: user.ownerName, ready: false });
      await this.save(room); this.broadcast({ type: 'room_update', room: this.publicRoom(room) });
      return this.reply({ ok: true, room: this.publicRoom(room), role: 'away' }, 200);
    }
    if (url.pathname === '/internal/member-state') {
      const { user } = await request.json();
      if (!room || !room.players.some(p => p.id === user.id)) return this.reply({ ok: false, error: '방 참가자가 아니야.' }, 403);
      return this.reply({ ok: true, room: this.publicRoom(room), role: room.players[0].id === user.id ? 'home' : 'away' });
    }
    if (url.pathname === '/internal/ticket') {
      const { user } = await request.json();
      if (!room || room.expiresAt <= Date.now() || !room.players.some(p => p.id === user.id)) return this.reply({ error: '방 참가자가 아니거나 만료됐어.' }, 403);
      const ticket = crypto.randomUUID(); room.tickets[ticket] = { userId: user.id, expiresAt: Date.now() + 60_000 };
      await this.save(room); return this.reply({ ok: true, ticket, expiresInSeconds: 60 });
    }
    if (url.pathname === '/internal/upgrade' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      if (!room) return this.reply({ error: '방이 없어.' }, 404);
      const ticket = url.searchParams.get('ticket') || '';
      const grant = room.tickets[ticket];
      if (!grant || grant.expiresAt < Date.now() || !room.players.some(p => p.id === grant.userId)) return this.reply({ error: '접속권이 만료됐어.' }, 401);
      delete room.tickets[ticket]; await this.save(room);
      const pair = new WebSocketPair(); const client = pair[0], server = pair[1];
      this.ctx.acceptWebSocket(server); server.serializeAttachment({ userId: grant.userId });
      server.send(JSON.stringify({ type: 'hello', room: this.publicRoom(room), role: room.players[0].id === grant.userId ? 'home' : 'away' }));
      return new Response(null, { status: 101, webSocket: client });
    }
    return this.reply({ error: 'unknown route' }, 404);
  }
  publicRoom(room) {
    return { phase: room.phase, half: room.half, players: room.players.map(({ id, ownerName, ready }) => ({ id, ownerName, ready })), pauseCounts: room.pauseCounts, pausedBy: room.pausedBy };
  }
  async inbox(request, url) {
    if (url.pathname === '/internal/inbox-init') { await this.ctx.storage.put('inbox', true); return this.reply({ ok: true }); }
    if (url.pathname === '/internal/push' && request.method === 'POST') {
      await this.ctx.storage.put('inbox', true);
      const { invites = [] } = await this.ctx.storage.get('invites') || {};
      const invite = await request.json();
      const active = invites.filter(x => x.expiresAt > Date.now());
      if (active.length >= 20) return this.reply({ error: 'full' }, 409);
      active.push(invite); await this.ctx.storage.put('invites', { invites: active });
      return this.reply({ ok: true });
    }
    if (url.pathname === '/internal/list' && request.method === 'GET') {
      const { invites = [] } = await this.ctx.storage.get('invites') || {};
      const active = invites.filter(x => x.expiresAt > Date.now());
      await this.ctx.storage.put('invites', { invites: active });
      return this.reply({ invites: active });
    }
    if (url.pathname === '/internal/consume' && request.method === 'POST') {
      const { id } = await request.json(); const { invites = [] } = await this.ctx.storage.get('invites') || {};
      const invite = invites.find(x => x.id === id && x.expiresAt > Date.now());
      await this.ctx.storage.put('invites', { invites: invites.filter(x => x.id !== id && x.expiresAt > Date.now()) });
      return invite ? this.reply({ invite }) : this.reply({ error: 'not found' }, 404);
    }
    return this.reply({ error: 'unknown inbox route' }, 404);
  }
  async webSocketMessage(ws, message) {
    const member = ws.deserializeAttachment(); if (!member?.userId) return ws.close(1008, '인증 정보가 없어.');
    if (typeof message !== 'string' || message.length > MAX_BODY) return ws.close(1009, '메시지가 너무 커.');
    let event; try { event = JSON.parse(message); } catch { return ws.close(1003, 'JSON 메시지만 허용돼.'); }
    if (!event || typeof event.type !== 'string') return;
    const room = await this.load(); if (!room || room.expiresAt <= Date.now()) return ws.close(1008, '방이 만료됐어.');
    const player = room.players.find(p => p.id === member.userId); if (!player) return ws.close(1008, '방 참가자가 아니야.');
    if (event.type === 'emoji') {
      if (!EMOJIS.has(event.emoji)) return;
      const now = Date.now(), key = `emoji:${member.userId}`, last = await this.ctx.storage.get(key) || 0;
      if (now - last < 1200) return;
      await this.ctx.storage.put(key, now);
      return this.broadcast({ type: 'emoji', userId: member.userId, emoji: event.emoji, at: now });
    }
    if (event.type === 'pause') {
      if (room.phase !== 'playing' || room.pausedBy) return;
      const counts = room.pauseCounts[room.half] || (room.pauseCounts[room.half] = {});
      const used = Number(counts[member.userId] || 0);
      if (used >= 3) return ws.send(JSON.stringify({ type: 'error', error: `이번 ${room.half === 1 ? '전반' : '후반'} 전술 정지 횟수를 다 썼어.` }));
      counts[member.userId] = used + 1; room.pausedBy = member.userId; await this.save(room);
      return this.broadcast({ type: 'paused', userId: member.userId, half: room.half, remaining: 3 - used - 1 });
    }
    if (event.type === 'resume') {
      if (room.pausedBy !== member.userId) return;
      room.pausedBy = null; await this.save(room); return this.broadcast({ type: 'resumed', userId: member.userId });
    }
    if (event.type === 'half' && player.id === room.players[0]?.id) {
      const next = Number(event.half);
      if (next === 2 && room.half === 1) { room.half = 2; room.pausedBy = null; await this.save(room); return this.broadcast({ type: 'half', half: 2, pauseCounts: room.pauseCounts }); }
      return;
    }
    if (event.type === 'ready') {
      player.ready = !!event.ready;
      if (event.team && JSON.stringify(event.team).length <= 12_000) player.team = event.team;
      if (room.players.length === 2 && room.players.every(p => p.ready)) room.phase = 'ready';
      await this.save(room); return this.broadcast({ type: 'room_update', room: this.publicRoom(room), teams: room.players.map(p => ({ id: p.id, team: p.team || null })) });
    }
    if (event.type === 'start' && player.id === room.players[0]?.id && room.players.length === 2 && room.players.every(p => p.ready)) {
      room.phase = 'playing'; await this.save(room); return this.broadcast({ type: 'match_start', room: this.publicRoom(room), teams: room.players.map(p => ({ id: p.id, team: p.team || null })) });
    }
    if (event.type === 'state' && player.id === room.players[0]?.id) {
      if (JSON.stringify(event.state ?? {}).length > 12_000) return;
      return this.broadcast({ type: 'state', state: event.state, at: Date.now() }, member.userId);
    }
    if (event.type === 'tactic' || event.type === 'sub') {
      const payload = JSON.stringify(event.data ?? {}); if (payload.length > 2_000) return;
      return this.broadcast({ type: event.type, userId: member.userId, data: event.data }, member.userId);
    }
    if (event.type === 'forfeit') return this.broadcast({ type: 'forfeit', userId: member.userId });
  }
  async webSocketClose(ws, code, reason) { ws.close(code, reason); const userId = ws.deserializeAttachment()?.userId; if (userId) this.broadcast({ type: 'player_disconnected', userId }); }
  async webSocketError(ws) { ws.close(1011, '연결 오류'); }
  async alarm() { await this.ctx.storage.deleteAll(); for (const ws of this.ctx.getWebSockets()) ws.close(1000, '방 만료'); }
}

export class RateLimiter extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; }
  async fetch(request) {
    const { max = 12, windowMs = 60_000 } = await request.json();
    const now = Date.now(), bucket = await this.ctx.storage.get('bucket');
    if (!bucket || now - bucket.start >= windowMs) {
      await this.ctx.storage.put('bucket', { start: now, count: 1 });
      await this.ctx.storage.setAlarm(now + windowMs);
      return new Response('ok');
    }
    if (bucket.count >= max) return new Response('rate limited', { status: 429 });
    bucket.count++; await this.ctx.storage.put('bucket', bucket); return new Response('ok');
  }
  async alarm() { await this.ctx.storage.delete('bucket'); }
    }
