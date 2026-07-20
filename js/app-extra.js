/* =========================================================
   문서함 (Google Drive 연동)
========================================================= */
function renderDoc(){
  const cur = S._docCode ? skuOf(S._docCode, S._docRev) : '';
  $('#main').innerHTML = `
    <div class="sec-title">📁 문서함 <small>품번+리비전별 사진·문서 보관 (Google Drive)</small></div>
    <div class="searchbar"><input id="docCodeQ" placeholder="품번(리비전) 입력 후 조회 · 예: RP-303-013 (D)" value="${esc(cur)}"><button class="btn btn-ghost" id="docGo">조회</button></div>
    <div id="docBody">${S._docCode?'':'<div class="empty"><b>품번을 입력하세요</b>해당 품번에 첨부된 문서·사진을 확인하고 새로 업로드할 수 있습니다.</div>'}</div>`;
  $('#docGo').onclick = ()=>loadDocSku($('#docCodeQ').value.trim());
  $('#docCodeQ').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); loadDocSku(e.target.value.trim()); }});
  if(S._docCode) loadDocSku(skuOf(S._docCode, S._docRev));
}
async function loadDocSku(input){
  if(!input) return;
  const r0 = resolveScan(input);
  $('#docBody').innerHTML = '<div class="empty">불러오는 중…</div>';
  if(!r0.item){
    if(r0.ambiguous){ $('#docBody').innerHTML = `<div class="empty"><b>리비전이 여러 개입니다</b>리비전까지 포함해 입력하세요 (예: ${esc(r0.code)} (D)).</div>`; return; }
    $('#docBody').innerHTML = `<div class="empty"><b>등록되지 않은 품번입니다</b>품번/리비전을 다시 확인하세요.</div>`; return;
  }
  S._docCode = r0.item.code; S._docRev = r0.item.rev||'';
  try{
    const r = await api('listDocs', { code: r0.item.code, rev: r0.item.rev||'' }, {noApply:true});
    drawDocBody(r0.item, r.docs);
  }catch(e){ toast(e.message,'err'); }
}
function drawDocBody(it, docs){
  $('#docBody').innerHTML = `
    <div class="lot-tag"><div class="lot-no">${esc(skuOf(it.code,it.rev))}</div><div class="lot-meta"><span class="chip chip-move">${esc(groupNameOf(it.code))}</span> ${esc(it.name||it.code)} · 현재고 ${fmt(it.stock)}${esc(it.unit||'')} · 📍${esc(it.location||'위치 미지정')}</div></div>
    <div class="card">
      <b style="font-size:14px">새 문서/사진 업로드</b>
      <div class="field" style="margin-top:10px"><label>분류</label>
        <select id="docCat"><option>검수사진</option><option>거래명세서</option><option>인증서</option><option>기타</option></select></div>
      <label class="upload-drop" id="docDrop">📎 탭하여 사진/파일 선택 (카메라 촬영 가능)
        <input type="file" id="docFile" accept="image/*,.pdf" capture="environment" style="display:none"></label>
      <img id="docPrev" class="thumb-prev hidden">
      <button class="btn btn-primary" id="docUpload" style="width:100%;margin-top:10px" disabled>업로드</button>
    </div>
    <div class="doc-grid" id="docGrid">${docs.length? docs.map(docCard).join('') : '<div class="empty" style="grid-column:1/-1"><b>업로드된 문서가 없습니다</b></div>'}</div>`;
  let pending = null;
  $('#docDrop').onclick = ()=>$('#docFile').click();
  $('#docFile').onchange = async e=>{
    const f = e.target.files[0]; if(!f) return;
    try{
      pending = await fileToPayload(f);
      if(pending.mimeType.startsWith('image/')){ $('#docPrev').src='data:'+pending.mimeType+';base64,'+pending.base64; $('#docPrev').classList.remove('hidden'); }
      else{ $('#docPrev').classList.add('hidden'); }
      $('#docUpload').disabled=false;
    }catch(err){ toast(err.message,'err'); }
  };
  $('#docUpload').onclick = ()=>busy($('#docUpload'), async ()=>{
    if(!pending) return toast('먼저 파일을 선택하세요','err');
    try{
      const r = await api('uploadDoc', Object.assign({ code: it.code, rev: it.rev||'', category: $('#docCat').value }, pending), {noApply:true});
      toast('업로드 완료','ok'); pending=null; $('#docFile').value=''; $('#docPrev').classList.add('hidden'); $('#docUpload').disabled=true;
      $('#docGrid').innerHTML = r.docs.length? r.docs.map(docCard).join('') : '<div class="empty" style="grid-column:1/-1"><b>업로드된 문서가 없습니다</b></div>';
      bindDocCardEvents();
    }catch(e){ toast(e.message,'err'); }
  });
  bindDocCardEvents();
}
function docCard(d){
  return `<div class="doc-card" data-doc="${esc(d.id)}">
    <a href="${d.viewUrl}" target="_blank" rel="noopener"><img src="${d.thumbUrl}" loading="lazy" onerror="this.style.opacity=0.15"></a>
    <div class="dinfo"><div class="dcat">${esc(d.category)}</div><div class="dname">${esc(d.fileName)}</div>
    <div class="dmeta">${esc(d.uploadedBy)} · ${new Date(d.uploadedAt).toLocaleDateString('ko-KR')}</div>
    ${S.me.role==='admin'?`<button class="btn btn-danger btn-sm" style="width:100%;margin-top:5px" data-del-doc="${esc(d.id)}">삭제</button>`:''}
    </div></div>`;
}
function bindDocCardEvents(){
  document.querySelectorAll('[data-del-doc]').forEach(b=>b.onclick=async ()=>{
    if(!confirm('이 문서를 삭제할까요? Drive 원본도 휴지통으로 이동합니다.')) return;
    try{
      const r = await api('delDoc', { id:b.dataset.delDoc }, {noApply:true});
      toast('삭제 완료','ok');
      $('#docGrid').innerHTML = r.docs.length? r.docs.map(docCard).join('') : '<div class="empty" style="grid-column:1/-1"><b>업로드된 문서가 없습니다</b></div>';
      bindDocCardEvents();
    }catch(e){ toast(e.message,'err'); }
  });
}

/* =========================================================
   품질검사 / 이상신고
========================================================= */
function renderIssue(){
  const t = S._issueTab || 'new';
  $('#main').innerHTML = `
    <div class="sec-title">🚨 품질검사 · 이상신고 ${S.openIssueCount?`<small>미해결 ${S.openIssueCount}건</small>`:''}</div>
    <div class="seg" style="margin-bottom:12px">
      <button data-itab="new" class="${t==='new'?'on-move':''}">신규 신고</button>
      <button data-itab="list" class="${t==='list'?'on-move':''}">신고 목록</button>
    </div>
    <div id="issueBody"></div>`;
  document.querySelectorAll('[data-itab]').forEach(b=>b.onclick=()=>{ S._issueTab=b.dataset.itab; renderIssue(); });
  t==='new' ? drawIssueForm() : drawIssueList();
}
function drawIssueForm(){
  S._issueSev = S._issueSev || '경미';
  $('#issueBody').innerHTML = `
    <div class="card">
      <div class="field"><label>품번 (선택 — 품번과 무관한 신고는 비워두세요)</label>
        <div class="row" style="gap:8px;align-items:stretch">
          <input id="isCode" placeholder="예: RP-303-013 (D)" value="${esc(S._isCode?skuOf(S._isCode,S._isRev):'')}" style="text-transform:uppercase;flex:1">
          <button type="button" id="isScanBtn" class="scan-icon-btn" title="바코드 스캔" aria-label="바코드 스캔">${BARCODE_SVG}</button>
        </div></div>
      <div id="isCodeInfo"></div>
      <div class="field"><label>심각도</label>
        <div class="sev-seg">${['경미','중대','긴급'].map(s=>`<button data-sev="${s}" class="sev-${s} ${S._issueSev===s?'on':''}">${s}</button>`).join('')}</div></div>
      <div class="field"><label>제목</label><input id="isTitle" placeholder="예: 포장 파손 발견"></div>
      <div class="field"><label>상세 내용</label><textarea id="isDesc" rows="4" placeholder="발생 상황을 구체적으로 적어주세요" style="width:100%;padding:10px;border:1.5px solid var(--line);border-radius:9px"></textarea></div>
      <label class="upload-drop" id="isDrop">📷 사진 첨부 (선택, 탭하여 촬영/선택)
        <input type="file" id="isFile" accept="image/*" capture="environment" style="display:none"></label>
      <img id="isPrev" class="thumb-prev hidden">
      <button class="btn btn-out" style="width:100%;margin-top:12px" id="isSubmit">신고 접수</button>
    </div>`;
  document.querySelectorAll('[data-sev]').forEach(b=>b.onclick=()=>{ S._issueSev=b.dataset.sev;   // 재렌더 없이 활성 표시만 토글 → 입력한 제목·내용·사진 유지
    document.querySelectorAll('[data-sev]').forEach(x=>x.classList.toggle('on', x.dataset.sev===S._issueSev)); });
  const showCodeInfo = v=>{
    const r0 = v.trim() ? resolveScan(v.trim()) : {item:null,ambiguous:false};
    $('#isCodeInfo').innerHTML = !v.trim() ? '' : r0.item
      ? `<p class="muted" style="margin:-6px 0 10px">${esc(r0.item.name||r0.item.code)} · ${esc(groupNameOf(r0.item.code))} · 현재고 ${fmt(r0.item.stock)}${esc(r0.item.unit||'')}</p>`
      : `<p class="muted" style="margin:-6px 0 10px;color:var(--out)">${r0.ambiguous?'리비전이 여러 개입니다 — 리비전까지 입력하세요':'일치하는 품번을 찾을 수 없습니다'}</p>`;
  };
  $('#isCode').oninput = e=>{ showCodeInfo(e.target.value); };
  $('#isScanBtn').onclick = ()=> openScanModal(txt=>{        // 바코드 촬영 → 품번칸 자동 채움 + 이름 표시
    const p = parseScan(txt), v = skuOf(p.code, p.rev);
    const el = $('#isCode'); if(el){ el.value = v; }
    showCodeInfo(v);
  });
  showCodeInfo(S._isCode?skuOf(S._isCode,S._isRev):'');
  let pending=null;
  $('#isDrop').onclick = ()=>$('#isFile').click();
  $('#isFile').onchange = async e=>{
    const f=e.target.files[0]; if(!f) return;
    try{ pending = await fileToPayload(f); $('#isPrev').src='data:'+pending.mimeType+';base64,'+pending.base64; $('#isPrev').classList.remove('hidden'); }
    catch(err){ toast(err.message,'err'); }
  };
  $('#isSubmit').onclick = ()=>busy($('#isSubmit'), async ()=>{
    const title = $('#isTitle').value.trim();
    if(!title) return toast('제목을 입력하세요','err');
    const codeInput = $('#isCode').value.trim();
    const r0 = codeInput ? resolveScan(codeInput) : {item:null};
    if(codeInput && !r0.item) return toast('일치하는 품번이 없습니다','err');
    try{
      const payload = { code: r0.item?r0.item.code:'', rev: r0.item?(r0.item.rev||''):'', severity:S._issueSev, title, description:$('#isDesc').value.trim() };
      if(pending) Object.assign(payload, pending);
      await api('reportIssue', payload);
      toast('신고가 접수되었습니다','ok');
      S._isCode=''; S._isRev=''; S._issueSev='경미'; S._issueTab='list';
      renderIssue();
    }catch(e){ toast(e.message,'err'); }
  });
}
async function drawIssueList(){
  $('#issueBody').innerHTML = '<div class="empty">불러오는 중…</div>';
  const f = S._issueStatusF || 'ALL';
  try{
    // 신고 목록 + 편집 중 잠금 현황을 병렬로 조회 (왕복 1회로 단축). 잠금 조회는 실패해도 목록은 표시
    const [r, lk] = await Promise.all([
      api('listIssues', { status:f }, {noApply:true}),
      api('listLocks', { prefix:'issue:' }, {noApply:true}).catch(()=>({ locks:[] }))
    ]);
    S._issueLocks = {};
    (lk.locks||[]).forEach(l=>{ S._issueLocks[l.resource]={ id:l.id, name:l.name, ageSec:l.ageSec }; });
    $('#issueBody').innerHTML = `
      <div class="searchbar"><select id="issF" style="flex:1">${['ALL','접수','처리중','완료'].map(s=>`<option value="${s}" ${f===s?'selected':''}>${s==='ALL'?'전체 상태':s}</option>`).join('')}</select></div>
      ${r.issues.length? r.issues.map(issueCard).join('') : '<div class="empty"><b>신고 내역이 없습니다</b></div>'}`;
    $('#issF').onchange = async e=>{ S._issueStatusF = e.target.value; if(LOCK.resource) await lockRelease(); drawIssueList(); };   // 필터 변경 = 편집 중단 → 잠금 해제(방치 방지)
    bindIssueEvents();
  }catch(e){ toast(e.message,'err'); }
}
/* "N초 전 / N분 전" 표기 */
const agoText = sec => sec<60 ? `${sec}초 전` : `${Math.floor(sec/60)}분 전`;
/* 편집 진입 시 잠금 확보 — 다른 사람이 처리 중이면 경고 후 목록을 갱신(잠금 배지 노출)하고 false 반환 */
async function ensureIssueLock(id){
  if(LOCK.resource === 'issue:'+id){ lockTouch(); return true; }   // 이미 내가 편집 중 → 활동 시각만 갱신
  const holder = await lockAcquire('issue:'+id);
  if(holder){ toast(`${holder.name}님이 처리 중입니다 (${agoText(holder.ageSec)})`,'err'); drawIssueList(); return false; }
  return true;
}
function issueCard(i){
  const res = 'issue:'+i.id;
  const lk = (S._issueLocks||{})[res];
  const lockedByOther = lk && lk.id !== S.me.id;
  const baseVersion = i.updatedAt || i.reportedAt || '';     // 버전 충돌 감지용 (updateIssue의 baseVersion과 동일 규칙)
  return `<div class="issue-card" data-issue="${esc(i.id)}">
    <div class="ihead">
      <span class="chip chip-sev-${esc(i.severity)}">${esc(i.severity)}</span>
      <span class="chip chip-st-${esc(i.status)}">${esc(i.status)}</span>
      <span class="ititle">${esc(i.title)}</span>
      ${lockedByOther?`<span class="chip chip-warn" style="margin-left:auto;white-space:nowrap">🔒 ${esc(lk.name)} 처리 중</span>`:''}
    </div>
    ${i.itemCode?`<div class="muted">품번 ${esc(skuOf(i.itemCode,i.rev))} · ${esc(groupNameOf(i.itemCode))} · ${esc(findItem(i.itemCode,i.rev)?.name||itemOf(i.itemCode)?.name||'')}</div>`:''}
    ${i.description?`<div class="idesc">${esc(i.description)}</div>`:''}
    ${i.photoThumb?`<a href="${i.photoView}" target="_blank" rel="noopener"><img src="${i.photoThumb}" loading="lazy"></a>`:''}
    <div class="imeta">신고 ${esc(i.reportedBy)} · ${new Date(i.reportedAt).toLocaleString('ko-KR')}${i.updatedAt?` · 최종수정 ${esc(i.updatedBy)} ${new Date(i.updatedAt).toLocaleDateString('ko-KR')}`:''}</div>
    ${i.resolutionNote?`<div class="muted" style="margin-top:4px">💬 ${esc(i.resolutionNote)}</div>`:''}
    ${i.status!=='완료'? (lockedByOther?`
    <div class="lock-note" style="margin-top:8px;font-size:12.5px;color:var(--out);display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      🔒 <b>${esc(lk.name)}</b>님이 처리 중입니다 (${agoText(lk.ageSec)}). 잠시 후 새로고침하세요.
      ${S.me.role==='admin'?`<button class="btn btn-ghost btn-sm" data-take-issue="${esc(i.id)}">이어받기</button>`:''}
    </div>`:`
    <div class="issue-actions">
      <select data-st-sel="${esc(i.id)}"><option value="접수" ${i.status==='접수'?'selected':''}>접수</option><option value="처리중" ${i.status==='처리중'?'selected':''}>처리중</option><option value="완료">완료</option></select>
      <input type="text" data-note="${esc(i.id)}" placeholder="처리 메모 (선택)" style="flex:1;min-width:110px;padding:8px 10px;border:1.5px solid var(--line);border-radius:8px;font-size:13px">
      <button class="btn btn-primary btn-sm" data-save-issue="${esc(i.id)}" data-ver="${esc(baseVersion)}">저장</button>
    </div>`) :''}
  </div>`;
}
function bindIssueEvents(){
  // 편집을 시작(상태 변경 / 메모 입력)하는 순간 잠금을 확보 → 다른 사람에게 "처리 중" 표시
  document.querySelectorAll('[data-st-sel]').forEach(sel=>sel.addEventListener('change', ()=>ensureIssueLock(sel.dataset.stSel)));
  document.querySelectorAll('[data-note]').forEach(inp=>{
    inp.addEventListener('focus', ()=>ensureIssueLock(inp.dataset.note));
    inp.addEventListener('input', lockTouch);   // 계속 타이핑 중이면 잠금 유지(방치 아님)
  });
  document.querySelectorAll('[data-save-issue]').forEach(b=>b.onclick=()=>busy(b, async ()=>{
    const id = b.dataset.saveIssue;
    if(!(await ensureIssueLock(id))) return;                       // 저장 직전에도 재확인 (경고+차단)
    const status = document.querySelector(`[data-st-sel="${id}"]`).value;
    const note = document.querySelector(`[data-note="${id}"]`).value.trim();
    const baseVersion = b.dataset.ver || '';
    try{
      await api('updateIssue', { id, status, resolutionNote:note, baseVersion });
      toast('업데이트 완료','ok'); await lockRelease(); drawIssueList();
    }catch(e){
      toast(e.message,'err');
      if(/먼저 수정/.test(e.message)){ await lockRelease(); drawIssueList(); }   // 버전 충돌 → 최신 데이터로 갱신
    }
  }));
  // 관리자: 다른 사람이 처리 중인 건을 강제로 이어받기
  document.querySelectorAll('[data-take-issue]').forEach(b=>b.onclick=()=>busy(b, async ()=>{
    const id = b.dataset.takeIssue;
    if(!confirm('다른 사용자가 처리 중입니다. 편집을 이어받을까요?')) return;
    await lockAcquire('issue:'+id, true);
    drawIssueList();
  }));
}

/* =========================================================
   재고 조정·이동 (더보기) — 가끔 쓰는 위치 이동 / 실사 조정 전용 화면.
   품번을 검색·스캔해 선택하면 이동/조정 시트가 열린다(openTxSheet의 MOVE/ADJUST 모드).
========================================================= */
function renderMoveAdjust(){
  const q = (S._maQ||'').toLowerCase();
  let items = S.items.filter(i=>!q || (i.name||'').toLowerCase().includes(q) || i.code.toLowerCase().includes(q) || String(i.rev||'').toLowerCase().includes(q));
  const total = items.length;
  items = items.slice().sort((a,b)=> a.code.localeCompare(b.code) || String(a.rev).localeCompare(String(b.rev))).slice(0,80);
  $('#main').innerHTML = `
    <div class="sec-title">🔧 재고 조정·이동</div>
    <div class="card" style="font-size:12.5px;color:var(--t2);line-height:1.65">
      <b style="color:var(--tx)">이동</b> = 재고 수량은 그대로 두고 <b>보관 위치만</b> 변경 ·
      <b style="color:var(--tx)">조정</b> = 실사 후 시스템 재고를 <b>실물 수량에 맞춤</b>(차이 자동 기록).<br>
      자주 쓰지 않는 작업이라 여기 모아두었습니다. 품번을 검색하거나 바코드로 찾아 선택하세요.
    </div>
    <div class="searchbar"><input id="maQ" placeholder="품명 / 품번 검색" value="${esc(S._maQ||'')}">
      <button class="scan-icon-btn" id="maScan" title="바코드 스캔" aria-label="바코드 스캔">${BARCODE_SVG}</button></div>
    ${items.length?items.map(i=>`
      <button class="ma-row" data-ma="${esc(i.code)}" data-ma-rev="${esc(i.rev||'')}">
        <div class="ma-info"><div class="nm">${esc(i.name||i.code)} ${i.rev?`<span class="chip chip-gray">Rev ${esc(i.rev)}</span>`:''}</div>
          <div class="cd">${esc(skuOf(i.code,i.rev))} · 📍${esc(i.location||'미지정')}</div></div>
        <div class="qty"><b>${fmt(i.stock)}</b> <span>${esc(i.unit||'')}</span></div>
      </button>`).join('') + (total>80?`<div class="muted" style="text-align:center;padding:10px">상위 80개만 표시 · 검색으로 좁혀주세요 (총 ${fmt(total)}개)</div>`:'')
      : `<div class="empty"><b>일치하는 품번이 없습니다</b>검색어를 확인하세요.</div>`}`;
  $('#maQ').oninput = e=>{ S._maQ=e.target.value; renderMoveAdjust(); const v=$('#maQ'); v.focus(); v.setSelectionRange(v.value.length,v.value.length); };
  $('#maScan').onclick = ()=> openScanModal(txt=>{
    const p = parseScan(txt), r = resolveScan(skuOf(p.code,p.rev));
    if(r.item) openTxSheet(r.item.code, r.item.rev||'', ['MOVE','ADJUST']);
    else { S._maQ = p.code; renderMoveAdjust(); toast('해당 품번을 찾지 못해 검색어로 넣었습니다','err'); }
  });
  document.querySelectorAll('[data-ma]').forEach(b=>b.onclick=()=>openTxSheet(b.dataset.ma, b.dataset.maRev||'', ['MOVE','ADJUST']));
}

/* =========================================================
   리포트 · 대시보드 (인앱 차트 + Looker Studio 연동 안내)
========================================================= */
function renderReport(){
  $('#main').innerHTML = '<div class="sec-title">📊 리포트 · 대시보드</div><div class="empty">데이터를 불러오는 중…</div>';
  loadReport();
}
async function loadReport(){
  try{ const r = await api('reportData', {}, {noApply:true}); drawReport(r.report); }
  catch(e){ toast(e.message,'err'); $('#main').innerHTML = `<div class="empty"><b>리포트를 불러오지 못했습니다</b>${esc(e.message)}</div>`; }
}
function drawReport(rep){
  const top = rep.stockByItem.slice(0,8);
  const maxQty = Math.max(1, ...top.map(t=>t.qty), 1);
  const maxTrend = Math.max(1, ...rep.trend.map(d=>Math.max(d.in,d.out)), 1);
  const gb = rep.groupBreakdown || [];
  const maxGroupQty = Math.max(1, ...gb.map(g=>g.qty), 1);
  $('#main').innerHTML = `
    <div class="sec-title">📊 리포트 · 대시보드</div>
    <div class="hero-banner">
      <h3>재고 현황 요약</h3>
      <div class="hero-sub">${today()} 기준 · 구글시트 실시간 동기화</div>
      <div class="hero-stats">
        <div class="hero-stat"><b>${fmt(rep.totalItems)}</b><span>등록 품번</span></div>
        <div class="hero-stat"><b>${fmt(rep.totalStock)}</b><span>총 재고수량</span></div>
        <div class="hero-stat"><b>${fmt(rep.lowStockCount)}</b><span>안전재고 미달${rep.lowStockCount?' ⚠':''}</span></div>
        <div class="hero-stat"><b>${fmt(rep.openIssueCount)}</b><span>미해결 신고${rep.openIssueCount?' ⚠':''}</span></div>
      </div>
    </div>
    <div class="chart-card">
      <h4>제품군별 재고</h4>
      ${gb.length ? gb.map(g=>`
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12.5px">
          <div style="width:118px;flex:none;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g.name)} <span class="muted" style="font-family:var(--mono);font-weight:400">${esc(g.group)}</span></div>
          <div style="flex:1;background:var(--s3);border-radius:5px;overflow:hidden;height:16px">
            <div style="width:${Math.max(3,g.qty/maxGroupQty*100)}%;height:100%;background:var(--ac);border-radius:5px"></div>
          </div>
          <div style="width:120px;text-align:right;font-variant-numeric:tabular-nums">${fmt(g.qty)} <span class="muted">· 품번 ${g.items}${g.low?` · <span style="color:var(--out)">미달 ${g.low}</span>`:''}</span></div>
        </div>`).join('') : '<div class="muted">데이터 없음</div>'}
    </div>
    <div class="chart-card">
      <h4>품번별 재고 (상위 ${top.length}개)</h4>
      ${top.length ? top.map(t=>`
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12.5px">
          <div style="width:96px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}${t.rev?` <span class="muted">(${esc(t.rev)})</span>`:''}</div>
          <div style="flex:1;background:var(--s3);border-radius:5px;overflow:hidden;height:16px">
            <div style="width:${Math.max(3,t.qty/maxQty*100)}%;height:100%;background:${t.safetyStock>0&&t.qty<t.safetyStock?'var(--out)':'var(--ac)'};border-radius:5px"></div>
          </div>
          <div style="width:56px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums">${fmt(t.qty)}${esc(t.unit)}</div>
        </div>`).join('') : '<div class="muted">데이터 없음</div>'}
    </div>
    <div class="chart-card">
      <h4>최근 14일 입·출고 추이</h4>
      ${trendChart(rep.trend, maxTrend)}
      <div style="display:flex;gap:14px;margin-top:8px;font-size:11.5px;color:var(--t2)"><span>🟩 입고</span><span>🟥 출고</span></div>
    </div>
    ${bomSummaryCard()}
    <div class="looker-card">
      📈 <b>더 깊은 분석이 필요하신가요?</b><br>
      연결된 구글 시트에는 품명·창고 등이 미리 조인된 <b>Report_Stock</b> / <b>Report_Tx</b> 탭과
      조립 구조 <b>Report_BOM</b> 탭이 자동으로 최신 상태로 유지됩니다. <a href="https://lookerstudio.google.com" target="_blank" rel="noopener">Looker Studio</a>
      에서 구글 시트 커넥터로 연결하면 기간별 추이·재고 회전율·창고별 비교 같은 대시보드를 만들 수 있고,
      <b>Report_BOM</b>의 child_code를 <b>Report_Stock</b>에 조인하면 구성품 실시간 재고까지 함께 볼 수 있습니다.
    </div>`;
}
/* 조립 구조(BOM) 요약 카드 — S.bom 기반 (조립가능 상위 몇 개) */
function bomSummaryCard(){
  const parents = {};
  S.bom.forEach(e=>{ const k=bomKey(e.parentCode,e.parentRev); (parents[k]=parents[k]||{code:e.parentCode,rev:e.parentRev||''}); });
  const list = Object.values(parents);
  if(!list.length) return '';
  const rows = list.map(p=>({ p, buildable:buildableOf(p.code,p.rev)||0, name:findItem(p.code,p.rev)?.name||'' }))
                   .sort((a,b)=>b.buildable-a.buildable).slice(0,8);
  return `<div class="chart-card">
    <h4>조립 구조(BOM) · 조립품 ${list.length} · 구성 ${S.bom.length}</h4>
    ${rows.map(r=>`<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:12.5px">
      <div style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span style="font-family:var(--mono)">${esc(skuOf(r.p.code,r.p.rev))}</span> <span class="muted">${esc(r.name)}</span></div>
      <span class="chip ${r.buildable>0?'chip-in':'chip-out'}">조립가능 ${fmt(r.buildable)}</span>
    </div>`).join('')}
  </div>`;
}
function trendChart(trend, maxV){
  return `<div style="display:flex;align-items:flex-end;gap:2px;height:112px">
    ${trend.map(d=>{
      const hIn = Math.round(d.in/maxV*90), hOut = Math.round(d.out/maxV*90);
      return `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;gap:2px" title="${esc(d.date)} · 입고 ${d.in} · 출고 ${d.out}">
        <div style="display:flex;gap:1px;align-items:flex-end;height:90px">
          <div style="width:5px;height:${hIn}px;background:var(--in);border-radius:2px 2px 0 0"></div>
          <div style="width:5px;height:${hOut}px;background:var(--out);border-radius:2px 2px 0 0"></div>
        </div>
        <div style="font-size:8px;color:var(--t3)">${esc(d.date.slice(5))}</div>
      </div>`;
    }).join('')}
  </div>`;
}

/* =========================================================
   관리 › 알림 설정 (Google Chat 실시간 + Gmail 일일 다이제스트)
========================================================= */
function admNotify(){
  $('#admBody').innerHTML = '<div class="empty">불러오는 중…</div>';
  loadNotifySettings();
}
async function loadNotifySettings(){
  try{ const r = await api('getSettings', {}, {noApply:true}); drawNotify(r.settings); }
  catch(e){ toast(e.message,'err'); }
}
function drawNotify(s){
  $('#admBody').innerHTML = `
    <div class="card">
      <b style="font-size:14px">💬 Google Chat 실시간 알림</b>
      <p class="muted" style="margin:6px 0 10px">Chat 스페이스의 웹훅 URL을 입력하면, 안전재고 미달 발생이나 중대·긴급 품질신고 접수 시 즉시 채팅으로 알립니다.</p>
      <div class="field"><label>Webhook URL</label><input id="ntChat" value="${esc(s.chatWebhookUrl)}" placeholder="https://chat.googleapis.com/v1/spaces/…"></div>
      <div class="row"><button class="btn btn-ghost" id="ntChatTest">테스트 발송</button><button class="btn btn-primary" id="ntChatSave">저장</button></div>
    </div>
    <div class="card">
      <b style="font-size:14px">📧 Gmail 일일 다이제스트</b>
      <p class="muted" style="margin:6px 0 10px">매일 지정 시각에 안전재고 미달·미해결 신고 요약을 이메일로 발송합니다.</p>
      <div class="field"><label>수신 이메일 (쉼표로 구분)</label><input id="ntEmails" value="${esc(s.alertEmails)}" placeholder="a@company.com, b@company.com"></div>
      <div class="field"><label>발송 시각 (0~23시)</label><input id="ntHour" type="number" min="0" max="23" value="${esc(s.alertHour)}"></div>
      <div class="row"><button class="btn btn-ghost" id="ntEmailTest">지금 테스트 발송</button><button class="btn btn-primary" id="ntSave">저장</button></div>
      <button class="btn btn-ghost" style="width:100%;margin-top:8px" id="ntInstall">⏰ 일일 알림 자동 발송 설치</button>
      <p class="muted" style="margin-top:6px">설치 후 매일 지정 시각에 자동 실행됩니다. 시각을 바꾼 뒤에는 다시 설치를 눌러 갱신하세요.</p>
    </div>
    <div class="card">
      <b style="font-size:14px">🔗 AppSheet 품번 동기화 토큰</b>
      <p class="muted" style="margin:6px 0 10px">부품 품번 관리 시스템(AppSheet)이 품번을 이 앱으로 보낼 때 쓰는 <b>공유 토큰</b>입니다. AppSheet 봇의 웹훅 Body <span style="font-family:var(--mono)">token</span> 값과 동일하게 맞추세요.</p>
      <div class="field"><label>Sync Token</label><input id="ntSyncToken" value="${esc(s.syncToken||'')}" placeholder="임의의 비밀 문자열 (예: a8Kd…)"></div>
      <button class="btn btn-primary" id="ntSyncSave">토큰 저장</button>
    </div>
    <div class="card">
      <b style="font-size:14px">🗂️ 문서/사진 저장 폴더</b>
      <p class="muted" style="margin:6px 0 10px">업로드된 문서와 이상신고 사진은 구글 드라이브 전용 폴더에 저장됩니다.</p>
      ${s.driveFolderId?`<a class="btn btn-ghost" href="https://drive.google.com/drive/folders/${esc(s.driveFolderId)}" target="_blank" rel="noopener">Drive 폴더 열기</a>`:'<span class="muted">Apps Script에서 setup()을 먼저 실행하세요</span>'}
    </div>`;
  $('#ntChatSave').onclick = ()=>busy($('#ntChatSave'), async ()=>{
    try{ await api('setSettings', { settings:{ chatWebhookUrl:$('#ntChat').value.trim() } }, {noApply:true}); toast('저장 완료','ok'); }
    catch(e){ toast(e.message,'err'); }
  });
  $('#ntChatTest').onclick = ()=>busy($('#ntChatTest'), async ()=>{
    try{ const r=await api('testChat', {}, {noApply:true}); toast(r.sent?'Chat으로 테스트 메시지를 보냈습니다':'전송 실패 — Webhook URL을 확인하세요', r.sent?'ok':'err'); }
    catch(e){ toast(e.message,'err'); }
  });
  $('#ntSave').onclick = ()=>busy($('#ntSave'), async ()=>{
    try{ await api('setSettings', { settings:{ alertEmails:$('#ntEmails').value.trim(), alertHour:$('#ntHour').value } }, {noApply:true}); toast('저장 완료','ok'); }
    catch(e){ toast(e.message,'err'); }
  });
  $('#ntSyncSave').onclick = ()=>busy($('#ntSyncSave'), async ()=>{
    try{ await api('setSettings', { settings:{ syncToken:$('#ntSyncToken').value.trim() } }, {noApply:true}); toast('동기화 토큰 저장 완료','ok'); }
    catch(e){ toast(e.message,'err'); }
  });
  $('#ntEmailTest').onclick = ()=>busy($('#ntEmailTest'), async ()=>{
    try{ const r=await api('testEmail', {}, {noApply:true}); toast(r.sent?'테스트 이메일을 보냈습니다':'수신 이메일 미설정 — Chat으로만 전송했습니다','ok'); }
    catch(e){ toast(e.message,'err'); }
  });
  $('#ntInstall').onclick = ()=>busy($('#ntInstall'), async ()=>{
    try{ await api('installDailyAlerts', {}, {noApply:true}); toast('일일 알림이 설치되었습니다','ok'); }
    catch(e){ toast(e.message,'err'); }
  });
}

/* =========================================================
   개선요청 · 오류신고 (더보기) — 사용자가 앱 수정요청/오류를 접수하는 채널.
   접수는 모든 사용자, 해결 처리·삭제는 관리자. (백엔드 DevLog 시트/액션 재사용)
========================================================= */
const FEEDBACK_META = {
  '수정요청':{ ic:'🛠️', chip:'chip-move' },
  '오류':    { ic:'🐛', chip:'chip-out' },
};
function renderFeedback(){
  $('#main').innerHTML = `<div class="sec-title">🛠️ 개선요청 · 오류신고</div><div id="fbBody"><div class="empty">불러오는 중…</div></div>`;
  loadFeedback();
}
async function loadFeedback(){
  const f = S._fbF || 'ALL';
  try{ const r = await api('listDevLog', { category:f }, {noApply:true}); drawFeedback(r.logs); }
  catch(e){ toast(e.message,'err'); }
}
function drawFeedback(logs){
  const f = S._fbF || 'ALL';
  $('#fbBody').innerHTML = `
    <div class="card">
      <b style="font-size:14px">✍️ 새 요청·신고</b>
      <p class="muted" style="margin:6px 0 10px">앱을 쓰다 고쳤으면 하는 점(수정요청)이나 오류를 남겨주세요. 관리자가 확인해 반영합니다. 오류 코드가 떴다면 함께 적어주시면 좋아요.</p>
      <div class="row">
        <div class="field"><label>유형</label><select id="fbCat">${Object.keys(FEEDBACK_META).map(c=>`<option>${c}</option>`).join('')}</select></div>
        <div class="field" style="flex:2"><label>제목</label><input id="fbTitle" placeholder="예: 출고 사유를 필수로 / 스캔이 가끔 멈춰요 [E9000]"></div>
      </div>
      <div class="field"><label>내용 (선택)</label><textarea id="fbContent" rows="3" placeholder="어떤 상황인지, 어떤 화면인지 적어주시면 반영에 도움이 됩니다" style="width:100%;padding:10px;border:1.5px solid var(--line);border-radius:9px"></textarea></div>
      <button class="btn btn-primary" id="fbAdd" style="width:100%">보내기</button>
    </div>
    <div class="searchbar"><select id="fbFilter" style="flex:1">${['ALL',...Object.keys(FEEDBACK_META)].map(c=>`<option value="${c}" ${f===c?'selected':''}>${c==='ALL'?'전체':c}</option>`).join('')}</select></div>
    <div id="fbList">${logs.length? logs.map(feedbackCard).join('') : '<div class="empty"><b>접수된 요청·신고가 없습니다</b>불편한 점이나 오류를 남겨주세요.</div>'}</div>`;
  $('#fbFilter').onchange = e=>{ S._fbF = e.target.value; loadFeedback(); };
  $('#fbAdd').onclick = ()=>busy($('#fbAdd'), async ()=>{
    const title = $('#fbTitle').value.trim();
    if(!title) return toast('제목을 입력하세요','err');
    try{
      const r = await api('addDevLog', { category:$('#fbCat').value, title, content:$('#fbContent').value.trim() }, {noApply:true});
      toast('접수되었습니다. 감사합니다!','ok');
      $('#fbTitle').value=''; $('#fbContent').value='';
      renderFeedbackList(r.logs);
    }catch(e){ toast(e.message,'err'); }
  });
  bindFeedbackEvents();
}
function renderFeedbackList(logs){
  $('#fbList').innerHTML = logs.length? logs.map(feedbackCard).join('') : '<div class="empty"><b>접수된 요청·신고가 없습니다</b></div>';
  bindFeedbackEvents();
}
function feedbackCard(l){
  const m = FEEDBACK_META[l.category] || { ic:'📝', chip:'chip-gray' };
  const isAdmin = S.me.role==='admin';
  const resolve = isAdmin
    ? `<label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--t2);margin-left:auto;white-space:nowrap">
         <input type="checkbox" data-fbdone="${esc(l.id)}" ${l.done?'checked':''}> 해결됨</label>`
    : (l.done?`<span class="chip chip-in" style="margin-left:auto">해결됨</span>`:'');
  return `<div class="issue-card" style="${l.done?'opacity:.6':''}">
    <div class="ihead">
      <span class="chip ${m.chip}">${m.ic} ${esc(l.category)}</span>
      <span class="ititle" style="${l.done?'text-decoration:line-through':''}">${esc(l.title)}</span>
      ${resolve}
    </div>
    ${l.content?`<div class="idesc">${esc(l.content).replace(/\n/g,'<br>')}</div>`:''}
    <div class="imeta">${esc(l.author)} · ${new Date(l.ts).toLocaleString('ko-KR')}
      ${isAdmin?`<button class="btn btn-danger btn-sm" style="margin-left:8px" data-fbdel="${esc(l.id)}">삭제</button>`:''}
    </div>
  </div>`;
}
function bindFeedbackEvents(){
  document.querySelectorAll('[data-fbdone]').forEach(cb=>cb.onchange=async ()=>{
    try{ const r = await api('updateDevLog', { id:cb.dataset.fbdone, done:cb.checked }, {noApply:true}); renderFeedbackList(r.logs); }
    catch(e){ toast(e.message,'err'); }
  });
  document.querySelectorAll('[data-fbdel]').forEach(b=>b.onclick=async ()=>{
    if(!confirm('이 항목을 삭제할까요?')) return;
    try{ const r = await api('delDevLog', { id:b.dataset.fbdel }, {noApply:true}); toast('삭제 완료','ok'); renderFeedbackList(r.logs); }
    catch(e){ toast(e.message,'err'); }
  });
}
