# YFM 온라인 친선전 Cloudflare Worker 시작 파일

이 폴더는 **로그인 인증, 4자리 방 코드, 친구 초대함, WebSocket 전달, 하프별 전술 정지 제한, 이모지 전달**을 담당하는 서버 시작 파일이야.

현재 게임의 경기 엔진은 브라우저 한 곳에서 홈팀과 CPU팀을 모두 시뮬레이션해. 그래서 이 Worker만 배포해도 플레이 자체가 온라인으로 바뀌지는 않아. 게임 엔진에서 홈 클라이언트를 권한자로 두고, Worker가 전술·교체 명령을 전달하며, 권한자 화면이 경기 상태를 상대에게 계속 보내도록 연결해야 해. 이 샘플은 그 연결을 위한 네트워크 통로와 방 기능을 준비해.

## 파일

- `wrangler.toml`: Worker와 Durable Objects 설정
- `src/index.js`: 인증된 API, 매치방 Durable Object, 요청 제한
- `online-friendly-client.js`: 게임 HTML에서 Worker API와 WebSocket을 호출하는 브라우저 클라이언트

## 1. Cloudflare Worker 생성

PC에 Node.js가 설치되어 있다면 터미널에서:

```bash
npm create cloudflare@latest yfm-online-friendly
```

선택창에서는 `Hello World` Worker 프로젝트를 선택하고 JavaScript를 선택해. 생성된 폴더에 이 `cloudflare-worker` 폴더 안의 `src/index.js`와 `wrangler.toml`을 복사해 덮어써.

로그인과 배포:

```bash
cd yfm-online-friendly
npx wrangler login
npx wrangler deploy
```

최초 배포 때 Durable Objects SQLite 마이그레이션 `v1`이 함께 적용돼. 배포 주소는 `https://yfm-online-friendly.<네 Cloudflare 계정>.workers.dev` 형태야.

## 2. 설정값 입력

`wrangler.toml`의 아래 세 값을 네 게임에 맞게 수정해.

- `SUPABASE_URL`: Supabase 프로젝트 URL (`https://...supabase.co`)
- `SUPABASE_ANON_KEY`: Supabase publishable/anon 키 (service role/secret 키는 절대 넣지 마)
- `ALLOWED_ORIGIN`: GitHub Pages의 정확한 Origin. 예: `https://아이디.github.io` 또는 `https://아이디.github.io/저장소명`에서 마지막 `/` 뒤 경로는 빼고 Origin까지만 적어.

키나 URL을 바꾼 뒤에는 `npx wrangler deploy`를 다시 실행해.

## 3. HTML에 브라우저 클라이언트 포함

`online-friendly-client.js`를 게임의 `index.html`과 같은 폴더에 복사하고, 메인 게임 스크립트가 끝난 뒤 `</body>` 전에 넣어.

```html
<script src="./online-friendly-client.js"></script>
```

그 파일의 `CFG.workerUrl`을 방금 배포된 Workers 주소로 바꿔.

```js
const CFG = { workerUrl: 'https://실제-worker-주소.workers.dev' };
```

이 클라이언트는 게임의 기존 `getOwnerRankClient()` Supabase 클라이언트를 이용해 로그인 세션 토큰을 가져와. 별도 비밀번호나 service role 키를 브라우저에 넣지 않아.

## 4. 화면/매치 흐름에 연결할 API

```js
// 새 방 만들기
const { code } = await yfmOnline.createRoom();

// 4자리 코드로 참가
await yfmOnline.joinRoom(code);

// 친구 ID로 초대 보내기 (수락된 친구만 가능)
await yfmOnline.inviteFriend(code, friendUserId);

// 접속 후 이벤트 받기
await yfmOnline.connect(code, event => {
  if (event.type === 'emoji') console.log(event.emoji);
  if (event.type === 'paused') console.log('전술 정지', event.remaining);
  if (event.type === 'state') console.log('상대 경기 상태', event.state);
});

// 각자 팀 준비 완료 후, 방장만 시작 호출
yfmOnline.setReady(true, { clubName: '내 구단', lineup: [] });
yfmOnline.start();

// 경기 중: 전술 패널을 열기 전에 pause, 패널을 닫고 재개할 때 resume
yfmOnline.pause();
yfmOnline.resume();

// 전반 종료와 후반 시작을 방장 클라이언트에서 통지
yfmOnline.setHalf(2);

// 감정표현
yfmOnline.emoji('🤣'); // 허용: 😝 🤬 😭 🤣 🖕

// 비방장 클라이언트의 전술/교체 명령을 방장에게 전달
yfmOnline.sendTactic({ tactic: 'def', instructions: {} });
yfmOnline.sendSub({ outId: '선수ID', inId: '선수ID' });

// 방장이 경기 진행 상태를 보냄 (초기 구현은 초당 4~8회 정도로 제한 권장)
yfmOnline.sendHostState({ time: 22, scoreHome: 1, scoreAway: 0, players: [], ball: {} });
```

## 5. 게임 엔진에서 반드시 연결할 부분

1. 현재 모드 선택과 소셜 화면에 `온라인 친선` 메뉴를 추가해. 친구 목록에서 초대 버튼을 누르면 `inviteFriend(code, friendId)`를 호출해.
2. 로그인 계정의 Supabase UUID를 `friendUserId`로 사용해. 화면의 구단주명/아이디 문자열이 아니라 친구 행의 `user_id`를 넘겨야 해.
3. 새 방 주인이 홈팀/시뮬레이션 권한자가 되고, 참가자는 원정팀이 돼. 각자 11명 선발, 벤치, 전술을 Worker의 `ready` 메시지로 공유해.
4. 기존 `openTactics()`에서 온라인 경기면 로컬만 멈추지 말고 `yfmOnline.pause()`를 호출해. `closeTactics()`에서 `resume()`를 호출해. Worker가 전반/후반을 분리해 사용자마다 각 하프 세 번까지만 허용해.
5. 지금 `doSub()`는 `st.homePlayers`만 변경하므로 상대편 교체를 직접 처리할 수 없어. 방장이 `sub` 메시지를 받았을 때 원정 선수 명단을 바꾸는 별도 함수를 연결해.
6. 기존 `startMatchEngine()`의 CPU 시뮬레이션을 방장만 실행하도록 분기해. 원정 클라이언트는 `simulateTick()`을 돌리지 말고, 방장이 보낸 상태 이벤트를 렌더링해야 서로 득점·시간이 달라지지 않아.
7. 후반 시작 시 방장이 `setHalf(2)`를 보내. Worker는 서버 기준으로 전반/후반 각각 사용자별 정지 횟수를 관리해.
8. 게임 종료 때 Worker에 `forfeit`/결과를 보내고 양쪽 방을 정리해. 온라인 친선 결과로 토큰·리그 기록을 주려면 클라이언트가 보내는 점수는 믿으면 안 돼. 우선 보상 없이 운영하거나 서버 검증을 추가해.

## 테스트 순서

1. 브라우저 두 개에서 서로 다른 계정으로 로그인.
2. 한 계정이 방을 만들고 4자리 코드 전달.
3. 다른 계정이 코드 참가.
4. 두 쪽 모두 콘솔에서 `await yfmOnline.connect('코드', console.log)` 실행.
5. `yfmOnline.emoji('😝')`, `pause()`, `resume()` 메시지가 양쪽에 오는지 확인.
6. 친구 초대 API는 두 계정이 먼저 Supabase 친구 상태 `accepted`여야 동작해.

Worker 오류 확인은 Cloudflare 대시보드의 Worker → Logs에서 해. 게임 계정 토큰이나 service role 키를 로그로 출력하지 마.
