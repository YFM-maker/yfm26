/*
 * Include this classic script after the game's main inline script.
 * The game must expose getOwnerRankClient() (already present in this HTML build).
 */
(() => {
  'use strict';
  const CFG = { workerUrl: 'https://yfm26.suhyeho7142-3df.workers.dev' };

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

  const $ = id => document.getElementById(id);
  const screenIsOpen = () => document.querySelector('.screen.active')?.id === 'screen-online-friendly';
  let myId = null, room = null, ready = false, inviteTimer = null;
  const status = (message, bad = false) => { const el = $('yfm-online-status'); if (el) { el.textContent = message; el.style.color = bad ? '#fca5a5' : '#c4b5fd'; } };
  function showRoom(code) {
    room = code;
    $('yfm-online-room').style.display = 'block';
    $('yfm-online-room-code').textContent = code;
    $('yfm-online-emojis').style.display = 'block';
  }
  function renderRoom(data) {
    if (!data) return;
    const members = $('yfm-online-members'); members.replaceChildren();
    for (const p of data.players || []) {
      const card = document.createElement('div');
      card.style.cssText = 'background:#100c20;border:1px solid #493b65;border-radius:9px;padding:10px';
      const name = document.createElement('b'); name.textContent = p.ownerName || '구단주';
      const state = document.createElement('div'); state.style.cssText = 'font-size:12px;color:#cbd5e1;margin-top:4px';
      state.textContent = p.ready ? '✅ 준비 완료' : '⏳ 준비 중';
      card.append(name, state); members.append(card);
    }
    const me = (data.players || []).find(p => p.id === myId);
    ready = !!me?.ready;
    $('yfm-online-ready').textContent = ready ? '준비 취소' : '준비하기';
    const host = (data.players || [])[0]?.id === myId;
    const fullAndReady = (data.players || []).length === 2 && (data.players || []).every(p => p.ready);
    $('yfm-online-start').style.display = host && fullAndReady && data.phase !== 'playing' ? 'inline-block' : 'none';
    $('yfm-online-room-status').textContent = data.phase === 'playing'
      ? '매치 방이 시작됐어. 게임 경기 화면 동기화는 아직 연결 중이야.'
      : (data.players || []).length < 2 ? '친구가 참가하면 두 명 모두 준비 버튼을 눌러줘.' : (fullAndReady ? '두 명 다 준비 완료야. 경기 화면 연결을 마무리 중이야.' : '두 명 모두 준비 버튼을 눌러줘.');
  }
  function onRoomMessage(message) {
    if (message.type === 'hello') { renderRoom(message.room); status('매치 서버에 연결됐어.'); }
    else if (message.type === 'room_update') renderRoom(message.room);
    else if (message.type === 'match_start') renderRoom(message.room);
    else if (message.type === 'emoji') {
      const feed = $('yfm-online-emoji-feed'); if (feed) { feed.textContent = `${message.emoji} 상대가 감정표현을 보냈어`; setTimeout(() => { if (feed.textContent.startsWith(message.emoji)) feed.textContent = ''; }, 3000); }
    } else if (message.type === 'player_disconnected') status('상대 연결이 끊어졌어. 상대가 다시 접속할 때까지 기다려줘.', true);
    else if (message.type === 'error') status(message.error || '매치 서버 오류', true);
  }
  async function currentUserId() {
    if (typeof accountUser !== 'undefined' && accountUser?.id) return myId = accountUser.id;
    const { data, error } = await window.getOwnerRankClient().auth.getSession();
    if (error) throw error;
    if (!data.session?.user || data.session.user.is_anonymous) throw new Error('먼저 게임 계정으로 로그인해줘.');
    return myId = data.session.user.id;
  }
  function localTeam() {
    const roster = (typeof players !== 'undefined' ? players : []).filter(p => p.isStarting).slice(0, 11).map(p => ({
      name: String(p.name || '선수').slice(0, 24), position: String(p.position || '-').slice(0, 4),
      ovr: Math.round(Number(typeof getCalculatedOvr === 'function' ? getCalculatedOvr(p) : p.ovr) || 0)
    }));
    return { ownerName: (typeof accountUser !== 'undefined' && accountUser?.user_metadata?.owner_name) || '구단주', clubName: String(typeof teamName !== 'undefined' ? teamName : '내 팀').slice(0, 24), ovr: Number(typeof getTeamOvr === 'function' ? getTeamOvr() : 0) || 0, roster };
  }
  async function connectTo(code) {
    showRoom(code);
    status('매치 서버에 연결하는 중...');
    await window.yfmOnline.connect(code, onRoomMessage, state => {
      if (state === 'connected') status('매치 서버에 연결됐어.');
      else if (state === 'disconnected' && screenIsOpen()) status('매치 서버 연결이 끊어졌어.', true);
    });
  }
  async function createRoom() {
    try { await currentUserId(); const result = await window.yfmOnline.createRoom(); await connectTo(result.code); status('방을 만들었어. 코드를 친구에게 보내줘.'); }
    catch (e) { status(e.message || '방을 만들지 못했어.', true); }
  }
  async function joinRoom() {
    const code = ($('yfm-online-code').value || '').trim();
    if (!/^\d{4}$/.test(code)) return status('방 코드는 숫자 4자리로 입력해줘.', true);
    try { await currentUserId(); await window.yfmOnline.joinRoom(code); await connectTo(code); status('방에 참가했어. 둘 다 준비하면 시작할 수 있어.'); }
    catch (e) { status(e.message || '방에 참가하지 못했어.', true); }
  }
  async function toggleReady() {
    try {
      await currentUserId();
      const team = localTeam();
      if (!ready && team.roster.length !== 11) return status('선발 선수 11명을 먼저 구성해줘.', true);
      window.yfmOnline.setReady(!ready, team);
    }
    catch (e) { status(e.message || '준비 상태를 바꾸지 못했어.', true); }
  }
  function renderFriends(profiles) {
    const box = $('yfm-online-friends'); box.replaceChildren();
    if (!profiles.length) { box.textContent = '수락한 친구가 없어. 소셜에서 먼저 친구를 추가해줘.'; return; }
    for (const profile of profiles) {
      const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #382e4d';
      const label = document.createElement('span'); label.textContent = profile.owner_name || profile.username || '친구';
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '매치 신청';
      button.style.cssText = 'background:#7c3aed;border-radius:8px;padding:7px 10px;font-weight:800;white-space:nowrap';
      button.addEventListener('click', async () => {
        if (!room) return status('먼저 방을 만들거나 코드로 참가해줘.', true);
        try { await window.yfmOnline.inviteFriend(room, profile.user_id); status(`${label.textContent}님에게 매치 신청을 보냈어.`); }
        catch (e) { status(e.message || '친구 초대를 보내지 못했어.', true); }
      });
      row.append(label, button); box.append(row);
    }
  }
  async function loadFriends() {
    const box = $('yfm-online-friends'); if (!box || typeof accountUser === 'undefined' || !accountUser) return;
    try {
      const client = window.getOwnerRankClient();
      const { data: links, error } = await client.from('social_friendships').select('requester_id,addressee_id,status').eq('status', 'accepted').or(`requester_id.eq.${myId},addressee_id.eq.${myId}`);
      if (error) throw error;
      const ids = [...new Set((links || []).map(x => x.requester_id === myId ? x.addressee_id : x.requester_id))];
      if (!ids.length) return renderFriends([]);
      const { data, error: profileError } = await client.from('social_profiles').select('user_id,username,owner_name').in('user_id', ids);
      if (profileError) throw profileError;
      renderFriends(data || []);
    } catch (e) { box.textContent = `친구 목록 오류: ${e.message || 'SQL 연결을 확인해줘.'}`; }
  }
  async function loadInvites() {
    const box = $('yfm-online-invites'); if (!box || typeof accountUser === 'undefined' || !accountUser || !screenIsOpen()) return;
    try {
      const data = await window.yfmOnline.listInvites(); box.replaceChildren();
      if (!data.invites?.length) { box.textContent = '새로 온 신청이 없어.'; return; }
      for (const invite of data.invites) {
        const row = document.createElement('div'); row.style.cssText = 'padding:9px 0;border-bottom:1px solid #382e4d';
        const title = document.createElement('div'); title.textContent = `${invite.fromOwnerName || '친구'}님 · 방 ${invite.roomCode}`;
        const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:7px;margin-top:7px';
        const accept = document.createElement('button'); accept.textContent = '수락'; accept.style.cssText = 'background:#0f766e;border-radius:8px;padding:6px 12px;font-weight:800';
        accept.addEventListener('click', async () => { try { await window.yfmOnline.acceptInvite(invite.id); await connectTo(invite.roomCode); status('친구의 방에 참가했어.'); await loadInvites(); } catch (e) { status(e.message || '초대를 수락하지 못했어.', true); } });
        const decline = document.createElement('button'); decline.textContent = '거절'; decline.style.cssText = 'background:#334155;border-radius:8px;padding:6px 12px;font-weight:800';
        decline.addEventListener('click', async () => { try { await window.yfmOnline.declineInvite(invite.id); await loadInvites(); } catch (e) { status(e.message || '초대를 정리하지 못했어.', true); } });
        actions.append(accept, decline); row.append(title, actions); box.append(row);
      }
    } catch (e) { box.textContent = `신청을 불러오지 못했어: ${e.message || ''}`; }
  }
  async function loadUi() {
    if (!screenIsOpen()) return;
    try { await currentUserId(); await Promise.all([loadFriends(), loadInvites()]); }
    catch (e) { status(e.message || '로그인 상태를 확인해줘.', true); }
  }
  window.yfmOnlineUiLoad = loadUi;
  window.yfmOnlineCreateRoom = createRoom;
  window.yfmOnlineJoinRoom = joinRoom;
  window.yfmOnlineToggleReady = toggleReady;
  window.yfmOnlineEmoji = emoji => { try { window.yfmOnline.emoji(emoji); } catch (e) { status(e.message, true); } };
  window.yfmOnlineCopyCode = async () => { try { await navigator.clipboard.writeText(room || $('yfm-online-room-code').textContent); status('방 코드를 복사했어.'); } catch { status('코드를 길게 눌러 복사해줘.'); } };
  window.yfmOnlineLeaveRoom = async () => { await window.yfmOnline.disconnect(); room = null; $('yfm-online-room').style.display = 'none'; status('방에서 나왔어.'); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && screenIsOpen()) loadUi(); });
  inviteTimer = setInterval(() => { if (screenIsOpen()) loadInvites(); }, 15000);
  document.addEventListener('DOMContentLoaded', () => { if (screenIsOpen()) loadUi(); });
})();
