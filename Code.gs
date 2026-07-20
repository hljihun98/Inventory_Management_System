/**********************************************************************
 * LOT-IMS 백엔드 — Google Apps Script (구글 시트 = DB, 구글 드라이브 = 파일 저장소)
 *
 * 포함 기능:
 *  - 로트 바코드/입출고/재고/위치 (기본 기능)
 *  - 문서·이미지 보관 (Google Drive)
 *  - 품질검사/이상신고
 *  - 자동 알림 (Gmail 일일 다이제스트 + 실시간 Google Chat)
 *  - 리포트용 평탄화 시트 (Looker Studio 연결용)
 *
 * 설치 방법:
 *  1) 새 구글 시트 생성 → 확장 프로그램 > Apps Script → 이 코드 전체 붙여넣기
 *  2) 함수 선택에서 setup 선택 → 실행 (시트/헤더/관리자 계정/드라이브 폴더 자동 생성)
 *  3) 배포 > 새 배포 > 웹 앱 (실행 계정: 나 / 액세스: 모든 사용자)
 *  4) 발급된 URL을 index.html 로그인 화면에 입력
 *  5) (선택) 관리 > 알림 탭에서 Chat Webhook / 알림 이메일 설정 후
 *     "일일 알림 자동 발송 설치" 버튼 클릭
 **********************************************************************/

/* 품번(부품 품번) 기반 재고관리 스키마.
   재고 식별 단위 = 품번(item_code) + 리비전(rev). 예) 품번 RP-303-013, 리비전 D → 바코드 "RP-303-013 (D)"
   품번 = 제품군코드(RP)-블록코드(303)-시리얼(013). 제품군은 앞자리에서 도출(RP=PARKIE 등).
   재고(stock)·보관위치(location)는 이 앱(LOT-IMS)이 정본으로 소유하고,
   품번 마스터(name·unit·safety_stock)는 AppSheet가 syncItem 웹훅으로 동기화한다. */
var SHEET_HEADERS = {
  Users:        ['user_id', 'name', 'role', 'pw_hash', 'created_at'],
  Items:        ['item_code', 'rev', 'name', 'unit', 'safety_stock', 'stock', 'location'],
  Locations:    ['location_code', 'warehouse', 'zone', 'rack'],
  History:      ['tx_id', 'ts', 'type', 'item_code', 'rev', 'qty', 'before', 'after', 'location', 'reason', 'user'],
  Settings:     ['key', 'value'],
  Documents:    ['doc_id', 'item_code', 'rev', 'category', 'file_id', 'file_name', 'uploaded_by', 'uploaded_at'],
  Issues:       ['issue_id', 'item_code', 'rev', 'severity', 'title', 'description', 'photo_file_id', 'status', 'reported_by', 'reported_at', 'updated_by', 'updated_at', 'resolution_note'],
  DevLog:       ['log_id', 'ts', 'author', 'category', 'title', 'content', 'done', 'updated_at'],
  Locks:        ['resource', 'user_id', 'user_name', 'ts'],   // 편집 중 소프트 락 (수정 충돌 방지)
  BOM:          ['bom_id', 'parent_code', 'parent_rev', 'child_code', 'child_rev', 'qty_per', 'seq', 'memo']   // 조립품 BOM: 한 행 = 부모→자식 엣지 (다단계 = 엣지 체인)
};
var DRIVE_FOLDER_NAME = 'LOT-IMS-Files';
var DEFAULT_SETTINGS = { chatWebhookUrl: '', alertEmails: '', alertHour: '8', driveFolderId: '', syncToken: '' };
/* 제품군 코드표 (품번 앞자리) — 프론트엔드 GROUP_NAMES 와 동일하게 유지 */
var GROUP_NAMES = { RP: 'PARKIE', RD: 'DD-DRIVING', RG: 'GOALIE', RZ: 'COMMON PARTS', RQ: 'QD-DRIVING', RS: 'STANLEY' };
function groupCodeOf_(code) { return String(code || '').split('-')[0].toUpperCase(); }
function findItem_(items, code, rev) {
  var c = String(code || '').toUpperCase(), r = String(rev || '').toUpperCase();
  return items.filter(function (x) { return String(x.item_code).toUpperCase() === c && String(x.rev || '').toUpperCase() === r; })[0];
}

/* ============ 최초 1회 실행: 시트/관리자/드라이브 폴더 생성 ============ */
function setup() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(SHEET_HEADERS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(SHEET_HEADERS[name]);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, SHEET_HEADERS[name].length).setFontWeight('bold');
    }
    sh.getRange(2, 1, sh.getMaxRows() - 1, SHEET_HEADERS[name].length).setNumberFormat('@');
  });

  // 기본 관리자 (admin / admin1234)
  if (!readTable_('Users').rows.length) {
    appendRow_('Users', { user_id: 'admin', name: '관리자', role: 'admin', pw_hash: sha256_('admin1234'), created_at: Date.now() });
  }
  // 샘플 마스터 데이터 (품번+리비전 기준 · 재고는 0에서 시작)
  if (!readTable_('Items').rows.length) {
    appendRow_('Items', { item_code: 'RP-303-013', rev: 'D', name: 'COVER, E-RR', unit: 'EA', safety_stock: 100, stock: 0, location: '' });
    appendRow_('Items', { item_code: 'RG-101-002', rev: 'A', name: 'BRACKET, MAIN', unit: 'EA', safety_stock: 50, stock: 0, location: '' });
  }
  if (!readTable_('Locations').rows.length) {
    appendRow_('Locations', { location_code: 'A-01-01', warehouse: 'A창고', zone: '01구역', rack: '01랙' });
    appendRow_('Locations', { location_code: 'A-01-02', warehouse: 'A창고', zone: '01구역', rack: '02랙' });
  }
  // 드라이브 폴더 (문서/사진 저장용)
  var folderId = ensureDriveFolder_();
  // 기본 설정값 (없는 키만 채움)
  var existing = readTable_('Settings').rows.reduce(function (m, r) { m[r.key] = true; return m; }, {});
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    if (!existing[k]) appendRow_('Settings', { key: k, value: k === 'driveFolderId' ? folderId : DEFAULT_SETTINGS[k] });
  });
  bomSheet_();          // BOM 시트 보장
  rebuildReports_();
  rebuildBomReport_();  // Report_BOM(구조 전용) 생성
}

/* ============ 관리자 계정 복구 (로그인 안 될 때) ============
   Apps Script 편집기에서 이 함수를 직접 선택 → 실행하면 admin 계정을 admin/admin1234 로 초기화(없으면 생성)한다.
   웹앱 재배포가 필요 없다(편집기는 저장된 최신 코드로 실행되고, 로그인은 Users 시트를 직접 조회하므로).
   실행 후 로그(보기 > 실행 로그)에 진단 정보가 출력된다. */
function resetAdmin() {
  var t = readTable_('Users');
  var u = t.rows.filter(function (r) { return String(r.user_id) === 'admin'; })[0];
  var hash = sha256_('admin1234');
  if (u) {
    t.sheet.getRange(u._row, 3).setValue('admin');   // role
    t.sheet.getRange(u._row, 4).setValue(hash);       // pw_hash
  } else {
    appendRow_('Users', { user_id: 'admin', name: '관리자', role: 'admin', pw_hash: hash, created_at: Date.now() });
  }
  var msg = 'admin 계정을 admin/admin1234 로 초기화했습니다. 사용자 수=' + readTable_('Users').rows.length + ', 저장된 해시=' + hash;
  Logger.log(msg);
  return msg;
}
/* 로그인 진단용 — 편집기에서 실행하면 등록된 사용자 목록과 admin/admin1234 해시를 로그로 확인할 수 있다. */
function debugLogin() {
  var rows = readTable_('Users').rows;
  Logger.log('사용자 ' + rows.length + '명: ' + rows.map(function (r) { return r.user_id + '(' + r.role + ')'; }).join(', '));
  Logger.log('admin1234 의 해시 = ' + sha256_('admin1234'));
  var admin = rows.filter(function (r) { return String(r.user_id) === 'admin'; })[0];
  Logger.log('admin 저장 해시 = ' + (admin ? admin.pw_hash : '(admin 행 없음)'));
  Logger.log('일치 여부 = ' + (admin && String(admin.pw_hash) === sha256_('admin1234')));
  return 'debugLogin 완료 — 실행 로그(Ctrl+Enter)를 확인하세요';
}

function ensureDriveFolder_() {
  var it = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
  if (it.hasNext()) return it.next().getId();
  return DriveApp.createFolder(DRIVE_FOLDER_NAME).getId();
}

/* ============ HTTP 엔드포인트 ============ */
function doGet(e) {
  return out_({ ok: true, service: 'LOT-IMS API', time: new Date().toISOString() });
}
function doPost(e) {
  var req = null;
  try {
    req = JSON.parse(e.postData.contents);
    return out_(handle_(req));
  } catch (err) {
    var msg = String(err && err.message ? err.message : err);
    var code = classifyError_(msg);
    var resp = { ok: false, code: code, error: msg };
    if (code === 'E9000') {                       // 미분류 = 예기치 못한 오류 → 추적용 참조번호 + 로깅
      var ref = uid_();
      resp.ref = ref;
      resp.error = '서버 처리 중 오류가 발생했습니다 (참조 ' + ref + ')';   // 원본 메시지는 Errors 탭에만
      try { logError_(ref, req, msg, err && err.stack); } catch (_) {}
    }
    return out_(resp);
  }
}
function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ============ 오류코드 분류 ============
   throw 메시지(한국어)를 안정적인 오류코드로 매핑한다. 위에서부터 먼저 매칭되는 규칙을 채택.
   프론트 토스트에는 "[코드] 메시지"로 표시되어 사용자가 원인을 바로 조회할 수 있다.
   앞쪽 규칙일수록 더 구체적 — 순서 변경 시 오분류 주의. 프론트 ERR_CATALOG(app-core.js)와 함께 관리. */
function classifyError_(m) {
  m = String(m || '');
  var RULES = [
    [/삭제할 수 없습니다/, 'E5001'],                          // 재고 남음/BOM/위치 사용 중
    [/다른 사용자가 먼저 수정/, 'E3001'],                     // 버전 충돌
    [/관리자 권한/, 'E2003'],
    [/로그인이 필요/, 'E2001'],
    [/아이디 또는 비밀번호/, 'E2002'],
    [/동기화 토큰|syncToken/, 'E2004'],
    [/재고 부족/, 'E1002'],
    [/실사 수량은 0 이상/, 'E1003'],
    [/실사 수량이 현재고와 같/, 'E1004'],
    [/이동할 위치를 선택|현재 위치와 동일/, 'E1005'],
    [/잘못된 처리 유형|잘못된 상태값/, 'E1006'],
    [/수량은 1 이상|소요량은 1 이상/, 'E1001'],
    [/한 번에 최대|처리할 항목이 없|등록할 품번이 없|등록할 BOM이 없/, 'E1007'],
    [/품번 형식/, 'E1008'],
    [/이미 존재/, 'E1009'],
    [/순환 구조|자기 자신을 구성품|중복 자식/, 'E1011'],
    [/조립품\(BOM 상위\)이 아/, 'E1102'],
    [/등록되지 않은|미등록/, 'E1101'],
    [/입력하세요|입력값 부족|필요합니다|첨부 파일이 없|새 비밀번호가 없/, 'E1010'],
    [/찾을 수 없습니다/, 'E4001'],
    [/시트 없음|setup/, 'E9001'],
    [/알 수 없는 요청/, 'E9002']
  ];
  for (var i = 0; i < RULES.length; i++) { if (RULES[i][0].test(m)) return RULES[i][1]; }
  return 'E9000';                                // 미분류(예기치 못한 시스템 오류)
}

/* 미분류(E9000) 오류만 Errors 시트에 적재 — 참조번호로 관리자가 원인을 추적. best-effort(실패해도 무시). */
function logError_(ref, req, message, stack) {
  var sh = getOrCreate_('Errors', ['ref', 'ts', 'iso', 'action', 'user', 'message', 'stack']);
  var action = '', user = '';
  try { action = req && req.action ? String(req.action) : ''; } catch (e1) {}
  try { user = req && req.auth && req.auth.id ? String(req.auth.id) : ''; } catch (e2) {}
  sh.appendRow([ref, Date.now(), new Date().toISOString(), action, user, String(message || '').slice(0, 500), String(stack || '').slice(0, 1000)]);
}

/* ============ 라우팅 ============ */
function handle_(req) {
  var action = req.action;

  if (action === 'login') {
    var u = auth_({ id: req.id, pwHash: req.pwHash });
    return { ok: true, user: { id: u.user_id, name: u.name, role: u.role }, snapshot: snapshot_() };
  }
  // AppSheet(부품 품번 관리 시스템) → 품번 마스터 동기화 웹훅. 사용자 인증 대신 공유 토큰으로 인증.
  if (action === 'syncItem') return withLock_(function () { return syncItem_(req); });

  var user = auth_(req.auth);

  switch (action) {
    case 'all':       return { ok: true, snapshot: snapshot_() };
    case 'tx':        return withLock_(function () { return tx_(user, req); });
    case 'bulkTx':    return withLock_(function () { return bulkTx_(user, req); });
    case 'setMyPw':   return withLock_(function () { return setPw_(user.user_id, req.newPwHash); });

    // ----- 편집 중 소프트 락 (수정 충돌 방지) -----
    case 'acquireLock': return withLock_(function () { return acquireLock_(user, req); });
    case 'renewLock':   return withLock_(function () { return renewLock_(user, req); });
    case 'releaseLock': return withLock_(function () { return releaseLock_(user, req); });
    case 'listLocks':   return { ok: true, locks: activeLocks_(req.prefix || '') };

    // ----- 문서/이미지 (품번 단위) -----
    case 'uploadDoc': return withLock_(function () { return uploadDoc_(user, req); });
    case 'listDocs':  return { ok: true, docs: listDocsForItem_(req.code, req.rev) };
    case 'delDoc':    admin_(user); return withLock_(function () { return delDoc_(req); });

    // ----- 품질검사/이상신고 -----
    case 'reportIssue': return withLock_(function () { return reportIssue_(user, req); });
    case 'listIssues':  return { ok: true, issues: listIssues_(req || {}) };
    case 'updateIssue': return withLock_(function () { return updateIssue_(user, req); });

    // ----- 조립/분해 (BOM 재고 연동) · 모든 로그인 사용자 -----
    case 'assemble':    return withLock_(function () { return assemble_(user, req); });
    case 'disassemble': return withLock_(function () { return disassemble_(user, req); });

    // ----- 리포트 -----
    case 'reportData': return { ok: true, report: reportData_() };

    // ----- 관리자 전용: 사용자/품목/위치/데이터/알림설정 -----
    case 'addUser':   admin_(user); return withLock_(function () { return addUser_(req); });
    case 'delUser':   admin_(user); return withLock_(function () { return delRow_('Users', 'user_id', req.id, req.id === 'admin' ? '기본 관리자는 삭제할 수 없습니다' : null); });
    case 'setUserPw': admin_(user); return withLock_(function () { return setPw_(req.id, req.newPwHash); });
    case 'addItem':   admin_(user); return withLock_(function () { return addItem_(req); });
    case 'editItem':  admin_(user); return withLock_(function () { return editItem_(user, req); });
    case 'bulkAddItem': admin_(user); return withLock_(function () { return bulkAddItem_(req); });
    case 'delItem':   admin_(user); return withLock_(function () { return delItem_(req); });
    case 'addLoc':    admin_(user); return withLock_(function () { return addLoc_(req); });
    case 'delLoc':    admin_(user); return withLock_(function () { return delLoc_(req); });
    // ----- 관리자 전용: BOM 구조 편집 -----
    case 'addBOM':       admin_(user); return withLock_(function () { return addBOM_(req); });
    case 'bulkAddBOM':   admin_(user); return withLock_(function () { return bulkAddBOM_(req); });
    case 'delBOM':       admin_(user); return withLock_(function () { return delBOM_(req); });
    case 'setBOMParent': admin_(user); return withLock_(function () { return setBOMParent_(user, req); });
    case 'wipe':      admin_(user); return withLock_(function () { return wipe_(); });
    case 'getSettings':      admin_(user); return { ok: true, settings: getSettingsObj_() };
    case 'setSettings':      admin_(user); return withLock_(function () { return setSettingsObj_(req.settings || {}); });
    case 'testChat':         admin_(user); return { ok: true, sent: notifyChat_('🔔 LOT-IMS 테스트 메시지입니다. Chat 연동이 정상 동작합니다.') };
    case 'testEmail':        admin_(user); return { ok: true, sent: sendDailyDigest_(true) };
    case 'installDailyAlerts': admin_(user); return { ok: true, installed: installDailyAlerts_() };
    // 개선요청·오류신고 채널: 접수·조회는 모든 사용자, 해결 처리·삭제는 관리자
    case 'addDevLog':    return withLock_(function () { return addDevLog_(user, req); });
    case 'listDevLog':   return { ok: true, logs: listDevLog_(req || {}) };
    case 'updateDevLog': admin_(user); return withLock_(function () { return updateDevLog_(req); });
    case 'delDevLog':    admin_(user); return withLock_(function () { return delDevLog_(req); });
    default: throw new Error('알 수 없는 요청: ' + action);
  }
}

function auth_(auth) {
  if (!auth || !auth.id || !auth.pwHash) throw new Error('로그인이 필요합니다');
  var u = readTable_('Users').rows.filter(function (r) { return r.user_id === auth.id; })[0];
  if (!u || String(u.pw_hash) !== String(auth.pwHash)) throw new Error('아이디 또는 비밀번호가 올바르지 않습니다');
  return u;
}
function admin_(user) { if (user.role !== 'admin') throw new Error('관리자 권한이 필요합니다'); }
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ============ 편집 중 소프트 락 (수정 충돌 방지) ============
   한 사용자가 특정 레코드(resource)를 편집하는 동안 다른 사용자에게 알리고 저장을 차단한다.
   resource 예) 'issue:<id>', 'item:<품번>|<리비전>'.  TTL(3분) 지나면 자동 만료 → 브라우저를 그냥 닫아도 잠금이 풀린다.
   버전 충돌 감지(baseVersion)가 최종 안전망이므로, 락이 뚫려도 덮어쓰기는 일어나지 않는다. */
var LOCK_TTL_MS = 3 * 60 * 1000;   // 3분
function locksSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName('Locks');
  if (!sh) { sh = ss.insertSheet('Locks'); sh.appendRow(SHEET_HEADERS.Locks); sh.setFrozenRows(1); }  // 기존 설치도 setup 재실행 없이 자동 생성
  return sh;
}
function readLocks_() {
  var sh = locksSheet_();
  var last = sh.getLastRow();
  if (last < 2) return { sheet: sh, rows: [] };
  var vals = sh.getRange(2, 1, last - 1, 4).getValues();
  var rows = vals.map(function (v, i) {
    return { _row: i + 2, resource: String(v[0]), user_id: String(v[1]), user_name: String(v[2]), ts: Number(v[3]) || 0 };
  });
  return { sheet: sh, rows: rows };
}
function deleteLockRows_(sheet, rows) {   // 여러 행 삭제는 반드시 아래→위 순서로 (인덱스 밀림 방지)
  rows.sort(function (a, b) { return b._row - a._row; }).forEach(function (r) { sheet.deleteRow(r._row); });
}
/* 잠금 획득(신규 진입). 다른 사용자가 유효 잠금을 쥐고 있으면 acquired:false + 보유자 정보 반환.
   force(강제 이어받기)는 관리자만 허용 — 클라이언트 UI뿐 아니라 서버에서도 검증한다. */
function acquireLock_(user, p) {
  var resource = String(p.resource || '');
  if (!resource) throw new Error('resource가 필요합니다');
  var force = !!p.force && user.role === 'admin';   // 관리자만 강제 탈취 가능
  var now = Date.now();
  var t = readLocks_();
  var holder = t.rows.filter(function (r) { return r.resource === resource && r.user_id !== user.user_id && (now - r.ts) < LOCK_TTL_MS; })[0];
  if (holder && !force) {
    return { ok: true, acquired: false, holder: { id: holder.user_id, name: holder.user_name, ageSec: Math.floor((now - holder.ts) / 1000) } };
  }
  // 획득/강제이어받기: 이 resource의 기존 행 + 만료된 다른 모든 행을 정리한 뒤 내 행 추가
  deleteLockRows_(t.sheet, t.rows.filter(function (r) { return r.resource === resource || (now - r.ts) >= LOCK_TTL_MS; }));
  t.sheet.appendRow([resource, user.user_id, user.name, now]);
  return { ok: true, acquired: true, took: !!(holder && force) };
}
/* 하트비트 전용 갱신. 내 잠금 행이 "이미 있을 때만" ts를 갱신하고, 없으면 재생성하지 않는다.
   → 저장 직후 자동해제된 잠금을 in-flight 하트비트가 되살리는 좀비 잠금을 원천 차단.
   (acquireLock_·updateIssue_·editItem_ 와 함께 모두 withLock_ 로 직렬화되므로 순서 역전이 없다.) */
function renewLock_(user, p) {
  var resource = String(p.resource || '');
  var t = readLocks_();
  var mine = t.rows.filter(function (r) { return r.resource === resource && r.user_id === user.user_id; })[0];
  if (!mine) return { ok: true, renewed: false };   // 이미 해제/만료/이어받기됨 → 재생성 안 함
  t.sheet.getRange(mine._row, 4).setValue(Date.now());
  return { ok: true, renewed: true };
}
function releaseLock_(user, p) {
  var resource = String(p.resource || '');
  var t = readLocks_();
  deleteLockRows_(t.sheet, t.rows.filter(function (r) { return r.resource === resource && r.user_id === user.user_id; }));
  return { ok: true };
}
/* 내부용: 저장 성공 후 자기 잠금을 자동 해제 (이미 withLock_ 안에서 호출됨) */
function autoReleaseLock_(user, resource) {
  var t = readLocks_();
  deleteLockRows_(t.sheet, t.rows.filter(function (r) { return r.resource === resource && r.user_id === user.user_id; }));
}
function activeLocks_(prefix) {
  var now = Date.now();
  return readLocks_().rows
    .filter(function (r) { return (now - r.ts) < LOCK_TTL_MS && (!prefix || r.resource.indexOf(prefix) === 0); })
    .map(function (r) { return { resource: r.resource, id: r.user_id, name: r.user_name, ageSec: Math.floor((now - r.ts) / 1000) }; });
}

/* ============ 시트 입출력 헬퍼 ============ */
function sheet_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('시트 없음: ' + name + ' — setup() 을 먼저 실행하세요');
  return sh;
}
function readTable_(name) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  var head = SHEET_HEADERS[name];
  if (last < 2) return { sheet: sh, rows: [] };
  var vals = sh.getRange(2, 1, last - 1, head.length).getValues();
  var rows = vals.map(function (v, i) {
    var o = { _row: i + 2 };
    head.forEach(function (h, j) { o[h] = normalize_(v[j]); });
    return o;
  });
  return { sheet: sh, rows: rows };
}
function normalize_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v;
}
function appendRow_(name, obj) {
  var head = SHEET_HEADERS[name];
  sheet_(name).appendRow(head.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; }));
}
function delRow_(table, keyCol, keyVal, forbidMsg) {
  if (forbidMsg) throw new Error(forbidMsg);
  var t = readTable_(table);
  var row = t.rows.filter(function (r) { return String(r[keyCol]) === String(keyVal); })[0];
  if (!row) throw new Error('대상을 찾을 수 없습니다: ' + keyVal);
  t.sheet.deleteRow(row._row);
  return { ok: true, snapshot: snapshot_() };
}
function sha256_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ((b + 256) % 256).toString(16); })
    .map(function (h) { return h.length === 1 ? '0' + h : h; })
    .join('');
}
function uid_() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

/* ============ 설정(Settings) key-value ============ */
function settingsGet_(key, dflt) {
  var row = readTable_('Settings').rows.filter(function (r) { return r.key === key; })[0];
  return row ? row.value : (dflt !== undefined ? dflt : '');
}
function settingsSet_(key, value) {
  var t = readTable_('Settings');
  var row = t.rows.filter(function (r) { return r.key === key; })[0];
  if (row) t.sheet.getRange(row._row, 2).setValue(value);
  else appendRow_('Settings', { key: key, value: value });
}
function getSettingsObj_() {
  var o = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { o[k] = settingsGet_(k, DEFAULT_SETTINGS[k]); });
  return o;
}
function setSettingsObj_(s) {
  ['chatWebhookUrl', 'alertEmails', 'alertHour', 'syncToken'].forEach(function (k) {
    if (s[k] !== undefined) settingsSet_(k, String(s[k]));
  });
  return { ok: true, settings: getSettingsObj_() };
}

/* ============ 스냅샷 (프론트엔드 동기화용) ============ */
function snapshot_() {
  var users = readTable_('Users').rows.map(function (u) { return { id: u.user_id, name: u.name, role: u.role }; });
  var items = readTable_('Items').rows.map(function (i) {
    return { code: String(i.item_code), rev: String(i.rev || ''), name: i.name, unit: i.unit || 'EA', safetyStock: Number(i.safety_stock) || 0, stock: Number(i.stock) || 0, location: String(i.location || '') };
  });
  var locs = readTable_('Locations').rows.map(function (l) {
    return { code: String(l.location_code), warehouse: String(l.warehouse || ''), zone: String(l.zone || ''), rack: String(l.rack || '') };
  });
  var histAll = readTable_('History').rows;
  var hist = histAll.slice(Math.max(0, histAll.length - 500)).map(function (h) {
    return { id: h.tx_id, ts: Number(h.ts) || 0, type: h.type, itemCode: String(h.item_code), rev: String(h.rev || ''), qty: Number(h.qty) || 0, before: Number(h.before) || 0, after: Number(h.after) || 0, location: String(h.location || ''), reason: String(h.reason || ''), user: h.user };
  });
  var openIssues = readTable_('Issues').rows.filter(function (r) { return r.status !== '완료'; }).length;
  var bom = readBOM_().rows.map(function (e) {
    return { id: e.bom_id, parentCode: String(e.parent_code), parentRev: String(e.parent_rev || ''), childCode: String(e.child_code), childRev: String(e.child_rev || ''), qtyPer: Number(e.qty_per) || 0, seq: Number(e.seq) || 0, memo: String(e.memo || '') };
  });
  return { users: users, items: items, locs: locs, hist: hist, histTotal: histAll.length, openIssueCount: openIssues, bom: bom };
}

/* ============ 입·출고 트랜잭션 (품번+리비전 기반) ============ */
/* 단일 처리를 적용(검증·재고 증감·이력) — tx_ 와 bulkTx_ 가 공유.
   itemsTable 을 공유해 같은 배치 안에서 in-memory 재고를 이어서 반영한다.
   재고 식별 = 품번(item_code)+리비전(rev). Items 컬럼: item_code(1)·rev(2)·name(3)·unit(4)·safety_stock(5)·stock(6)·location(7) */
function applyTx_(user, p, itemsTable) {
  var type = p.type;
  if (['IN', 'OUT', 'MOVE', 'ADJUST'].indexOf(type) < 0) throw new Error('잘못된 처리 유형');

  var code = String(p.code || '').toUpperCase(), rev = String(p.rev || '').toUpperCase();
  var item = findItem_(itemsTable.rows, code, rev);
  if (!item) throw new Error('등록되지 않은 품번/리비전: ' + (p.code || '') + (rev ? ' (' + rev + ')' : ''));

  var before = Number(item.stock) || 0, after = before, loc = String(item.location || '');

  // ----- 위치 이동: 재고 수량은 그대로, 보관 위치만 변경 -----
  if (type === 'MOVE') {
    var toLoc = String(p.loc || '');
    if (!toLoc) throw new Error('이동할 위치를 선택하세요');
    if (toLoc === loc) throw new Error('현재 위치와 동일한 위치입니다');
    var fromLoc = loc || '(미지정)';
    loc = toLoc;
    itemsTable.sheet.getRange(item._row, 7).setValue(loc);          // location 만 변경
    item.location = loc;
    var moveReason = '📍 ' + fromLoc + ' → ' + toLoc + (p.reason ? ' | ' + p.reason : '');
    appendRow_('History', {
      tx_id: uid_(), ts: Date.now(), type: 'MOVE', item_code: item.item_code, rev: item.rev || '',
      qty: before, before: before, after: before, location: loc, reason: moveReason, user: user.name
    });
    return { ok: true, type: 'MOVE', qty: before, before: before, after: before, code: item.item_code, rev: item.rev || '', from: fromLoc, to: toLoc };
  }

  // ----- 재고 실사 조정: 실물 카운트(절대 수량)로 재고를 맞추고 증감분을 기록 -----
  if (type === 'ADJUST') {
    var counted = Math.floor(Number(p.qty));
    if (isNaN(counted) || counted < 0) throw new Error('실사 수량은 0 이상이어야 합니다');
    after = counted;
    var delta = after - before;
    if (delta === 0) throw new Error('실사 수량이 현재고와 같습니다');
    itemsTable.sheet.getRange(item._row, 6).setValue(after);        // stock
    item.stock = after;
    var adjReason = '실사 조정 ' + (delta > 0 ? '+' : '') + delta + (p.reason ? ' | ' + p.reason : '');
    appendRow_('History', {
      tx_id: uid_(), ts: Date.now(), type: 'ADJUST', item_code: item.item_code, rev: item.rev || '',
      qty: Math.abs(delta), before: before, after: after, location: loc, reason: adjReason, user: user.name
    });
    return { ok: true, type: 'ADJUST', qty: Math.abs(delta), delta: delta, before: before, after: after, code: item.item_code, rev: item.rev || '' };
  }

  // ----- 입고 / 출고 -----
  var qty = Math.floor(Number(p.qty) || 0);
  if (qty < 1) throw new Error('수량은 1 이상이어야 합니다');
  if (type === 'IN') { after = before + qty; if (p.loc) loc = p.loc; }
  else { if (before < qty) throw new Error('재고 부족: 현재고 ' + before); after = before - qty; }

  itemsTable.sheet.getRange(item._row, 6).setValue(after);        // stock
  if (type === 'IN' && p.loc) itemsTable.sheet.getRange(item._row, 7).setValue(loc);  // location
  item.stock = after; item.location = loc;                         // in-memory 갱신 → 배치 내 후속 행 반영

  appendRow_('History', {
    tx_id: uid_(), ts: Date.now(), type: type, item_code: item.item_code, rev: item.rev || '',
    qty: qty, before: before, after: after, location: loc, reason: p.reason || '', user: user.name
  });
  return { ok: true, type: type, qty: qty, before: before, after: after, code: item.item_code, rev: item.rev || '' };
}

/* 출고로 재고가 안전재고선을 "이번에 처음" 밑돈 경우에만 실시간 Chat 알림 (중복 방지) */
function notifyLowStockIfCrossed_(item, outQty) {
  var safety = item ? Number(item.safety_stock) || 0 : 0;
  if (safety <= 0) return;
  var totalAfter = Number(item.stock) || 0;      // 재고는 (품번+리비전) 행에 직접 저장돼 있음
  var totalBefore = totalAfter + outQty;
  if (totalBefore >= safety && totalAfter < safety) {
    var sku = item.item_code + (item.rev ? ' (' + item.rev + ')' : '');
    notifyChat_('⚠️ 안전재고 미달: ' + (item.name || sku) + ' [' + sku + '] 현재고 ' + totalAfter + (item.unit || '') + ' (안전재고 ' + safety + (item.unit || '') + ')');
  }
}

function tx_(user, p) {
  var itemsTable = readTable_('Items');
  var r = applyTx_(user, p, itemsTable);
  if (r.type === 'OUT') notifyLowStockIfCrossed_(findItem_(itemsTable.rows, r.code, r.rev), r.qty);
  else if (r.type === 'ADJUST' && r.delta < 0) notifyLowStockIfCrossed_(findItem_(itemsTable.rows, r.code, r.rev), -r.delta);
  rebuildReports_();
  return { ok: true, after: r.after, snapshot: snapshot_() };
}

/* 여러 입·출고를 한 번에 처리 — 행별 성공/실패를 모아 반환(부분 성공 허용) */
function bulkTx_(user, p) {
  var rows = p.rows || [];
  if (!rows.length) throw new Error('처리할 항목이 없습니다');
  if (rows.length > 200) throw new Error('한 번에 최대 200건까지 처리할 수 있습니다');

  var itemsTable = readTable_('Items');
  var results = [], outKeys = {};
  rows.forEach(function (row, i) {
    try {
      var r = applyTx_(user, row, itemsTable);
      results.push({ idx: i, code: row.code, rev: row.rev, ok: true, type: r.type, qty: r.qty, after: r.after });
      if (r.type === 'OUT') { var k = r.code + '|' + (r.rev || ''); outKeys[k] = (outKeys[k] || 0) + r.qty; }
    } catch (err) {
      results.push({ idx: i, code: row.code, rev: row.rev, ok: false, error: String(err && err.message ? err.message : err) });
    }
  });

  // 안전재고 미달 크로싱 알림 (배치 종료 후 품번+리비전별 1회, in-memory 재고 재사용)
  Object.keys(outKeys).forEach(function (k) {
    var parts = k.split('|'), item = findItem_(itemsTable.rows, parts[0], parts[1]);
    if (item) notifyLowStockIfCrossed_(item, outKeys[k]);
  });
  rebuildReports_();
  return { ok: true, results: results, snapshot: snapshot_() };
}

/* ============ 품번 마스터 동기화 (AppSheet 웹훅 수신) ============ */
/* AppSheet(부품 품번 관리 시스템)가 품번+리비전을 밀어넣는 단방향 동기화.
   마스터 컬럼(name·unit·safety_stock)만 업서트하고 stock·location(LOT-IMS 정본)은 건드리지 않는다. */
function syncItem_(p) {
  var token = String(settingsGet_('syncToken', ''));
  if (!token) throw new Error('syncToken 미설정 — 관리 > 알림/연동에서 토큰을 먼저 설정하세요');
  if (String(p.token || '') !== token) throw new Error('동기화 토큰이 올바르지 않습니다');
  var code = String(p.code || '').toUpperCase(), rev = String(p.rev || '').toUpperCase();
  if (!code) throw new Error('품번(code)이 필요합니다');
  var t = readTable_('Items');
  var row = findItem_(t.rows, code, rev);
  if (row) {   // upsert: 있으면 마스터 컬럼만 갱신 (name(3)·unit(4)·safety_stock(5))
    if (p.name !== undefined) t.sheet.getRange(row._row, 3).setValue(p.name);
    if (p.unit !== undefined) t.sheet.getRange(row._row, 4).setValue(p.unit || 'EA');
    if (p.safetyStock !== undefined) t.sheet.getRange(row._row, 5).setValue(Number(p.safetyStock) || 0);
  } else {     // 없으면 신규 (stock 0, location 공란)
    appendRow_('Items', { item_code: code, rev: rev, name: p.name || '', unit: p.unit || 'EA', safety_stock: Number(p.safetyStock) || 0, stock: 0, location: '' });
  }
  rebuildReports_();
  return { ok: true, code: code, rev: rev };
}

/* ============ 문서 / 이미지 보관 (Google Drive · 품번 단위) ============ */
function uploadDoc_(user, p) {
  var code = String(p.code || '').toUpperCase(), rev = String(p.rev || '').toUpperCase();
  if (!code) throw new Error('품번이 필요합니다');
  var item = findItem_(readTable_('Items').rows, code, rev);
  if (!item) throw new Error('등록되지 않은 품번/리비전: ' + (p.code || ''));
  if (!p.base64 || !p.fileName) throw new Error('첨부 파일이 없습니다');

  var folder = DriveApp.getFolderById(settingsGet_('driveFolderId') || ensureDriveFolder_());
  var blob = Utilities.newBlob(Utilities.base64Decode(p.base64), p.mimeType || 'application/octet-stream', p.fileName);
  var file = folder.createFile(blob);
  file.setName(code + (rev ? '-' + rev : '') + '_' + (p.category || '기타') + '_' + Date.now() + '_' + p.fileName);
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { /* 도메인 정책상 실패할 수 있음 — 무시 */ }

  appendRow_('Documents', {
    doc_id: uid_(), item_code: code, rev: rev, category: p.category || '기타',
    file_id: file.getId(), file_name: p.fileName, uploaded_by: user.name, uploaded_at: Date.now()
  });
  return { ok: true, docs: listDocsForItem_(code, rev) };
}
function listDocsForItem_(code, rev) {
  if (!code) return [];
  var c = String(code).toUpperCase(), r = String(rev || '').toUpperCase();
  return readTable_('Documents').rows
    .filter(function (x) { return String(x.item_code).toUpperCase() === c && String(x.rev || '').toUpperCase() === r; })
    .sort(function (a, b) { return Number(b.uploaded_at) - Number(a.uploaded_at); })
    .map(docView_);
}
function docView_(r) {
  return {
    id: r.doc_id, itemCode: r.item_code, rev: r.rev || '', category: r.category,
    fileId: r.file_id, fileName: r.file_name, uploadedBy: r.uploaded_by, uploadedAt: Number(r.uploaded_at) || 0,
    thumbUrl: 'https://drive.google.com/thumbnail?id=' + r.file_id + '&sz=w400',
    viewUrl: 'https://drive.google.com/file/d/' + r.file_id + '/view'
  };
}
function delDoc_(p) {
  var t = readTable_('Documents');
  var row = t.rows.filter(function (r) { return String(r.doc_id) === String(p.id); })[0];
  if (!row) throw new Error('문서를 찾을 수 없습니다');
  try { DriveApp.getFileById(row.file_id).setTrashed(true); } catch (e) { /* 이미 삭제된 경우 무시 */ }
  t.sheet.deleteRow(row._row);
  return { ok: true, docs: listDocsForItem_(row.item_code, row.rev) };
}

/* ============ 품질검사 / 이상신고 (품번 단위) ============ */
function reportIssue_(user, p) {
  if (!p.title) throw new Error('제목을 입력하세요');
  var severity = ['경미', '중대', '긴급'].indexOf(p.severity) >= 0 ? p.severity : '경미';
  var itemCode = String(p.code || '').toUpperCase(), rev = String(p.rev || '').toUpperCase();
  var item = itemCode ? findItem_(readTable_('Items').rows, itemCode, rev) : null;   // Items 시트 1회만 읽어 재사용
  if (itemCode && !item) throw new Error('등록되지 않은 품번/리비전: ' + p.code);
  var sku = itemCode ? (itemCode + (rev ? ' (' + rev + ')' : '')) : '';
  var photoFileId = '';
  if (p.base64 && p.fileName) {
    var folder = DriveApp.getFolderById(settingsGet_('driveFolderId') || ensureDriveFolder_());
    var blob = Utilities.newBlob(Utilities.base64Decode(p.base64), p.mimeType || 'image/jpeg', p.fileName);
    var file = folder.createFile(blob);
    file.setName('issue_' + (itemCode ? itemCode + (rev ? '-' + rev : '') : 'general') + '_' + Date.now() + '_' + p.fileName);
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
    photoFileId = file.getId();
  }
  var issueId = uid_();
  appendRow_('Issues', {
    issue_id: issueId, item_code: itemCode, rev: rev, severity: severity,
    title: p.title, description: p.description || '', photo_file_id: photoFileId,
    status: '접수', reported_by: user.name, reported_at: Date.now(), updated_by: '', updated_at: '', resolution_note: ''
  });
  if (severity === '중대' || severity === '긴급') {
    var itemName = item ? (item.name || itemCode) : '';
    notifyChat_('🚨 [' + severity + '] 품질 이상신고: ' + p.title + (sku ? ' — ' + sku + (itemName ? ' (' + itemName + ')' : '') : '') + ' · 신고자 ' + user.name);
  }
  return { ok: true, issueId: issueId, issues: listIssues_({}), snapshot: snapshot_() };
}
function listIssues_(f) {
  var rows = readTable_('Issues').rows;
  if (f && f.status && f.status !== 'ALL') rows = rows.filter(function (r) { return r.status === f.status; });
  if (f && f.code) rows = rows.filter(function (r) { return String(r.item_code) === String(f.code) && (f.rev === undefined || String(r.rev || '') === String(f.rev || '')); });
  return rows.sort(function (a, b) { return Number(b.reported_at) - Number(a.reported_at); })
    .slice(0, 300)
    .map(function (r) {
      return {
        id: r.issue_id, itemCode: r.item_code, rev: r.rev || '', severity: r.severity, title: r.title,
        description: r.description, status: r.status, reportedBy: r.reported_by, reportedAt: Number(r.reported_at) || 0,
        updatedBy: r.updated_by, updatedAt: Number(r.updated_at) || 0, resolutionNote: r.resolution_note,
        photoThumb: r.photo_file_id ? ('https://drive.google.com/thumbnail?id=' + r.photo_file_id + '&sz=w400') : '',
        photoView: r.photo_file_id ? ('https://drive.google.com/file/d/' + r.photo_file_id + '/view') : ''
      };
    });
}
function updateIssue_(user, p) {
  if (['접수', '처리중', '완료'].indexOf(p.status) < 0) throw new Error('잘못된 상태값');
  var t = readTable_('Issues');
  var row = t.rows.filter(function (r) { return String(r.issue_id) === String(p.id); })[0];
  if (!row) throw new Error('신고 건을 찾을 수 없습니다');
  // 버전 충돌 감지: 클라이언트가 화면에 띄운 시점(baseVersion) 이후 다른 사람이 먼저 바꿨으면 거부 (소프트 락이 뚫려도 덮어쓰기 방지)
  if (p.baseVersion !== undefined && p.baseVersion !== '') {
    var current = Number(row.updated_at) || Number(row.reported_at) || 0;
    if (Number(p.baseVersion) !== current) throw new Error('다른 사용자가 먼저 수정했습니다. 새로고침 후 다시 시도하세요');
  }
  // Issues 컬럼: issue_id(1)·item_code(2)·rev(3)·severity(4)·title(5)·description(6)·photo_file_id(7)·status(8)·reported_by(9)·reported_at(10)·updated_by(11)·updated_at(12)·resolution_note(13)
  t.sheet.getRange(row._row, 8).setValue(p.status);                       // status
  t.sheet.getRange(row._row, 11).setValue(user.name);                     // updated_by
  t.sheet.getRange(row._row, 12).setValue(Date.now());                    // updated_at
  t.sheet.getRange(row._row, 13).setValue(p.resolutionNote || row.resolution_note || ''); // resolution_note
  autoReleaseLock_(user, 'issue:' + p.id);                                // 저장 완료 → 내 잠금 해제
  return { ok: true, issues: listIssues_({}), snapshot: snapshot_() };
}

/* ============ 리포트 (인앱 차트 + Looker Studio 연동용 평탄화 시트) ============ */
function reportData_() {
  var items = readTable_('Items').rows;
  var hist = readTable_('History').rows;

  var stockByItem = items.map(function (it) {
    return { code: it.item_code, rev: String(it.rev || ''), name: it.name, unit: it.unit, qty: Number(it.stock) || 0, safetyStock: Number(it.safety_stock) || 0, group: groupCodeOf_(it.item_code) };
  }).sort(function (a, b) { return b.qty - a.qty; });

  // 제품군별 집계 (품번 앞자리 기준)
  var byGroup = {};
  items.forEach(function (it) {
    var g = groupCodeOf_(it.item_code);
    if (!byGroup[g]) byGroup[g] = { group: g, name: GROUP_NAMES[g] || g, items: 0, qty: 0, low: 0 };
    byGroup[g].items++; byGroup[g].qty += Number(it.stock) || 0;
    if (Number(it.safety_stock) > 0 && Number(it.stock) < Number(it.safety_stock)) byGroup[g].low++;
  });
  var groupBreakdown = Object.keys(byGroup).map(function (k) { return byGroup[k]; }).sort(function (a, b) { return b.qty - a.qty; });

  // 최근 14일 입출고 추이
  var days = [];
  for (var i = 13; i >= 0; i--) {
    var d = new Date(); d.setDate(d.getDate() - i);
    days.push(Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'));
  }
  var trend = days.map(function (ds) {
    var dayIn = 0, dayOut = 0;
    hist.forEach(function (h) {
      var hd = Utilities.formatDate(new Date(Number(h.ts)), Session.getScriptTimeZone(), 'yyyy-MM-dd');
      if (hd === ds) { if (h.type === 'IN') dayIn += Number(h.qty) || 0; if (h.type === 'OUT') dayOut += Number(h.qty) || 0; }
    });
    return { date: ds, in: dayIn, out: dayOut };
  });

  return {
    stockByItem: stockByItem,
    groupBreakdown: groupBreakdown,
    lowStockCount: stockByItem.filter(function (s) { return s.safetyStock > 0 && s.qty < s.safetyStock; }).length,
    openIssueCount: readTable_('Issues').rows.filter(function (r) { return r.status !== '완료'; }).length,
    totalItems: items.length,
    totalStock: items.reduce(function (s, it) { return s + (Number(it.stock) || 0); }, 0),
    trend: trend
  };
}

/* Looker Studio 등 외부 BI 도구에서 바로 연결해 쓸 수 있도록
   품목명/단위 등을 조인해 평탄화한 참조용 시트를 재생성한다. */
function rebuildReports_() {
  var items = readTable_('Items').rows, locs = readTable_('Locations').rows;
  var itemMap = {}; items.forEach(function (i) { itemMap[String(i.item_code).toUpperCase() + '|' + String(i.rev || '').toUpperCase()] = i; });
  var locMap = {}; locs.forEach(function (l) { locMap[l.location_code] = l; });

  // 품번+리비전 단위 재고 (한 행 = 한 (품번,리비전)) · 제품군 컬럼 포함
  var stockSh = getOrCreate_('Report_Stock', ['item_code', 'rev', 'item_name', 'group_code', 'group_name', 'unit', 'stock', 'safety_stock', 'location_code', 'warehouse']);
  stockSh.getRange(2, 1, Math.max(stockSh.getMaxRows() - 1, 1), 10).clearContent();
  if (items.length) {
    var stockRows = items.map(function (it) {
      var loc = locMap[it.location] || {}, g = groupCodeOf_(it.item_code);
      return [it.item_code, it.rev || '', it.name || '', g, GROUP_NAMES[g] || g, it.unit || '', Number(it.stock) || 0, Number(it.safety_stock) || 0, it.location || '', loc.warehouse || ''];
    });
    stockSh.getRange(2, 1, stockRows.length, 10).setValues(stockRows);
  }

  var txSh = getOrCreate_('Report_Tx', ['ts', 'date', 'type', 'item_code', 'rev', 'item_name', 'group_code', 'qty', 'location', 'user']);
  var hist = readTable_('History').rows;
  txSh.getRange(2, 1, Math.max(txSh.getMaxRows() - 1, 1), 10).clearContent();
  if (hist.length) {
    var txRows = hist.map(function (h) {
      var it = itemMap[String(h.item_code).toUpperCase() + '|' + String(h.rev || '').toUpperCase()] || {};
      return [Number(h.ts) || 0, Utilities.formatDate(new Date(Number(h.ts) || 0), Session.getScriptTimeZone(), 'yyyy-MM-dd'), h.type, h.item_code, h.rev || '', it.name || '', groupCodeOf_(h.item_code), Number(h.qty) || 0, h.location || '', h.user];
    });
    txSh.getRange(2, 1, txRows.length, 10).setValues(txRows);
  }
}
function getOrCreate_(name, headers) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sh;
}

/* ============ 자동 알림: Google Chat (실시간) / Gmail (일일 다이제스트) ============ */
function notifyChat_(text) {
  var url = settingsGet_('chatWebhookUrl');
  if (!url) return false;
  try {
    UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ text: text }), muteHttpExceptions: true });
    return true;
  } catch (e) { return false; }
}

/** 시간 트리거 대상 함수. force=true 이면 수신자가 없어도 시도(테스트용 로그만 남김) */
function sendDailyDigest_(force) {
  var items = readTable_('Items').rows;
  var todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  var low = items.map(function (it) {
    return { sku: it.item_code + (it.rev ? ' (' + it.rev + ')' : ''), name: it.name, unit: it.unit, qty: Number(it.stock) || 0, safety: Number(it.safety_stock) || 0 };
  }).filter(function (i) { return i.safety > 0 && i.qty < i.safety; });
  var openIssues = readTable_('Issues').rows.filter(function (r) { return r.status !== '완료'; });

  var lines = [];
  lines.push('<h2>재고 일일 알림 (' + todayStr + ')</h2>');
  lines.push('<p><b>안전재고 미달: ' + low.length + '건</b></p>');
  if (low.length) lines.push('<ul>' + low.map(function (i) { return '<li>' + i.name + ' [' + i.sku + '] — 현재고 ' + i.qty + i.unit + ' / 안전재고 ' + i.safety + i.unit + '</li>'; }).join('') + '</ul>');
  lines.push('<p><b>미해결 품질신고: ' + openIssues.length + '건</b></p>');
  var html = lines.join('\n');

  var emails = String(settingsGet_('alertEmails', '')).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var sent = false;
  if (emails.length) {
    MailApp.sendEmail({ to: emails.join(','), subject: '[재고관리] 일일 재고 알림 (' + todayStr + ')', htmlBody: html });
    sent = true;
  }
  notifyChat_('📋 일일 재고 알림 — 안전재고 미달 ' + low.length + '건 · 미해결 신고 ' + openIssues.length + '건');
  return sent;
}
function installDailyAlerts_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendDailyDigest_') ScriptApp.deleteTrigger(t);
  });
  var hour = Number(settingsGet_('alertHour', 8)) || 8;
  ScriptApp.newTrigger('sendDailyDigest_').timeBased().everyDays(1).atHour(hour).create();
  return true;
}

/* ============ 사용자 / 품목 / 위치 관리 ============ */
function addUser_(p) {
  if (!p.id || !p.name || !p.pwHash) throw new Error('입력값 부족');
  if (readTable_('Users').rows.some(function (u) { return u.user_id === p.id; })) throw new Error('이미 존재하는 아이디');
  appendRow_('Users', { user_id: p.id, name: p.name, role: p.role === 'admin' ? 'admin' : 'worker', pw_hash: p.pwHash, created_at: Date.now() });
  return { ok: true, snapshot: snapshot_() };
}
function setPw_(id, newPwHash) {
  if (!newPwHash) throw new Error('새 비밀번호가 없습니다');
  var t = readTable_('Users');
  var u = t.rows.filter(function (r) { return r.user_id === id; })[0];
  if (!u) throw new Error('사용자를 찾을 수 없습니다');
  t.sheet.getRange(u._row, 4).setValue(newPwHash);
  return { ok: true };
}
var PN_RE = /^[A-Z0-9][A-Z0-9-]{1,23}$/;   // 품번: 영문/숫자/하이픈 (예: RP-303-013)
function addItem_(p) {
  var code = String(p.code || '').toUpperCase(), rev = String(p.rev || '').toUpperCase();
  if (!PN_RE.test(code)) throw new Error('품번 형식이 올바르지 않습니다 (영문/숫자/하이픈)');
  if (!p.name) throw new Error('품명을 입력하세요');
  if (findItem_(readTable_('Items').rows, code, rev)) throw new Error('이미 존재하는 품번/리비전');
  appendRow_('Items', { item_code: code, rev: rev, name: p.name, unit: p.unit || 'EA', safety_stock: Number(p.safetyStock) || 0, stock: 0, location: '' });
  rebuildReports_();
  return { ok: true, snapshot: snapshot_() };
}
function delItem_(p) {
  var t = readTable_('Items');
  var item = findItem_(t.rows, p.code, p.rev);
  if (!item) throw new Error('대상을 찾을 수 없습니다');
  if (Number(item.stock) > 0) throw new Error('재고가 남아 있는 품번은 삭제할 수 없습니다');
  if (itemInBom_(readBOM_().rows, item.item_code, item.rev)) throw new Error('BOM에 등록된 품번은 삭제할 수 없습니다 (조립 관계를 먼저 삭제하세요)');
  t.sheet.deleteRow(item._row);
  rebuildReports_();
  return { ok: true, snapshot: snapshot_() };
}
/* 품번 마스터 필드(품명·단위·안전재고) 수정. stock·location(정본)은 건드리지 않는다.
   Items 컬럼: item_code(1)·rev(2)·name(3)·unit(4)·safety_stock(5)·stock(6)·location(7)
   버전 충돌 감지: Items 시트엔 updated_at이 없어 가변필드(name|unit|safety_stock) 스냅샷을 baseVersion으로 비교한다. */
function editItem_(user, p) {
  var code = String(p.code || '').toUpperCase(), rev = String(p.rev || '').toUpperCase();
  var t = readTable_('Items');
  var item = findItem_(t.rows, code, rev);
  if (!item) throw new Error('대상을 찾을 수 없습니다');
  if (p.baseVersion !== undefined && p.baseVersion !== '') {
    var current = [item.name, item.unit || 'EA', Number(item.safety_stock) || 0].join('|');
    if (String(p.baseVersion) !== current) throw new Error('다른 사용자가 먼저 수정했습니다. 새로고침 후 다시 시도하세요');
  }
  if (!p.name) throw new Error('품명을 입력하세요');
  t.sheet.getRange(item._row, 3).setValue(p.name);                        // name
  t.sheet.getRange(item._row, 4).setValue(p.unit || 'EA');                // unit
  t.sheet.getRange(item._row, 5).setValue(Number(p.safetyStock) || 0);    // safety_stock
  autoReleaseLock_(user, 'item:' + code + '|' + rev);                     // 저장 완료 → 내 잠금 해제
  rebuildReports_();
  return { ok: true, snapshot: snapshot_() };
}
/* 여러 품번을 한 번에 등록 — 행별 성공/실패를 모아 반환(부분 성공 허용) */
function bulkAddItem_(p) {
  var rows = p.rows || [];
  if (!rows.length) throw new Error('등록할 품번이 없습니다');
  if (rows.length > 200) throw new Error('한 번에 최대 200건까지 등록할 수 있습니다');
  var existing = {};
  readTable_('Items').rows.forEach(function (r) { existing[String(r.item_code).toUpperCase() + '|' + String(r.rev || '').toUpperCase()] = true; });
  var results = [];
  rows.forEach(function (row, i) {
    try {
      var code = String(row.code || '').toUpperCase(), rev = String(row.rev || '').toUpperCase();
      if (!PN_RE.test(code)) throw new Error('품번 형식 오류 (영문/숫자/하이픈)');
      if (!row.name) throw new Error('품명을 입력하세요');
      var key = code + '|' + rev;
      if (existing[key]) throw new Error('이미 존재하는 품번/리비전');
      appendRow_('Items', { item_code: code, rev: rev, name: row.name, unit: row.unit || 'EA', safety_stock: Number(row.safetyStock) || 0, stock: 0, location: '' });
      existing[key] = true;   // 배치 내 중복도 차단
      results.push({ idx: i, code: code, rev: rev, ok: true });
    } catch (err) {
      results.push({ idx: i, code: row.code, rev: row.rev, ok: false, error: String(err && err.message ? err.message : err) });
    }
  });
  rebuildReports_();
  return { ok: true, results: results, snapshot: snapshot_() };
}
function addLoc_(p) {
  var code = String(p.code || '').toUpperCase();
  if (!code) throw new Error('위치코드를 입력하세요');
  if (readTable_('Locations').rows.some(function (l) { return String(l.location_code) === code; })) throw new Error('이미 존재하는 위치코드');
  appendRow_('Locations', { location_code: code, warehouse: p.warehouse || '', zone: p.zone || '', rack: p.rack || '' });
  return { ok: true, snapshot: snapshot_() };
}
function delLoc_(p) {
  var used = readTable_('Items').rows.some(function (i) { return String(i.location) === String(p.code) && Number(i.stock) > 0; });
  if (used) throw new Error('재고가 보관 중인 위치는 삭제할 수 없습니다');
  return delRow_('Locations', 'location_code', p.code, null);
}
function wipe_() {
  ['Items', 'Locations', 'History', 'Documents', 'Issues'].forEach(function (name) {
    var sh = sheet_(name);
    if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  });
  var bsh = bomSheet_();                                   // BOM은 지연생성 시트라 별도 처리
  if (bsh.getLastRow() > 1) bsh.deleteRows(2, bsh.getLastRow() - 1);
  rebuildReports_();
  rebuildBomReport_();
  return { ok: true, snapshot: snapshot_() };
}

/* ============ BOM / 조립(assy) ============
   BOM 시트: 한 행 = 부모→자식 엣지. 다단계 = 엣지 체인. assy = "BOM에 자식이 있는 품번"(플래그 없음).
   BOM 컬럼: bom_id(1)·parent_code(2)·parent_rev(3)·child_code(4)·child_rev(5)·qty_per(6)·seq(7)·memo(8) */
function bomSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName('BOM');
  if (!sh) { sh = ss.insertSheet('BOM'); sh.appendRow(SHEET_HEADERS.BOM); sh.setFrozenRows(1); }  // 기존 설치도 setup 재실행 없이 자동 생성
  return sh;
}
function readBOM_() {
  var sh = bomSheet_();
  var last = sh.getLastRow();
  if (last < 2) return { sheet: sh, rows: [] };
  var vals = sh.getRange(2, 1, last - 1, SHEET_HEADERS.BOM.length).getValues();
  var rows = vals.map(function (v, i) {
    return { _row: i + 2, bom_id: String(v[0]), parent_code: String(v[1]), parent_rev: String(v[2]), child_code: String(v[3]), child_rev: String(v[4]), qty_per: Number(v[5]) || 0, seq: Number(v[6]) || 0, memo: String(v[7] || '') };
  });
  return { sheet: sh, rows: rows };
}
function skuText_(code, rev) { return String(code) + (rev ? ' (' + rev + ')' : ''); }
function bomKey_(c, r) { return String(c || '').toUpperCase() + '|' + String(r || '').toUpperCase(); }
function childrenOf_(bomRows, code, rev) {
  var k = bomKey_(code, rev);
  return bomRows.filter(function (e) { return bomKey_(e.parent_code, e.parent_rev) === k; })
                .sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
}
function isAssy_(bomRows, code, rev) {
  var k = bomKey_(code, rev);
  return bomRows.some(function (e) { return bomKey_(e.parent_code, e.parent_rev) === k; });
}
function itemInBom_(bomRows, code, rev) {
  var k = bomKey_(code, rev);
  return bomRows.some(function (e) { return bomKey_(e.parent_code, e.parent_rev) === k || bomKey_(e.child_code, e.child_rev) === k; });
}
/* 엣지 P→C 추가 시, C에서 P로 이미 도달 가능하면 순환. seen 가드로 손상 데이터 무한루프 방지. */
function bomReaches_(bomRows, startKey, targetKey) {
  if (startKey === targetKey) return true;
  var adj = {};
  bomRows.forEach(function (e) {
    var p = bomKey_(e.parent_code, e.parent_rev);
    (adj[p] = adj[p] || []).push(bomKey_(e.child_code, e.child_rev));
  });
  var stack = [startKey], seen = {};
  while (stack.length) {
    var n = stack.pop();
    if (n === targetKey) return true;
    if (seen[n]) continue; seen[n] = true;
    (adj[n] || []).forEach(function (c) { if (!seen[c]) stack.push(c); });
  }
  return false;
}
function assertNoCycle_(bomRows, pKey, cKey) {
  if (pKey === cKey) throw new Error('자기 자신을 구성품으로 넣을 수 없습니다');
  if (bomReaches_(bomRows, cKey, pKey)) throw new Error('순환 구조가 됩니다 (하위 구성품이 이미 상위에 포함됨)');
}
/* 조립 가능 수량 = min over children floor(child.stock / qty_per). 자식 없으면 null(조립품 아님). */
function buildableQty_(bomRows, itemsRows, code, rev) {
  var kids = childrenOf_(bomRows, code, rev);
  if (!kids.length) return null;
  return kids.reduce(function (min, e) {
    var ci = findItem_(itemsRows, e.child_code, e.child_rev);
    var per = Number(e.qty_per) || 0;
    var have = ci ? Number(ci.stock) || 0 : 0;
    var n = per > 0 ? Math.floor(have / per) : 0;
    return Math.min(min, n);
  }, Infinity);
}

/* ----- BOM 구조 편집 (관리자) ----- */
function addBOM_(p) {
  var pc = String(p.parentCode || '').toUpperCase(), pr = String(p.parentRev || '').toUpperCase();
  var cc = String(p.childCode || '').toUpperCase(), cr = String(p.childRev || '').toUpperCase();
  var qty = Math.floor(Number(p.qtyPer) || 0);
  if (!pc || !cc) throw new Error('부모/자식 품번이 필요합니다');
  if (qty < 1) throw new Error('소요량은 1 이상의 정수여야 합니다');
  var items = readTable_('Items').rows;
  if (!findItem_(items, pc, pr)) throw new Error('등록되지 않은 부모 품번/리비전: ' + skuText_(pc, pr));
  if (!findItem_(items, cc, cr)) throw new Error('등록되지 않은 자식 품번/리비전: ' + skuText_(cc, cr));
  var t = readBOM_();
  if (t.rows.some(function (e) { return bomKey_(e.parent_code, e.parent_rev) === bomKey_(pc, pr) && bomKey_(e.child_code, e.child_rev) === bomKey_(cc, cr); }))
    throw new Error('이미 존재하는 BOM 구성입니다');
  assertNoCycle_(t.rows, bomKey_(pc, pr), bomKey_(cc, cr));
  t.sheet.appendRow([uid_(), pc, pr, cc, cr, qty, Number(p.seq) || 0, p.memo || '']);
  rebuildBomReport_();
  return { ok: true, snapshot: snapshot_() };
}
/* 여러 BOM 엣지를 한 번에 등록 — 행별 성공/실패(부분 성공). 배치 내 중복/순환도 증분 검사. */
function bulkAddBOM_(p) {
  var rows = p.rows || [];
  if (!rows.length) throw new Error('등록할 BOM이 없습니다');
  if (rows.length > 200) throw new Error('한 번에 최대 200건까지 등록할 수 있습니다');
  var items = readTable_('Items').rows;
  var t = readBOM_();
  var working = t.rows.slice();     // 증분 순환 검사용 (수락된 엣지를 즉시 반영)
  var existing = {};
  t.rows.forEach(function (e) { existing[bomKey_(e.parent_code, e.parent_rev) + '>' + bomKey_(e.child_code, e.child_rev)] = true; });
  var toAppend = [], results = [];
  rows.forEach(function (row, i) {
    try {
      var pc = String(row.parentCode || '').toUpperCase(), pr = String(row.parentRev || '').toUpperCase();
      var cc = String(row.childCode || '').toUpperCase(), cr = String(row.childRev || '').toUpperCase();
      var qty = Math.floor(Number(row.qtyPer) || 0);
      if (!pc || !cc) throw new Error('부모/자식 품번을 입력하세요');
      if (qty < 1) throw new Error('소요량은 1 이상의 정수');
      if (!findItem_(items, pc, pr)) throw new Error('미등록 부모: ' + skuText_(pc, pr));
      if (!findItem_(items, cc, cr)) throw new Error('미등록 자식: ' + skuText_(cc, cr));
      var ek = bomKey_(pc, pr) + '>' + bomKey_(cc, cr);
      if (existing[ek]) throw new Error('이미 존재하는 BOM 구성');
      assertNoCycle_(working, bomKey_(pc, pr), bomKey_(cc, cr));
      var edge = { bom_id: uid_(), parent_code: pc, parent_rev: pr, child_code: cc, child_rev: cr, qty_per: qty, seq: Number(row.seq) || 0, memo: row.memo || '' };
      working.push(edge);
      existing[ek] = true;
      toAppend.push([edge.bom_id, pc, pr, cc, cr, qty, edge.seq, edge.memo]);
      results.push({ idx: i, parentCode: pc, parentRev: pr, childCode: cc, childRev: cr, ok: true });
    } catch (err) {
      results.push({ idx: i, parentCode: row.parentCode, parentRev: row.parentRev, childCode: row.childCode, childRev: row.childRev, ok: false, error: String(err && err.message ? err.message : err) });
    }
  });
  if (toAppend.length) t.sheet.getRange(t.sheet.getLastRow() + 1, 1, toAppend.length, SHEET_HEADERS.BOM.length).setValues(toAppend);
  rebuildBomReport_();
  return { ok: true, results: results, snapshot: snapshot_() };
}
function delBOM_(p) {
  var t = readBOM_();
  var row = t.rows.filter(function (e) { return String(e.bom_id) === String(p.id); })[0];
  if (!row) throw new Error('BOM 구성을 찾을 수 없습니다');
  t.sheet.deleteRow(row._row);
  rebuildBomReport_();
  return { ok: true, snapshot: snapshot_() };
}
/* 현재 부모의 자식 엣지 스냅샷 (버전 충돌 감지용) — childKey:qty 정렬 join */
function bomParentSnapshot_(edges) {
  return edges.map(function (e) { return bomKey_(e.child_code, e.child_rev) + ':' + (Number(e.qty_per) || 0); }).sort().join(',');
}
/* 부모의 모든 엣지를 원자적으로 교체 (편집 경로). baseVersion으로 충돌 감지, 순환은 이 부모 엣지를 뺀 그래프 기준. */
function setBOMParent_(user, p) {
  var pc = String(p.parentCode || '').toUpperCase(), pr = String(p.parentRev || '').toUpperCase();
  if (!pc) throw new Error('부모 품번이 필요합니다');
  var items = readTable_('Items').rows;
  if (!findItem_(items, pc, pr)) throw new Error('등록되지 않은 부모 품번/리비전: ' + skuText_(pc, pr));
  var t = readBOM_();
  var pKey = bomKey_(pc, pr);
  var current = t.rows.filter(function (e) { return bomKey_(e.parent_code, e.parent_rev) === pKey; });
  if (p.baseVersion !== undefined && p.baseVersion !== '') {
    if (String(p.baseVersion) !== bomParentSnapshot_(current)) throw new Error('다른 사용자가 먼저 수정했습니다. 새로고침 후 다시 시도하세요');
  }
  var working = t.rows.filter(function (e) { return bomKey_(e.parent_code, e.parent_rev) !== pKey; });   // 이 부모 엣지 제외
  var seen = {}, newEdges = [];
  (p.children || []).forEach(function (ch) {
    var cc = String(ch.childCode || '').toUpperCase(), cr = String(ch.childRev || '').toUpperCase();
    var qty = Math.floor(Number(ch.qtyPer) || 0);
    if (!cc) throw new Error('자식 품번을 입력하세요');
    if (qty < 1) throw new Error('소요량은 1 이상의 정수여야 합니다: ' + skuText_(cc, cr));
    if (!findItem_(items, cc, cr)) throw new Error('등록되지 않은 자식 품번/리비전: ' + skuText_(cc, cr));
    var ck = bomKey_(cc, cr);
    if (seen[ck]) throw new Error('중복 자식: ' + skuText_(cc, cr));
    seen[ck] = true;
    assertNoCycle_(working, pKey, ck);
    var edge = { bom_id: uid_(), parent_code: pc, parent_rev: pr, child_code: cc, child_rev: cr, qty_per: qty, seq: Number(ch.seq) || 0, memo: ch.memo || '' };
    working.push(edge);
    newEdges.push(edge);
  });
  deleteLockRows_(t.sheet, current);   // 기존 부모 엣지 삭제 (아래→위 정렬삭제 재사용)
  if (newEdges.length) {
    var out = newEdges.map(function (e) { return [e.bom_id, e.parent_code, e.parent_rev, e.child_code, e.child_rev, e.qty_per, e.seq, e.memo]; });
    t.sheet.getRange(t.sheet.getLastRow() + 1, 1, out.length, SHEET_HEADERS.BOM.length).setValues(out);
  }
  autoReleaseLock_(user, 'bom:' + pKey);
  rebuildBomReport_();
  return { ok: true, snapshot: snapshot_() };
}

/* ----- 조립 / 분해 (재고 연동, 원자적·전량검증) ----- */
function appendHistoryRows_(rows) {
  if (!rows.length) return;
  var sh = sheet_('History');
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, SHEET_HEADERS.History.length).setValues(rows);   // N× appendRow 대신 1회 배치 (락 점유 단축)
}
/* 단계별 조립: 즉시 하위 구성품만 차감(qty_per×N), assy +N. 모든 자식 전량 검증 후에만 반영. */
function assemble_(user, p) {
  var N = Math.floor(Number(p.qty) || 0);
  if (N < 1) throw new Error('수량은 1 이상이어야 합니다');
  var code = String(p.code || '').toUpperCase(), rev = String(p.rev || '').toUpperCase();
  var itemsTable = readTable_('Items');
  var assy = findItem_(itemsTable.rows, code, rev);
  if (!assy) throw new Error('등록되지 않은 품번/리비전: ' + skuText_(code, rev));
  var edges = childrenOf_(readBOM_().rows, code, rev);
  if (!edges.length) throw new Error(skuText_(code, rev) + ' 은(는) 조립품(BOM 상위)이 아닙니다');

  // 1) 전량 검증 (아무것도 쓰지 않음)
  var plan = edges.map(function (e) {
    var ci = findItem_(itemsTable.rows, e.child_code, e.child_rev);
    if (!ci) throw new Error('구성품 미등록: ' + skuText_(e.child_code, e.child_rev));
    var before = Number(ci.stock) || 0, need = (Number(e.qty_per) || 0) * N;
    return { item: ci, need: need, before: before, after: before - need };
  });
  var short = plan.filter(function (x) { return x.after < 0; });
  if (short.length) throw new Error('구성품 재고 부족: ' + short.map(function (x) { return skuText_(x.item.item_code, x.item.rev) + ' ' + x.before + '/' + x.need; }).join(', '));

  // 2) 반영 (검증 통과 후)
  var buildId = uid_(), ts = Date.now(), sku = skuText_(code, rev);
  var assyBefore = Number(assy.stock) || 0, assyAfter = assyBefore + N;
  var histRows = [[uid_(), ts, 'BUILD', assy.item_code, assy.rev || '', N, assyBefore, assyAfter, assy.location || '', '조립 #' + buildId, user.name]];
  plan.forEach(function (x) {
    itemsTable.sheet.getRange(x.item._row, 6).setValue(x.after);   // 자식 stock(6열)
    x.item.stock = x.after;                                        // in-memory 갱신(저재고 판정용)
    histRows.push([uid_(), ts, 'CONSUME', x.item.item_code, x.item.rev || '', x.need, x.before, x.after, x.item.location || '', '조립 소요 [' + sku + '] #' + buildId, user.name]);
  });
  itemsTable.sheet.getRange(assy._row, 6).setValue(assyAfter);      // assy stock
  appendHistoryRows_(histRows);
  plan.forEach(function (x) { notifyLowStockIfCrossed_(x.item, x.need); });   // 소비된 자식이 안전선 밑으로
  rebuildReports_();
  return { ok: true, buildId: buildId, after: assyAfter, snapshot: snapshot_() };
}
/* 분해: assy −N, 각 자식 +qty_per×N. assy 재고 검증 후 반영. */
function disassemble_(user, p) {
  var N = Math.floor(Number(p.qty) || 0);
  if (N < 1) throw new Error('수량은 1 이상이어야 합니다');
  var code = String(p.code || '').toUpperCase(), rev = String(p.rev || '').toUpperCase();
  var itemsTable = readTable_('Items');
  var assy = findItem_(itemsTable.rows, code, rev);
  if (!assy) throw new Error('등록되지 않은 품번/리비전: ' + skuText_(code, rev));
  var edges = childrenOf_(readBOM_().rows, code, rev);
  if (!edges.length) throw new Error(skuText_(code, rev) + ' 은(는) 조립품(BOM 상위)이 아닙니다');
  var assyBefore = Number(assy.stock) || 0;
  if (assyBefore < N) throw new Error('조립품 재고 부족: 현재고 ' + assyBefore);

  // 전량 검증 (자식 존재 확인) 후 반영
  var plan = edges.map(function (e) {
    var ci = findItem_(itemsTable.rows, e.child_code, e.child_rev);
    if (!ci) throw new Error('구성품 미등록: ' + skuText_(e.child_code, e.child_rev));
    var before = Number(ci.stock) || 0, add = (Number(e.qty_per) || 0) * N;
    return { item: ci, add: add, before: before, after: before + add };
  });
  var buildId = uid_(), ts = Date.now(), sku = skuText_(code, rev);
  var assyAfter = assyBefore - N;
  var histRows = [[uid_(), ts, 'UNBUILD', assy.item_code, assy.rev || '', N, assyBefore, assyAfter, assy.location || '', '분해 #' + buildId, user.name]];
  plan.forEach(function (x) {
    itemsTable.sheet.getRange(x.item._row, 6).setValue(x.after);
    x.item.stock = x.after;
    histRows.push([uid_(), ts, 'RESTORE', x.item.item_code, x.item.rev || '', x.add, x.before, x.after, x.item.location || '', '분해 복원 [' + sku + '] #' + buildId, user.name]);
  });
  itemsTable.sheet.getRange(assy._row, 6).setValue(assyAfter);
  assy.stock = assyAfter;              // in-memory 갱신(저재고 판정용)
  appendHistoryRows_(histRows);
  notifyLowStockIfCrossed_(assy, N);   // 분해로 assy 재고가 안전선 밑으로 내려갈 수 있음
  rebuildReports_();
  return { ok: true, after: assyAfter, snapshot: snapshot_() };
}
/* Report_BOM: 구조 전용(재고 없음). BOM/품목 변경 시에만 재작성 → IN/OUT/조립 hot-path와 분리.
   재고가 필요하면 Looker에서 child_code+child_rev → Report_Stock 조인. */
function rebuildBomReport_() {
  var bom = readBOM_().rows;
  var items = readTable_('Items').rows;
  var itemMap = {}; items.forEach(function (i) { itemMap[bomKey_(i.item_code, i.rev)] = i; });
  var sh = getOrCreate_('Report_BOM', ['parent_code', 'parent_rev', 'parent_name', 'parent_group', 'child_code', 'child_rev', 'child_name', 'child_group', 'qty_per', 'seq', 'memo']);
  sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), 11).clearContent();
  if (bom.length) {
    var rows = bom.map(function (e) {
      var pg = groupCodeOf_(e.parent_code), cg = groupCodeOf_(e.child_code);
      var pi = itemMap[bomKey_(e.parent_code, e.parent_rev)] || {}, ci = itemMap[bomKey_(e.child_code, e.child_rev)] || {};
      return [e.parent_code, e.parent_rev || '', pi.name || '', GROUP_NAMES[pg] || pg, e.child_code, e.child_rev || '', ci.name || '', GROUP_NAMES[cg] || cg, Number(e.qty_per) || 0, Number(e.seq) || 0, e.memo || ''];
    });
    sh.getRange(2, 1, rows.length, 11).setValues(rows);
  }
}

/* ============ 개발 메모 / 개발로그 ============ */
function addDevLog_(user, p) {
  if (!p.title) throw new Error('제목을 입력하세요');
  var category = ['아이디어', '결정', '할일', '버그'].indexOf(p.category) >= 0 ? p.category : '아이디어';
  var id = uid_();
  appendRow_('DevLog', { log_id: id, ts: Date.now(), author: user.name, category: category, title: p.title, content: p.content || '', done: false, updated_at: '' });
  return { ok: true, id: id, logs: listDevLog_({}) };
}
function listDevLog_(f) {
  var rows = readTable_('DevLog').rows;
  if (f && f.category && f.category !== 'ALL') rows = rows.filter(function (r) { return r.category === f.category; });
  return rows.sort(function (a, b) { return Number(b.ts) - Number(a.ts); }).map(function (r) {
    return { id: r.log_id, ts: Number(r.ts) || 0, author: r.author, category: r.category, title: r.title, content: r.content, done: r.done === true || String(r.done) === 'true', updatedAt: Number(r.updated_at) || 0 };
  });
}
function updateDevLog_(p) {
  var t = readTable_('DevLog');
  var row = t.rows.filter(function (r) { return String(r.log_id) === String(p.id); })[0];
  if (!row) throw new Error('항목을 찾을 수 없습니다');
  if (p.done !== undefined) t.sheet.getRange(row._row, 7).setValue(!!p.done);      // done
  if (p.title !== undefined) t.sheet.getRange(row._row, 5).setValue(p.title);      // title
  if (p.content !== undefined) t.sheet.getRange(row._row, 6).setValue(p.content);  // content
  t.sheet.getRange(row._row, 8).setValue(Date.now());                             // updated_at
  return { ok: true, logs: listDevLog_({}) };
}
function delDevLog_(p) {
  var t = readTable_('DevLog');
  var row = t.rows.filter(function (r) { return String(r.log_id) === String(p.id); })[0];
  if (!row) throw new Error('항목을 찾을 수 없습니다');
  t.sheet.deleteRow(row._row);
  return { ok: true, logs: listDevLog_({}) };
}
