# CLAUDE.md — LOT-IMS 개발 가이드 (AI/개발자용)

이 파일은 이 저장소에서 작업하는 AI(및 새 개발자)가 **개발 방향·구조·규칙**을 빠르게 파악하도록 정리한 문서입니다.
작업 전 이 문서를 먼저 읽고, 방향이 바뀌면 이 문서도 함께 갱신하세요.

---

## 1. 프로젝트 개요

**LOT-IMS** — 구글 클라우드만으로 운영하는 **서버리스 재고관리 시스템**.

- 식별 단위: **품번(item_code) + 리비전(rev)**. 바코드 = `RP-303-013 (D)` 형식 (과거 "로트번호"에서 전환됨).
- 프론트: **GitHub Pages** 정적 호스팅 (빌드 과정 없음, 순수 HTML/CSS/JS).
- 백엔드: **Google Apps Script 웹앱**(`Code.gs`) → **Google Sheets**(DB) / Drive(문서) / Chat·Gmail(알림) / Looker Studio(리포트).
- 대상: 소규모 팀. 대규모 필요 시 `schema.sql` 기반 PostgreSQL/API로 이관 여지를 남겨둠.

## 2. 저장소 구조 & 로드 순서

```
index.html            # 페이지 뼈대 (script 로드 순서 고정)
css/app.css           # 전체 스타일 (100% CSS 변수 기반 → 다크모드는 토큰 재매핑)
js/app-core.js        # 상태(S)·API 클라이언트·로그인·재고/위치/이력·공용 헬퍼·오류코드
js/app-operations.js  # 스캔 입출고·입출고 시트·부품 상세·조립(BOM)·관리 화면
js/app-extra.js       # 문서함·품질신고·리포트·알림설정·개선요청/오류신고
Code.gs               # 백엔드 API (Apps Script에 붙여넣어 배포)
schema.sql            # (참고) 동일 구조 PostgreSQL 스키마 — 추후 이관용
```

**JS는 반드시 `app-core → app-operations → app-extra` 순서**로 로드(뒤 파일이 앞 파일 함수를 사용). 전역 함수 선언 방식이라 파일 간 자유 호출됨.

## 3. 아키텍처 규칙

- **API 패턴**: 프론트 `api(action, payload)` → `POST text/plain`(CORS preflight 회피)로 Apps Script에 `{action, auth, ...}` 전송 → `{ok, snapshot?, ...}` 수신. `Content-Type`은 반드시 `text/plain`.
- **상태**: 전역 `S` 객체(app-core.js). 로그인 시 전체 스냅샷 1회 로드(`snapshot_`), 이후 메모리 상태로 즉시 렌더. `🔄` 새로고침으로 재동기화.
- **응답 크기 = 처리 속도**: `snapshot_()` 은 6개 시트(History 전량 포함)를 다시 읽으므로 **쓰기 응답에 함부로 담지 말 것**. 무엇이 바뀌었는지 서버가 아는 경우(`tx`/`bulkTx`)는 `{patch:{items:[…], histAdd:[…]}}` 만 내려보내고 프론트 `applyPatch()` 가 메모리 상태를 부분 갱신한다. 다른 사용자의 변경은 `🔄`/재로그인 때 스냅샷으로 맞춘다.
- **쓰기 직렬화**: 모든 쓰기는 백엔드 `withLock_`(LockService)로 감싸 다중 사용자 동시성에서 재고 정합성 보장. 재고 검증(부족 출고 차단)·중복 방지는 **서버에서** 수행.
- **편집 충돌**: 소프트 락(`acquireLock`/`renewLock`, TTL 3분) + 버전 충돌 감지(`baseVersion`).
- **빌드 없음**: 트랜스파일/번들 없음. 브라우저 표준 JS만. 외부 라이브러리는 CDN(`html5-qrcode`)뿐.

## 4. 데이터 모델 (Google Sheets 탭)

`Users · Items · Locations · History · Settings · Documents · Issues · BOM · DevLog · Errors`

- **Items**: `item_code, rev, name, unit, safety_stock, stock, location` — 재고는 (품번+리비전) 행에 직접 저장.
- **History**: append-only. `type ∈ {IN, OUT, MOVE, ADJUST, BUILD, CONSUME, UNBUILD, RESTORE}`.
- **BOM**: `parent_code/parent_rev → child_code/child_rev + qty_per`. 자식이 있는 품번이 자동으로 **조립품(assy)**.
- **DevLog**: 원래 개발메모였으나 **개선요청·오류신고 채널**로 재사용 중(스키마·액션명 유지).
- **Errors**: 미분류 오류(E9000) 자동 적재(참조번호·원문·스택).

## 5. 도메인 규칙

- **제품군**: 품번 앞자리 코드. `GROUP_NAMES = {RP:PARKIE, RG:GOALIE, RD:DD-DRIVING, RQ:QD-DRIVING, RS:STANLEY, RZ:COMMON PARTS}`. 마스터 시트 기준.
- **재고현황 정렬**: `GROUP_ORDER = ['RP','RG','RZ','RD','RQ','RS']` (파키→골리→커먼→나머지). 첫 진입 시 **RP·RZ만 펼침**, 펼친 그룹이 상단·접힌 그룹이 하단.
- **트랜잭션 4종**(`applyTx_`): **IN**(입고·재고↑) / **OUT**(출고·재고↓) / **MOVE**(위치만 변경, 수량 불변) / **ADJUST**(실사 절대수량으로 재고 보정, 증감 자동 기록).
  - 자주 쓰는 **IN/OUT**: 스캔 탭 + 재고카드 `⇅ 입·출고` 시트.
  - 가끔 쓰는 **MOVE/ADJUST**: 더보기 → **재고 조정·이동** 전용 화면.
- **BOM 등록**: **Rev은 입력하지 않음** → 품번의 **최신 리비전 자동 적용**(`latestRevOf`, 사전식·숫자 정렬상 최대). 특정 Rev은 품번 칸에 `RP-303-013 (C)` 인라인으로.
- **품번 마스터**: 원칙적으로 외부 **AppSheet**가 `syncItem` 웹훅(공유 토큰 인증)으로 동기화. 앱 내 수동 등록은 보완용.

## 6. 오류코드 체계

- 백엔드 `classifyError_`(Code.gs)가 throw 메시지를 안정적 코드로 매핑, 프론트 `api()`가 `[코드] 메시지`로 토스트에 노출.
- 대역: **E0**(통신) · **E1**(입력/검증) · **E2**(권한/인증) · **E3/4/5**(충돌/리소스/삭제제약) · **E9**(시스템). 미분류=**E9000**은 참조번호 + Errors 시트 로깅.
- 프론트 참조표 `ERR_CATALOG`(app-core.js)와 백엔드 `classifyError_`의 **코드 체계를 함께 유지**. 로그인 화면·더보기에서 "오류코드 안내"로 조회.

## 6-1. 로그인 세션

- 로그인 성공 시 `{아이디, 비밀번호 해시, 이름, 역할}`을 `localStorage.ims_session` 에 저장 → **새로고침·탭 복원·브라우저 재시작에도 로그인 유지**(`restoreSession()` in app-core.js).
- TTL은 **마지막 접속 기준 14일**(접속마다 `saveSession()` 으로 갱신되는 슬라이딩 방식). 명시적 로그아웃은 `clearSession()` 으로 즉시 폐기.
- 복원 시 `api('all')` 로 서버 검증. **`E2*`(인증) 오류만 세션을 폐기**하고, 네트워크·서버 오류(`E0*`)는 세션을 유지한 채 🔄 안내만 띄운다(현장 음영지역 대응).
- ⚠️ 한 기기를 여러 사람이 돌려 쓰면 마지막 사용자로 자동 로그인되어 **이력의 담당자가 잘못 남을 수 있다** — 그런 환경에선 로그아웃 습관화 필요.

## 7. 권한 / 역할

- 역할: `admin`(관리자) / `worker`(**UI 표기는 "사용자"**, 백엔드 값은 `worker` 유지).
- 관리자 전용: 사용자·품번·위치·BOM·설정·데이터 관리, 개선요청/오류신고 **해결·삭제**.
- 모든 사용자: 스캔 입출고, 조회, 문서·품질신고·개선요청/오류신고 **접수**.

## 8. UI/UX 규칙

- 디자인 언어: 라이트 SaaS + 인디고 액센트(ROBOSTOCK 모티브). Syne/JetBrains Mono/Noto Sans KR.
- **CSS는 100% 변수 기반** — 색을 하드코딩하지 말 것. 다크모드는 `:root[data-theme="dark"]` 토큰 재매핑으로 동작.
- **테마 기본값 = 라이트**. 사용자가 🌙/☀️로 바꿔 저장(`localStorage.ims_theme`)한 경우에만 그 값 사용(OS 설정 따르지 않음).
- 안전재고 미달 **상단 경고 알람은 꺼둠**(요청). 카드의 "미달" 배지는 유지.
- 바코드 스캔: `useBarCodeDetectorIfSupported`(안드로이드 가속) + QR·주요 1D 포맷 명시(아이폰 폴백). Web Audio 비프음 3종(`beep`) — `ok`(성공·높은 삑) / `err`(미등록·낮은 삑) / `tick`(읽음, 시트 재조회 대기용 짧은 클릭). **한 번의 스캔에 성공음과 실패음이 겹치지 않게** 유지할 것: 메모리에 있으면 즉시 `ok`, 없으면 `tick` → 재조회 → `ok`/`err`.
- **스캔 플로팅 카드**(`.scan-pop` · `scanPop()`): 바코드가 읽히면 결과를 카드로 띄우고 **비프음과 상태를 1:1로 짝지어** 유지할 것 — `tick→pending` / `ok→ok` / `err→err`(+처리 완료 `done`, 1.6초 후 자동 소멸). 위치는 카메라 가동 중이면 뷰파인더(`#reader`) 안, 꺼져 있으면(수동 입력·USB 리더기) 화면 하단 고정. **카드에서는 입고/출고 수량만 받아 즉시 처리**하고(위치 미전송 → 서버가 기존 위치 유지, 항상 품질 `정상`), 이동·조정·품질이상·인증사진·사유는 카드에 넣지 말고 "상세"로 하단 패널(`#scanPanel`)로 보낼 것. 카드 수량·모드를 손대면 `S.scanPopLock`이 걸려 다른 바코드가 대상을 갈아치우지 못한다.

## 9. 배포 (중요)

- **프론트엔드**: `git push origin main` → GitHub Pages 자동 반영(1~2분).
  - ⚠️ **`index.html` 의 `?v=YYYYMMDD` 4곳(css 1 + js 3)을 반드시 함께 올릴 것.** 안 올리면 브라우저·Pages 캐시가 이전 `app-*.js`/`app.css` 를 계속 내려줘서 **푸시는 됐는데 화면은 안 바뀐다**(같은 날 재배포는 `-2`, `-3` 접미사).
- **백엔드(`Code.gs`)**: git으로는 반영 안 됨. **Apps Script에 수동 재배포 필요** — Apps Script 편집기에 `Code.gs` 붙여넣기 → 저장 → **배포 → 배포 관리 → ✏️ → 버전: 새 버전 → 배포**(웹앱 URL 유지). "새 배포"가 아니라 기존 배포를 **편집**할 것.
- 커밋 시 **Code.gs 변경 포함 여부를 항상 명시**(백엔드 재배포 필요 여부).
- `DEFAULT_API_URL`(app-core.js)에 운영 웹앱 URL 고정 → 로그인 화면 주소 입력 숨김.

## 10. 작업 관례

- 커밋 메시지·주석·UI 문구는 **한국어**. 코드는 주변 스타일(전역 함수, 간결한 인라인 템플릿 리터럴)에 맞춤.
- 사용자에게 노출되는 오류·성공 메시지는 명확한 한국어로. 서버 오류엔 오류코드가 붙음.
- 변경 후 최소 `node --check`로 문법 검증. 가능하면 실제 흐름을 눌러 확인.
