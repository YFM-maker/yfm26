/*
 * Include this classic script after the game's main inline script.
 * The game must expose getOwnerRankClient() (already present in this HTML build).
 */
(() => {
  'use strict';
  const CFG = { workerUrl: 'https://yfm-online-friendly.YOUR_SUBDOMAIN.workers.dev' };

  class YFMOnlineClient {
    constructor(workerUrl = CFG.workerUrl) {
      this.base = workerUrl.replace(/\/$/, '');
      this.ws = null;
      this.roomCode = null;
      this.role = null;
      this.handlers = new Set();
    }
    async token() {
      if (typeof getOwnerRankClient !== 'function') throw new Error('게임 Supabase 클라이언트를 찾지 못했어.');
      const { data, error } = await getOwnerRankClient().auth.getSession();
      if (error) throw error;
      if (!data.session?.access_token) throw new Error('로그인한 뒤 온라인 친선전을 이용해줘.');
      return data.session.access_token;
    }
    async request(path, { method = 'GET', body } = {}) {
      const token = await this.token();
      const response = await fetch(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Worker 오류 (${response.status})`);
      return data;
    }
    createRoom() { return this.request('/v1/rooms', { method: 'POST', body: {} }); }
    joinRoom(code) { return this.request(`/v1/rooms/${encodeURIComponent(code)}/join`, { method: 'POST', body: {} }); }
    inviteFriend(code, friendId) { return this.request(`/v1/rooms/${encodeURIComponent(code)}/invite`, { method: 'POST', body: { friendId } }); }
    listInvites() { return this.request('/v1/invites'); }
    acceptInvite(id) { return this.request(`/v1/invites/${encodeURIComponent(id)}/accept`, { method: 'POST', body: {} }); }
    declineInvite(id) { return this.request(`/v1/invites/${encodeURIComponent(id)}/decline`, { method: 'POST', body: {} }); }
    async connect(code, onMessage = () => {}, onStatus = () => {}) {
      await this.disconnect();
      const ticketData = await this.request(`/v1/rooms/${encodeURIComponent(code)}/ticket`, { method: 'POST', body: {} });
      const wsUrl = this.base.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') +
        `/v1/rooms/${encodeURIComponent(code)}/ws?ticket=${encodeURIComponent(ticketData.ticket)}`;
      const ws = new WebSocket(wsUrl); this.ws = ws; this.roomCode = code;
      ws.addEventListener('open', () => onStatus('connected'));
      ws.addEventListener('close', () => { if (this.ws === ws) this.ws = null; onStatus('disconnected'); });
      ws.addEventListener('error', () => onStatus('error'));
      ws.addEventListener('message', event => {
        let data; try { data = JSON.parse(event.data); } catch { return; }
        if (data.type === 'hello') this.role = data.role;
        onMessage(data); this.handlers.forEach(fn => fn(data));
      });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('매치 연결 시간이 초과됐어.')), 12_000);
        ws.addEventListener('open', () => { clearTimeout(timer); resolve(this); }, { once: true });
        ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('매치 서버에 연결하지 못했어.')); }, { once: true });
      });
    }
    onMessage(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
    send(type, fields = {}) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('매치 서버와 연결되어 있지 않아.');
      this.ws.send(JSON.stringify({ type, ...fields }));
    }
    setReady(ready, team) { this.send('ready', { ready: !!ready, ...(team ? { team } : {}) }); }
    start() { this.send('start'); }
    pause() { this.send('pause'); }
    resume() { this.send('resume'); }
    emoji(emoji) { this.send('emoji', { emoji }); }
    setHalf(half) { this.send('half', { half }); }
    sendTactic(data) { this.send('tactic', { data }); }
    sendSub(data) { this.send('sub', { data }); }
    sendHostState(state) { this.send('state', { state }); }
    forfeit() { this.send('forfeit'); }
    async disconnect() {
      const ws = this.ws; this.ws = null; this.roomCode = null; this.role = null;
      if (ws && ws.readyState < WebSocket.CLOSING) ws.close(1000, '화면 종료');
    }
  }
  window.YFMOnlineClient = YFMOnlineClient;
  window.yfmOnline = window.yfmOnline || new YFMOnlineClient();
})();
