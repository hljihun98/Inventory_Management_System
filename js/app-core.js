/* =========================================================
   LOT-IMS 프론트엔드 (GitHub Pages 호스팅용)
   백엔드: Google Apps Script 웹앱 → Google Sheets
========================================================= */
'use strict';

/* ▼▼▼ 배포 시 이 값을 본인의 Apps Script 웹앱 URL로 바꾸면
       로그인 화면에서 주소 입력 없이 바로 사용할 수 있습니다. ▼▼▼ */
const DEFAULT_API_URL = 'https://script.google.com/macros/s/AKfycbynbfljY52UlLbB_DnIfj90iD-sHyphkiL9QoY5VHsdwZnlCbngF5ZtP4L6VgGKtTse/exec';
/* 예: const DEFAULT_API_URL = 'https://script.google.com/macros/s/AKfycb.../exec'; */

/* ---------- 전역 상태 ---------- */
const S = {
  api:'', auth:null, me:null,
  users:[], items:[], locs:[], hist:[], histTotal:0, openIssueCount:0, bom:[],
  tab:'scan',
  scanTarget:null, scanMode:'IN',
  scanner:null, scanning:false,
  lastScan:{code:'',at:0},
  histFilter:'ALL',
};

const $ = s => document.querySelector(s);
const esc = s => String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => Number(n||0).toLocaleString('ko-KR');
const today = () => new Date().toISOString().slice(0,10);

/* ---------- 품번 / 리비전 / 제품군 헬퍼 ----------
   식별 단위 = 품번(code) + 리비전(rev). 바코드 = "품번 (리비전)" 예) RP-303-013 (D)
   품번 = 제품군코드(RP)-블록코드(303)-시리얼(013). 제품군은 앞자리에서 도출. */
const GROUP_NAMES = { RP:'PARKIE', RD:'DD-DRIVING', RG:'GOALIE', RZ:'COMMON PARTS', RQ:'QD-DRIVING', RS:'STANLEY' };
const GROUP_ORDER = ['RP','RD','RG','RZ','RQ','RS'];
const groupCodeOf = code => String(code||'').split('-')[0].toUpperCase();
const groupNameOf = code => GROUP_NAMES[groupCodeOf(code)] || '기타';
const skuOf = (code, rev) => rev ? `${code} (${rev})` : String(code||'');
/* 스캔/입력 문자열을 품번+리비전으로 분해. "RP-303-013 (D)" → {code:'RP-303-013', rev:'D'} */
function parseScan(raw){
  const s = String(raw??'').trim();
  const m = s.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if(m) return { code: m[1].trim().toUpperCase(), rev: m[2].trim().toUpperCase() };
  return { code: s.toUpperCase(), rev: '' };
}
/* 스캔 문자열을 실제 품목으로 해석. 리비전 있으면 정확 매칭; 없으면 해당 품번이 유일할 때만 반환 */
function resolveScan(raw){
  const { code, rev } = parseScan(raw);
  if(rev) return { item: findItem(code, rev), code, rev, ambiguous:false };
  const cands = S.items.filter(i=>i.code===code);
  if(cands.length===1) return { item: cands[0], code, rev: cands[0].rev||'', ambiguous:false };
  return { item: null, code, rev:'', ambiguous: cands.length>1 };
}

function toast(msg, kind=''){
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(()=>el.remove(), 3000);
}
async function sha256(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function remember(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
function recall(k){ try{ return localStorage.getItem(k)||''; }catch(e){ return ''; } }

/* 사진/문서를 서버 업로드용 payload로 변환 — 이미지는 최대 1280px, JPEG 72%로 압축해 전송량을 줄임 */
async function fileToPayload(file){
  const isImage = file.type.startsWith('image/');
  const dataUrl = await new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(file); });
  if(!isImage){
    if(file.size > 8*1024*1024) throw new Error('파일이 너무 큽니다 (8MB 이하만 첨부 가능)');
    return { base64: dataUrl.split(',')[1], mimeType: file.type||'application/octet-stream', fileName: file.name };
  }
  const img = await new Promise((res,rej)=>{ const im=new Image(); im.onload=()=>res(im); im.onerror=rej; im.src=dataUrl; });
  const maxDim = 1280;
  let w = img.width, h = img.height;
  if(w>maxDim || h>maxDim){ const scale = maxDim/Math.max(w,h); w=Math.round(w*scale); h=Math.round(h*scale); }
  const cv = document.createElement('canvas'); cv.width=w; cv.height=h;
  cv.getContext('2d').drawImage(img,0,0,w,h);
  const outUrl = cv.toDataURL('image/jpeg', 0.72);
  return { base64: outUrl.split(',')[1], mimeType:'image/jpeg', fileName: file.name.replace(/\.[^.]+$/, '') + '.jpg' };
}

/* ---------- API 클라이언트 ----------
   Content-Type: text/plain 으로 전송해 CORS preflight 를 피함 (Apps Script 표준 패턴) */
async function api(action, payload={}, opt={}){
  if(!S.api) throw new Error('서버 주소가 설정되지 않았습니다');
  const body = JSON.stringify(Object.assign({ action, auth:S.auth }, payload));
  let res;
  try{
    res = await fetch(S.api, { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body });
  }catch(e){ throw new Error('서버에 연결할 수 없습니다. 주소와 네트워크를 확인하세요'); }
  let json;
  try{ json = await res.json(); }
  catch(e){ throw new Error('서버 응답 오류 — Apps Script 배포 설정(액세스: 모든 사용자)을 확인하세요'); }
  if(!json.ok) throw new Error(json.error || '요청 실패');
  if(json.snapshot && !opt.noApply) applySnapshot(json.snapshot);
  return json;
}
function applySnapshot(d){
  S.users = d.users||[]; S.items = d.items||[];
  S.locs = d.locs||[]; S.hist = d.hist||[]; S.histTotal = d.histTotal ?? (d.hist||[]).length;
  S.openIssueCount = d.openIssueCount ?? S.openIssueCount ?? 0;
  S.bom = d.bom||[];
}
async function loadAll(){ try{ await api('all'); S.loaded=true; }catch(e){ toast(e.message,'err'); } }

/* 버튼 로딩 상태 헬퍼 */
async function busy(btn, fn){
  if(!btn || btn.disabled) return;
  const t = btn.textContent; btn.disabled = true; btn.textContent = '처리 중…';
  try{ await fn(); } finally{ if(document.body.contains(btn)){ btn.disabled=false; btn.textContent=t; } }
}

/* ---------- 편집 중 소프트 락 (수정 충돌 방지) ----------
   한 번에 하나의 레코드만 편집한다는 가정. 편집 진입 시 lockAcquire, 저장/취소/탭이동/로그아웃 시 lockRelease.
   TTL(서버 3분)이 있어 브라우저를 그냥 닫아도 잠금은 자동 해제된다. */
const LOCK = { resource:null, timer:null, lastActive:0 };
const LOCK_IDLE_MS = 120000;   // 이 시간 이상 사용자 조작이 없으면 하트비트 중단 → 서버 TTL(3분)로 자동 해제
/* 잠금 획득 시도 → 성공하면 null, 다른 사람이 점유 중이면 보유자 정보 반환.
   force=true 이면 강제로 이어받는다(관리자만 · 서버에서도 재검증). */
async function lockAcquire(resource, force){
  const r = await api('acquireLock', { resource, force:!!force }, {noApply:true});
  if(!r.acquired) return r.holder;                       // 다른 사람이 편집 중
  if(LOCK.resource && LOCK.resource!==resource) await lockRelease();   // 이전 잠금 정리
  LOCK.resource = resource; LOCK.lastActive = Date.now();
  clearInterval(LOCK.timer);
  LOCK.timer = setInterval(async ()=>{
    if(Date.now() - LOCK.lastActive > LOCK_IDLE_MS){ lockRelease(); return; }   // 방치된 편집 → 잠금 놓아줌
    try{
      const rr = await api('renewLock', { resource }, {noApply:true});          // 있을 때만 갱신(재생성 안 함)
      if(!rr.renewed){ clearInterval(LOCK.timer); LOCK.timer=null; LOCK.resource=null; }  // 만료/이어받기됨
    }catch(e){}
  }, 60000);
  return null;
}
async function lockRelease(){
  if(!LOCK.resource) return;
  const resource = LOCK.resource;
  LOCK.resource = null; clearInterval(LOCK.timer); LOCK.timer = null;
  try{ await api('releaseLock', { resource }, {noApply:true}); }catch(e){}
}
/* 사용자가 편집을 이어가는 중임을 표시 (하트비트가 계속 갱신하도록 활동 시각 갱신) */
function lockTouch(){ if(LOCK.resource) LOCK.lastActive = Date.now(); }

/* ---------- 조회 헬퍼 (품번+리비전 기반) ---------- */
const itemOf = code => S.items.find(i=>i.code===code);                          // 품번으로 첫 항목(느슨한 조회·표시용)
const findItem = (code, rev) => S.items.find(i=>i.code===code && String(i.rev||'')===String(rev||''));  // 정확 매칭
const locOf  = code => S.locs.find(l=>l.code===code);
function itemQty(code, rev){ return Number(findItem(code,rev)?.stock||0); }      // 재고는 (품번+리비전) 행에 직접 저장
function lowStockItems(){ return S.items.filter(i=>i.safetyStock>0 && Number(i.stock||0) < i.safetyStock); }

/* ---------- BOM / 조립(assy) 헬퍼 (백엔드와 동일 규칙) ----------
   assy = BOM에 자식이 있는 품번(플래그 없음). 식별키 = 품번|리비전(대문자). */
const bomKey = (c,r) => `${String(c||'').toUpperCase()}|${String(r||'').toUpperCase()}`;
function bomChildrenOf(code, rev){
  const k = bomKey(code,rev);
  return S.bom.filter(e=>bomKey(e.parentCode,e.parentRev)===k).slice().sort((a,b)=>(a.seq||0)-(b.seq||0));
}
function bomParentsOf(code, rev){
  const k = bomKey(code,rev);
  return S.bom.filter(e=>bomKey(e.childCode,e.childRev)===k);
}
const isAssy = (code, rev) => S.bom.some(e=>bomKey(e.parentCode,e.parentRev)===bomKey(code,rev));
/* 조립 가능 수량 = min over children floor(자식재고/소요량). 자식 없으면 null. */
function buildableOf(code, rev){
  const kids = bomChildrenOf(code,rev);
  if(!kids.length) return null;
  return kids.reduce((min,e)=>{
    const have = itemQty(e.childCode, e.childRev), per = Number(e.qtyPer)||0;
    return Math.min(min, per>0 ? Math.floor(have/per) : 0);
  }, Infinity);
}

/* ---------- 로그인 ---------- */
async function doLogin(){
  const url = $('#apiUrl').value.trim();
  const id = $('#loginId').value.trim(), pw = $('#loginPw').value;
  if(!url) return toast('Apps Script 웹앱 URL을 입력하세요','err');
  if(!id || !pw) return toast('아이디와 비밀번호를 입력하세요','err');
  await busy($('#loginBtn'), async ()=>{
    try{
      S.api = url;
      const pwHash = await sha256(pw);
      const r = await api('login', { id, pwHash }); // auth 없이 id/pwHash 직접 전달
      S.auth = { id, pwHash };
      S.me = r.user;
      remember('ims_api', url); remember('ims_id', id);
      $('#loginView').classList.add('hidden');
      $('#appView').classList.remove('hidden');
      $('#whoName').textContent = S.me.name;
      $('#whoRole').textContent = S.me.role==='admin' ? '관리자' : '작업자';
      $('#whoAvatar').textContent = (S.me.name||'?').trim().slice(0,1).toUpperCase();
      buildTabs(); go('scan');
    }catch(e){ toast(e.message,'err'); }
  });
}
function doLogout(){
  stopScan();
  lockRelease();
  S.me = null; S.auth = null; S.loaded = false;
  $('#appView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
  $('#loginPw').value='';
}

/* ---------- 탭/라우팅 ---------- */
const TABS = [
  { id:'scan',  ic:'📷', label:'스캔' },
  { id:'inv',   ic:'📦', label:'재고' },
  { id:'loc',   ic:'🗺️', label:'위치' },
  { id:'hist',  ic:'🧾', label:'이력' },
];
const MORE_TABS = ['bulkio','doc','issue','report'];
const MORE_META = {
  bulkio: { ic:'📥', label:'일괄 입출고', desc:'여러 로트를 표로 한 번에 입·출고 (붙여넣기 지원)' },
  doc:    { ic:'📁', label:'문서함',     desc:'로트별 사진·문서 보관 (Google Drive)' },
  issue:  { ic:'🚨', label:'품질신고',   desc:'이상 신고 접수 및 처리 현황' },
  report: { ic:'📊', label:'리포트',     desc:'재고 통계 · 대시보드 · Looker Studio' },
};
function buildTabs(){
  const moreActive = MORE_TABS.includes(S.tab);
  let html = TABS.map(t=>`<button data-tab="${t.id}" class="${S.tab===t.id?'on':''}"><span class="ic">${t.ic}</span>${t.label}</button>`).join('');
  html += `<button id="moreBtn" class="${moreActive?'on':''}"><span class="ic">⋯</span>더보기${S.openIssueCount?`<span class="badge">${S.openIssueCount>9?'9+':S.openIssueCount}</span>`:''}</button>`;
  if(S.me.role==='admin') html += `<button data-tab="admin" class="${S.tab==='admin'?'on':''}"><span class="ic">⚙️</span>관리</button>`;
  $('#tabs').innerHTML = html;
  $('#tabs').querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>go(b.dataset.tab));
  $('#moreBtn').onclick = openMoreSheet;
}
function openMoreSheet(){
  openModal(`<h3>더 많은 기능</h3><div class="more-sheet">
    ${MORE_TABS.map(id=>{
      const m = MORE_META[id];
      const cnt = id==='issue' && S.openIssueCount ? `<span class="cnt">${S.openIssueCount}</span>` : '';
      return `<button class="more-item" data-more="${id}"><span class="ic">${m.ic}</span><span class="tx"><b>${m.label}</b><span>${m.desc}</span></span>${cnt}</button>`;
    }).join('')}
  </div>`);
  document.querySelectorAll('[data-more]').forEach(b=>b.onclick=()=>{ closeModal(); go(b.dataset.more); });
}
async function go(tab){
  if(S.tab==='scan' && tab!=='scan') stopScan();
  if(LOCK.resource) lockRelease();          // 다른 탭으로 이동하면 편집 잠금 해제
  S.tab = tab; buildTabs();
  if(!S.loaded){                          // 시트 전체 로드는 최초 1회만 (이후엔 메모리 상태로 즉시 렌더)
    $('#main').innerHTML = '<div class="empty">시트에서 데이터를 불러오는 중…</div>';
    await loadAll();
    buildTabs();                           // openIssueCount 갱신 반영
  }
  renderCurrent();
}
/* 현재 탭을 메모리 상태(S)로 렌더 — 시트 재조회 없음 */
function renderCurrent(){
  renderAlerts();
  ({scan:renderScan, inv:renderInv, loc:renderLoc, hist:renderHist, admin:renderAdmin,
    bulkio:renderBulkIO, doc:renderDoc, issue:renderIssue, report:renderReport})[S.tab]?.();
}
/* 수동 새로고침 — 다른 사용자가 시트를 바꿨을 때 최신 데이터로 동기화 */
async function refreshNow(){
  await busy($('#refreshBtn'), async ()=>{ await loadAll(); buildTabs(); renderCurrent(); });
  toast('최신 데이터로 새로고침','ok');
}
function renderAlerts(){
  const low = lowStockItems();
  const bar = $('#alertBar');
  if(!low.length){ bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.innerHTML = `⚠️ <div><b>안전재고 미달 ${low.length}건</b> — ` +
    low.slice(0,3).map(i=>`${esc(i.name)} ${fmt(itemQty(i.code))}/${fmt(i.safetyStock)}${esc(i.unit)}`).join(', ') +
    (low.length>3?` 외 ${low.length-3}건`:'') + `</div>`;
}

/* ---------- 모달 (더보기 시트 등에서 사용) ---------- */
function openModal(html){ $('#modalBox').innerHTML = html; $('#overlay').classList.remove('hidden'); }
function closeModal(){ $('#overlay').classList.add('hidden'); $('#modalBox').innerHTML=''; if(S._lockModal){ S._lockModal=false; lockRelease(); } }   // 편집 모달을 닫으면 잠금 해제 (바깥 클릭 포함)
document.addEventListener('click', e=>{ if(e.target.id==='overlay') closeModal(); });

/* =========================================================
   재고 현황
========================================================= */
const grpOrd = g => { const i = GROUP_ORDER.indexOf(g); return i<0?99:i; };
function renderInv(){
  const q = (S._invQ||'').toLowerCase();
  const gf = S._invGroup || '';
  S._invCollapsed = S._invCollapsed || new Set();

  // 제품군 통계(칩용 · 검색과 무관하게 전체 기준)
  const stat = {};
  S.items.forEach(i=>{ const g=groupCodeOf(i.code); const s=stat[g]||(stat[g]={n:0,low:0}); s.n++; if(i.safetyStock>0&&Number(i.stock||0)<i.safetyStock) s.low++; });
  const statKeys = Object.keys(stat).sort((a,b)=>grpOrd(a)-grpOrd(b));
  const chip = (val,label,n,low)=>`<button class="grp-chip ${gf===val?'on':''}" data-grp="${esc(val)}">${esc(label)}<span class="grp-n">${n}</span>${low?`<span class="grp-low">${low}</span>`:''}</button>`;
  const chips = `<div class="grp-chips">${chip('','전체',S.items.length,lowStockItems().length)}${statKeys.map(g=>chip(g,GROUP_NAMES[g]||g,stat[g].n,stat[g].low)).join('')}</div>`;

  // 검색 + 제품군 필터
  let items = S.items.filter(i=>!q || (i.name||'').toLowerCase().includes(q) || i.code.toLowerCase().includes(q) || String(i.rev||'').toLowerCase().includes(q));
  if(gf) items = items.filter(i=>groupCodeOf(i.code)===gf);

  // 제품군별 그룹 섹션
  const groups = {};
  items.forEach(i=>{ const g=groupCodeOf(i.code); (groups[g]=groups[g]||[]).push(i); });
  const showKeys = Object.keys(groups).sort((a,b)=>grpOrd(a)-grpOrd(b));
  const sections = showKeys.length ? showKeys.map(g=>{
    const arr = groups[g].slice().sort((a,b)=> a.code.localeCompare(b.code) || String(a.rev).localeCompare(String(b.rev)));
    const lowN = arr.filter(i=>i.safetyStock>0 && Number(i.stock||0)<i.safetyStock).length;
    const collapsed = S._invCollapsed.has(g);
    return `<div class="grp-sec">
      <button class="grp-head" data-gtoggle="${esc(g)}">
        <span class="grp-title">${esc(GROUP_NAMES[g]||g)} <span class="muted" style="font-family:var(--mono);font-weight:400">${esc(g)}</span></span>
        <span class="grp-meta">${lowN?`<span class="chip chip-warn">미달 ${lowN}</span>`:''}<span class="chip chip-gray">품번 ${arr.length}</span><span class="grp-caret">${collapsed?'▸':'▾'}</span></span>
      </button>
      ${collapsed?'':`<div class="grp-body">${arr.map(invCard).join('')}</div>`}
    </div>`;
  }).join('') : `<div class="empty"><b>표시할 품번이 없습니다</b>${S.items.length?'검색·필터를 조정하세요.':'AppSheet 동기화 또는 관리 탭에서 품번을 등록하세요.'}</div>`;

  $('#main').innerHTML = `
    <div class="sec-title">📦 재고 현황 <small>품번 ${S.items.length} · 구글시트 실시간</small></div>
    <div class="searchbar"><input id="invQ" placeholder="품명 / 품번 / 리비전 검색" value="${esc(S._invQ||'')}"></div>
    ${chips}
    ${sections}`;
  $('#invQ').oninput = e=>{ S._invQ = e.target.value; renderInv(); const v=$('#invQ'); v.focus(); v.setSelectionRange(v.value.length,v.value.length); };
  document.querySelectorAll('[data-grp]').forEach(b=>b.onclick=()=>{ S._invGroup=b.dataset.grp; renderInv(); });
  document.querySelectorAll('[data-gtoggle]').forEach(b=>b.onclick=()=>{ const g=b.dataset.gtoggle; S._invCollapsed.has(g)?S._invCollapsed.delete(g):S._invCollapsed.add(g); renderInv(); });
  document.querySelectorAll('[data-assy]').forEach(el=>el.onclick=()=>openAssyDetail(el.dataset.assy, el.dataset.assyRev||''));   // 조립품 카드 → 상세/조립
}
function invCard(it){
  const qty = Number(it.stock||0);
  const low = it.safetyStock>0 && qty < it.safetyStock;
  const pct = it.safetyStock>0 ? Math.min(100, qty/it.safetyStock*100) : 100;
  const assy = isAssy(it.code, it.rev);
  const buildable = assy ? buildableOf(it.code, it.rev) : null;
  return `<div class="item-card">
    <div class="item-head" ${assy?`data-assy="${esc(it.code)}" data-assy-rev="${esc(it.rev||'')}" style="cursor:pointer"`:'style="cursor:default"'}>
      <div><div class="nm">${esc(it.name||it.code)} ${it.rev?`<span class="chip chip-gray">Rev ${esc(it.rev)}</span>`:''} ${assy?'<span class="chip chip-move">🔧 조립품</span>':''} ${low?'<span class="chip chip-warn">안전재고 미달</span>':''}</div>
        <div class="cd">${esc(skuOf(it.code,it.rev))} · 안전재고 ${fmt(it.safetyStock)}${esc(it.unit)}${it.location?' · 📍'+esc(it.location):''}${assy?` · 조립가능 ${fmt(buildable)}${esc(it.unit)}`:''}</div></div>
      <div class="qty"><b>${fmt(qty)}</b> <span>${esc(it.unit)}</span></div>
    </div>
    ${it.safetyStock>0?`<div style="padding:0 14px 12px"><div class="bar-safety ${low?'low':''}"><i style="width:${pct}%"></i></div></div>`:''}
  </div>`;
}

/* =========================================================
   재고 위치
========================================================= */
function renderLoc(){
  const q = (S._locQ||'').trim().toLowerCase();
  let hit = null;
  if(q) hit = S.items.filter(i=>i.code.toLowerCase().includes(q) || (i.name||'').toLowerCase().includes(q) || String(i.rev||'').toLowerCase().includes(q));
  const groups = {};
  S.locs.forEach(lc=>groups[lc.code]=[]);
  S.items.filter(i=>Number(i.stock)>0).forEach(i=>{
    const k = i.location||'(미지정)';
    (groups[k] = groups[k]||[]).push(i);
  });
  $('#main').innerHTML = `
    <div class="sec-title">🗺️ 재고 위치 <small>창고/구역/랙</small></div>
    <div class="searchbar"><input id="locQ" placeholder="품번/품명으로 위치 찾기" value="${esc(S._locQ||'')}"></div>
    ${hit ? (hit.length ? hit.map(i=>`
        <div class="lot-tag"><div class="lot-no">${esc(skuOf(i.code,i.rev))}</div>
        <div class="lot-meta">📍 <b>${esc(i.location||'위치 미지정')}</b> · 재고 ${fmt(i.stock)}${esc(i.unit||'')} · ${esc(i.name||'')} · ${esc(groupNameOf(i.code))}</div></div>`).join('')
      : `<div class="empty"><b>일치하는 품번이 없습니다</b>품번/품명을 다시 확인하세요.</div>`) : ''}
    ${Object.entries(groups).map(([code,items])=>{
      const lc = locOf(code);
      return `<div class="card">
        <div style="display:flex;align-items:center;gap:8px">
          <b style="font-family:var(--mono)">${esc(code)}</b>
          <span class="muted">${lc?esc(lc.warehouse+' · '+lc.zone+' · '+lc.rack):code==='(미지정)'?'위치 미지정':'등록되지 않은 위치'}</span>
          <span class="chip chip-gray" style="margin-left:auto">품번 ${items.length}</span>
        </div>
        ${items.length?items.map(i=>`<div class="lot-line"><span class="ln">${esc(skuOf(i.code,i.rev))}</span>
          <span class="muted">${esc(i.name||i.code)}</span>
          <span class="q">${fmt(i.stock)}${esc(i.unit||'')}</span></div>`).join('')
        :'<div class="muted" style="margin-top:6px">보관 중인 품번 없음</div>'}
      </div>`;
    }).join('')}`;
  $('#locQ').oninput = e=>{ S._locQ = e.target.value; renderLoc(); const v=$('#locQ'); v.focus(); v.setSelectionRange(v.value.length,v.value.length); };
}

/* =========================================================
   이력
========================================================= */
const TYPE_KO = { IN:'입고', OUT:'출고', MOVE:'이동', CREATE:'생성', BUILD:'조립', CONSUME:'조립소요', UNBUILD:'분해', RESTORE:'분해복원' };
const HIST_POS = ['IN','BUILD','RESTORE'];   // + 부호(재고 증가)
const HIST_NEG = ['OUT','CONSUME','UNBUILD']; // − 부호(재고 감소)
const histHasBA = t => HIST_POS.includes(t) || HIST_NEG.includes(t);           // before→after 있는 유형
const histChipCls = t => HIST_POS.includes(t)?'in':HIST_NEG.includes(t)?'out':t==='MOVE'?'move':'gray';
function renderHist(){
  const f = S.histFilter;
  const q = (S._histQ||'').toLowerCase();
  const rows = S.hist
    .filter(h=>f==='ALL'||h.type===f)
    .filter(h=>!q || (h.itemCode||'').toLowerCase().includes(q) || String(h.rev||'').toLowerCase().includes(q) || (findItem(h.itemCode,h.rev)?.name||itemOf(h.itemCode)?.name||'').toLowerCase().includes(q) || (h.user||'').toLowerCase().includes(q))
    .slice().reverse();
  $('#main').innerHTML = `
    <div class="sec-title">🧾 입·출고 이력 <small>전수 ${fmt(S.histTotal)}건 (최근 500건 표시 · 전체는 구글시트 History 탭)</small></div>
    <div class="searchbar"><input id="histQ" placeholder="품번/품명/담당자 검색" value="${esc(S._histQ||'')}">
      <select id="histF">${['ALL','IN','OUT','BUILD','CONSUME','UNBUILD','RESTORE'].map(t=>`<option value="${t}" ${f===t?'selected':''}>${t==='ALL'?'전체':TYPE_KO[t]}</option>`).join('')}</select></div>
    <div class="card">${rows.length?rows.map(h=>`
      <div class="hist-line">
        <div class="when">${new Date(h.ts).toLocaleDateString('ko-KR',{month:'2-digit',day:'2-digit'})}<br>${new Date(h.ts).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})}</div>
        <div class="what">
          <span class="chip chip-${histChipCls(h.type)}">${TYPE_KO[h.type]||h.type}</span>
          <span class="ln">${esc(skuOf(h.itemCode,h.rev))}</span>
          <div class="muted">${esc(findItem(h.itemCode,h.rev)?.name||itemOf(h.itemCode)?.name||'')} · ${esc(h.user)} ${h.location?'· 📍'+esc(h.location):''} ${h.reason?'· '+esc(h.reason):''}
          ${histHasBA(h.type)?` · 재고 ${fmt(h.before)}→${fmt(h.after)}`:''}</div>
        </div>
        ${HIST_POS.includes(h.type)?`<div class="q in">+${fmt(h.qty)}</div>`:HIST_NEG.includes(h.type)?`<div class="q out">−${fmt(h.qty)}</div>`:''}
      </div>`).join(''):'<div class="empty"><b>이력이 없습니다</b>입·출고를 처리하면 여기에 기록됩니다.</div>'}
    </div>`;
  $('#histF').onchange = e=>{ S.histFilter = e.target.value; renderHist(); };
  $('#histQ').oninput = e=>{ S._histQ = e.target.value; renderHist(); const v=$('#histQ'); v.focus(); v.setSelectionRange(v.value.length,v.value.length); };
}
