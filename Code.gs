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
  DevLog:       ['log_id', 'ts', 'author', 'category', 'title', 'content', 'done', 'updated_at']
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
  rebuildReports_();
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
  try {
    var req = JSON.parse(e.postData.contents);
    return out_(handle_(req));
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}
function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
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

    // ----- 문서/이미지 (품번 단위) -----
    case 'uploadDoc': return withLock_(function () { return uploadDoc_(user, req); });
    case 'listDocs':  return { ok: true, docs: listDocsForItem_(req.code, req.rev) };
    case 'delDoc':    admin_(user); return withLock_(function () { return delDoc_(req); });

    // ----- 품질검사/이상신고 -----
    case 'reportIssue': return withLock_(function () { return reportIssue_(user, req); });
    case 'listIssues':  return { ok: true, issues: listIssues_(req || {}) };
    case 'updateIssue': return withLock_(function () { return updateIssue_(user, req); });

    // ----- 리포트 -----
    case 'reportData': return { ok: true, report: reportData_() };

    // ----- 관리자 전용: 사용자/품목/위치/데이터/알림설정 -----
    case 'addUser':   admin_(user); return withLock_(function () { return addUser_(req); });
    case 'delUser':   admin_(user); return withLock_(function () { return delRow_('Users', 'user_id', req.id, req.id === 'admin' ? '기본 관리자는 삭제할 수 없습니다' : null); });
    case 'setUserPw': admin_(user); return withLock_(function () { return setPw_(req.id, req.newPwHash); });
    case 'addItem':   admin_(user); return withLock_(function () { return addItem_(req); });
    case 'bulkAddItem': admin_(user); return withLock_(function () { return bulkAddItem_(req); });
    case 'delItem':   admin_(user); return withLock_(function () { return delItem_(req); });
    case 'addLoc':    admin_(user); return withLock_(function () { return addLoc_(req); });
    case 'delLoc':    admin_(user); return withLock_(function () { return delLoc_(req); });
    case 'wipe':      admin_(user); return withLock_(function () { return wipe_(); });
    case 'getSettings':      admin_(user); return { ok: true, settings: getSettingsObj_() };
    case 'setSettings':      admin_(user); return withLock_(function () { return setSettingsObj_(req.settings || {}); });
    case 'testChat':         admin_(user); return { ok: true, sent: notifyChat_('🔔 LOT-IMS 테스트 메시지입니다. Chat 연동이 정상 동작합니다.') };
    case 'testEmail':        admin_(user); return { ok: true, sent: sendDailyDigest_(true) };
    case 'installDailyAlerts': admin_(user); return { ok: true, installed: installDailyAlerts_() };
    case 'addDevLog':    admin_(user); return withLock_(function () { return addDevLog_(user, req); });
    case 'listDevLog':   admin_(user); return { ok: true, logs: listDevLog_(req || {}) };
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
  return { users: users, items: items, locs: locs, hist: hist, histTotal: histAll.length, openIssueCount: openIssues };
}

/* ============ 입·출고 트랜잭션 (품번+리비전 기반) ============ */
/* 단일 처리를 적용(검증·재고 증감·이력) — tx_ 와 bulkTx_ 가 공유.
   itemsTable 을 공유해 같은 배치 안에서 in-memory 재고를 이어서 반영한다.
   재고 식별 = 품번(item_code)+리비전(rev). Items 컬럼: item_code(1)·rev(2)·name(3)·unit(4)·safety_stock(5)·stock(6)·location(7) */
function applyTx_(user, p, itemsTable) {
  var type = p.type, qty = Math.floor(Number(p.qty) || 0);
  if (['IN', 'OUT'].indexOf(type) < 0) throw new Error('잘못된 처리 유형');
  if (qty < 1) throw new Error('수량은 1 이상이어야 합니다');

  var code = String(p.code || '').toUpperCase(), rev = String(p.rev || '').toUpperCase();
  var item = findItem_(itemsTable.rows, code, rev);
  if (!item) throw new Error('등록되지 않은 품번/리비전: ' + (p.code || '') + (rev ? ' (' + rev + ')' : ''));

  var before = Number(item.stock) || 0, after = before, loc = String(item.location || '');
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
  if (itemCode) {
    var item = findItem_(readTable_('Items').rows, itemCode, rev);
    if (!item) throw new Error('등록되지 않은 품번/리비전: ' + p.code);
  }
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
    var itemName = itemCode ? ((findItem_(readTable_('Items').rows, itemCode, rev) || {}).name || itemCode) : '';
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
  // Issues 컬럼: issue_id(1)·item_code(2)·rev(3)·severity(4)·title(5)·description(6)·photo_file_id(7)·status(8)·reported_by(9)·reported_at(10)·updated_by(11)·updated_at(12)·resolution_note(13)
  t.sheet.getRange(row._row, 8).setValue(p.status);                       // status
  t.sheet.getRange(row._row, 11).setValue(user.name);                     // updated_by
  t.sheet.getRange(row._row, 12).setValue(Date.now());                    // updated_at
  t.sheet.getRange(row._row, 13).setValue(p.resolutionNote || row.resolution_note || ''); // resolution_note
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
  t.sheet.deleteRow(item._row);
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
  rebuildReports_();
  return { ok: true, snapshot: snapshot_() };
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
