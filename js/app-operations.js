/* =========================================================
   바코드(품번) 발행·각인은 이 앱 범위 밖 — 부품 품번 관리 시스템(AppSheet)이 담당하고,
   파트박스는 열전사 10x8 감열지, 개별 부품은 잉크젯 마킹기로 처리한다.
   이 앱은 발행된 품번 바코드를 "스캔"해 입·출고를 기록하는 데 집중한다.
========================================================= */
/* 사진 확대 라이트박스 (이상신고/문서함 등에서 공용 사용) */
function openLightbox(src){
  let lb = document.getElementById('lbx');
  if(!lb){
    lb = document.createElement('div'); lb.id='lbx'; lb.className='lbx';
    lb.innerHTML = '<button class="lbx-c" aria-label="닫기">✕</button><img alt="확대 이미지">';
    lb.onclick = ()=>lb.classList.remove('open');
    document.body.appendChild(lb);
  }
  lb.querySelector('img').src = src;
  lb.classList.add('open');
}

/* =========================================================
   스캔 입·출고
========================================================= */
function renderScan(){
  $('#main').innerHTML = `
    <div class="sec-title">📷 스캔 입·출고</div>
    <div class="card">
      <div id="reader"></div>
      <div class="row" style="margin-top:10px">
        <button class="btn btn-primary" id="scanToggle">카메라 스캔 시작</button>
      </div>
      <div class="field" style="margin-top:12px"><label>수동 입력 (카메라/리더기 미사용 시)</label>
        <div class="row"><input id="manualCode" placeholder="부품 품번 입력 또는 리더기로 스캔" style="flex:2;padding:11px 12px;border:1.5px solid var(--line);border-radius:9px">
        <button class="btn btn-ghost" id="manualGo">조회</button></div>
        <p class="muted" style="margin-top:6px">USB/블루투스 바코드 리더기는 이 입력칸에 초점을 두고 부품 품번 바코드를 스캔하면 됩니다.</p>
      </div>
    </div>
    <div id="scanPanel"></div>`;
  $('#scanToggle').onclick = ()=> S.scanning ? stopScan(true) : startScan();
  $('#manualGo').onclick = ()=>{ const v=$('#manualCode').value.trim(); if(v) onCode(v,true); };
  $('#manualCode').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); const v=e.target.value.trim(); if(v) onCode(v,true); e.target.select(); }});
  if(S.scanTarget) drawScanPanel();
}
async function startScan(){
  try{
    S.scanner = new Html5Qrcode('reader');
    await S.scanner.start({ facingMode:'environment' }, { fps:10, qrbox:{width:230,height:230} },
      txt=>onCode(txt,false), ()=>{});
    S.scanning = true;
    $('#scanToggle').textContent='카메라 스캔 중지';
    $('#scanToggle').classList.replace('btn-primary','btn-danger');
  }catch(e){
    toast('카메라를 열 수 없습니다. HTTPS 접속 여부와 카메라 권한을 확인하거나 수동 입력을 사용하세요','err');
  }
}
async function stopScan(rerender){
  if(S.scanner && S.scanning){ try{ await S.scanner.stop(); S.scanner.clear(); }catch(e){} }
  S.scanning=false; S.scanner=null;
  if(rerender && S.tab==='scan' && $('#scanToggle')){ $('#scanToggle').textContent='카메라 스캔 시작'; $('#scanToggle').classList.replace('btn-danger','btn-primary'); }
}
async function onCode(raw, manual){
  const now = Date.now();                       // 중복 스캔 방지 (2.5초)
  if(!manual && raw===S.lastScan.code && now-S.lastScan.at<2500) return;
  S.lastScan = { code: raw, at:now };
  let r = resolveScan(raw);
  if(!r.item && !r.ambiguous){ await loadAll(); r = resolveScan(raw); }   // 없으면 시트 재조회
  if(r.item){
    if(navigator.vibrate) navigator.vibrate(30);
    S.scanTarget = { code:r.item.code, rev:r.item.rev||'' }; S.scanMode='IN';
    S._inStatus='정상'; S._inIssue=''; S._inMakeIssue=undefined;   // 새 스캔마다 품질 이상 여부 초기화
    S._inPhotos=[]; S._inReason='';                                 // 인증사진·사유 초기화
    drawScanPanel();
    return;
  }
  if(navigator.vibrate) navigator.vibrate(80);
  if(r.ambiguous){   // 품번은 있으나 리비전 여러 개 — 리비전 포함해 스캔/입력 유도
    return toast(`품번 ${r.code} 은 리비전이 여러 개입니다. 리비전까지 포함해 스캔하세요 (예: ${r.code} (D))`,'err');
  }
  // ── 미등록 품번 복구 플로우 ──
  const p = parseScan(raw);
  if(S.me.role==='admin'){                                   // 관리자면 품번 등록 유도 (평시엔 AppSheet 동기화로 유입)
    if(confirm(`등록되지 않은 품번: ${skuOf(p.code,p.rev)}\n관리 화면에서 이 품번을 새로 등록할까요?`)){
      S._prefillNewItemCode = p.code; S._prefillNewItemRev = p.rev; S._admTab='items'; go('admin');
    }
  }else{
    toast(`등록되지 않은 품번: ${skuOf(p.code,p.rev)} — 관리자에게 품번 등록을 요청하세요`,'err');
  }
}
function drawScanPanel(){
  const tgt = S.scanTarget || {};
  const it = findItem(tgt.code, tgt.rev);
  if(!it){ $('#scanPanel').innerHTML=''; return; }
  const st = S._inStatus || '정상';   // 입고 품질 이상 여부 (ROBOSTOCK 입출고 모티브)
  $('#scanPanel').innerHTML = `
    <div class="lot-tag scan-hit">
      <div class="lot-no">${esc(skuOf(it.code,it.rev))}</div>
      <div class="lot-meta"><span class="chip chip-move">${esc(groupNameOf(it.code))}</span> ${esc(it.name||it.code)} · 현재고 <b>${fmt(it.stock)}${esc(it.unit||'')}</b> · 📍${esc(it.location||'위치 미지정')}${it.safetyStock>0?` · 안전재고 ${fmt(it.safetyStock)}${esc(it.unit||'')}`:''}</div>
    </div>
    <div class="row" style="margin-bottom:10px">
      <button class="btn btn-ghost btn-sm" id="goDocBtn">📁 문서/사진</button>
      <button class="btn btn-ghost btn-sm" id="goIssueBtn">🚨 이상신고</button>
    </div>
    <div class="card">
      <div class="seg" style="margin-bottom:12px">
        <button id="mIn"  class="${S.scanMode==='IN'?'on-in':''}">입고</button>
        <button id="mOut" class="${S.scanMode==='OUT'?'on-out':''}">출고</button>
      </div>
      <div class="field"><label>수량</label>
        <div class="big-qty"><button id="qMinus">−</button><input id="qVal" type="number" min="1" value="1" inputmode="numeric"><button id="qPlus">+</button></div></div>
      ${S.scanMode==='IN'?`
        <div class="field"><label>보관 위치 (선택)</label>
          <select id="qLoc"><option value="">- 미지정 -</option>${S.locs.map(l=>`<option value="${esc(l.code)}" ${it.location===l.code?'selected':''}>${esc(l.code)} · ${esc(l.warehouse)} ${esc(l.zone)} ${esc(l.rack)}</option>`).join('')}</select></div>`:''}
      <div class="field"><label>사유 (선택)</label><input id="qReason" value="${esc(S._inReason||'')}" placeholder="${S.scanMode==='IN'?'예: 정기 입고, 반품 입고':'예: 생산 투입, 판매 출고'}"></div>
      ${S.scanMode==='IN'?`
        <div class="field"><label>품질 이상 여부</label>
          <div class="seg" id="qStatusSeg">
            <button type="button" data-st="정상" class="${st==='정상'?'on-in':''}">✅ 정상</button>
            <button type="button" data-st="확인필요" class="${st==='확인필요'?'on-warn':''}">⚠️ 확인필요</button>
            <button type="button" data-st="이상" class="${st==='이상'?'on-out':''}">❌ 이상</button>
          </div></div>
        ${st!=='정상'?`
          <div class="field"><label>이상 내용</label>
            <textarea id="qIssue" placeholder="이상 내용을 상세히 기술하세요 (품질신고에 함께 등록됩니다)" style="min-height:56px">${esc(S._inIssue||'')}</textarea></div>
          <label class="muted" style="display:flex;align-items:center;gap:7px;margin:-4px 0 10px;cursor:pointer">
            <input type="checkbox" id="qMakeIssue" ${S._inMakeIssue!==false?'checked':''} style="width:auto;flex:none">
            이 입고 건을 품질신고로 자동 등록 <span class="chip chip-sev-${st==='이상'?'긴급':'경미'}">${st==='이상'?'긴급':'경미'}</span></label>`:''}
        <div class="field"><label>입고 인증사진 <span class="lbl-hint">(최대 6장 · 처리 시 문서함 저장)</span></label>
          <div class="pg" id="inPhotos">
            ${(S._inPhotos||[]).map((p,i)=>`<div class="pw"><img src="data:${p.mimeType};base64,${p.base64}" data-lbx="${i}"><button type="button" class="pd" data-rmph="${i}">✕</button></div>`).join('')}
            ${(S._inPhotos||[]).length<6?`<label class="pa"><span style="font-size:20px">📷</span><span>추가</span><input type="file" id="inPhotoFile" accept="image/*" capture="environment" multiple hidden></label>`:''}
          </div></div>
      `:''}
      <button class="btn ${S.scanMode==='IN'?'btn-in':'btn-out'}" style="width:100%" id="qGo">
        ${S.scanMode==='IN'?'입고 처리':'출고 처리'}</button>
    </div>`;
  ['In','Out'].forEach(m=>{ $('#m'+m).onclick=()=>{ S.scanMode=m.toUpperCase(); drawScanPanel(); }; });
  $('#goDocBtn').onclick = ()=>{ S._docCode = it.code; S._docRev = it.rev||''; go('doc'); };
  $('#goIssueBtn').onclick = ()=>{ S._isCode = it.code; S._isRev = it.rev||''; S._issueTab = 'new'; go('issue'); };
  $('#qMinus').onclick=()=>{ const i=$('#qVal'); i.value=Math.max(1,Number(i.value)-1); };
  $('#qPlus').onclick =()=>{ const i=$('#qVal'); i.value=Number(i.value)+1; };
  const qr=$('#qReason'); if(qr) qr.oninput=()=>{ S._inReason=qr.value; };   // 재렌더에도 사유 보존
  if(S.scanMode==='IN'){
    document.querySelectorAll('#qStatusSeg [data-st]').forEach(b=>b.onclick=()=>{
      S._inStatus = b.dataset.st; drawScanPanel();          // 상태 전환 → 이상 내용/체크박스 노출 갱신
    });
    const qi=$('#qIssue'); if(qi) qi.oninput=()=>{ S._inIssue=qi.value; };   // 재렌더에도 내용 보존
    const mk=$('#qMakeIssue'); if(mk) mk.onchange=()=>{ S._inMakeIssue=mk.checked; };
    // 입고 인증사진 추가/삭제/확대 (ROBOSTOCK addPh 모티브)
    const pf=$('#inPhotoFile');
    if(pf) pf.onchange = async e=>{
      const room = 6 - (S._inPhotos||[]).length;
      const files = Array.from(e.target.files||[]).slice(0, Math.max(0,room));
      for(const f of files){ try{ (S._inPhotos=S._inPhotos||[]).push(await fileToPayload(f)); }catch(err){ toast(err.message,'err'); } }
      e.target.value=''; drawScanPanel();
    };
    document.querySelectorAll('#inPhotos [data-rmph]').forEach(b=>b.onclick=()=>{ S._inPhotos.splice(Number(b.dataset.rmph),1); drawScanPanel(); });
    document.querySelectorAll('#inPhotos [data-lbx]').forEach(im=>im.onclick=()=>openLightbox(im.src));
  }
  $('#qGo').onclick = ()=>busy($('#qGo'), ()=>processTx(it.code, it.rev||''));
}
async function processTx(code, rev){
  const mode = S.scanMode;
  const qty = Math.floor(Number($('#qVal').value)||0);
  const loc = mode==='IN' ? $('#qLoc').value : '';
  let reason = $('#qReason').value.trim();
  if(qty<1) return toast('수량은 1 이상이어야 합니다','err');

  // ── 입고 품질 이상 여부 (ROBOSTOCK 입출고 모티브) ──
  let status='정상', issue='', makeIssue=false;
  if(mode==='IN'){
    status = S._inStatus || '정상';
    if(status!=='정상'){
      issue = ($('#qIssue')?.value || S._inIssue || '').trim();
      if(!issue) return toast('이상 내용을 입력하세요','err');
      makeIssue = $('#qMakeIssue') ? $('#qMakeIssue').checked : true;
      if(!confirm(`품질 이상 여부: "${status}"\n${issue}\n\n이대로 입고 처리할까요?`)) return;
      reason = [reason, `[${status}] ${issue}`].filter(Boolean).join(' | ');  // History.reason 컬럼 재사용
    }
  }
  try{
    // 재고 검증·증감·이력 기록은 서버(Apps Script)에서 잠금 후 단일 처리
    const r = await api('tx', { type:mode, code, rev, qty, loc, reason });
    // 이상 입고 → 품질신고(Issues) 시스템에 자동 등록 (품번+리비전 기준)
    if(mode==='IN' && status!=='정상' && makeIssue){
      const it = findItem(code, rev);
      const sev = status==='이상' ? '긴급' : '경미';
      try{
        await api('reportIssue', { code, rev, severity:sev,
          title:`입고 시 ${status} — ${it?.name || skuOf(code,rev)}`, description:issue });
        buildTabs();   // 미해결 신고 배지 갱신
      }catch(e){ toast('입고는 완료됐지만 품질신고 등록 실패: '+e.message,'err'); }
    }
    // 입고 인증사진 → 문서함(Drive) 저장 (품번+리비전 단위)
    if(mode==='IN' && (S._inPhotos||[]).length){
      let done=0;
      for(const p of S._inPhotos){
        try{ await api('uploadDoc', { code, rev, category:'입고검수', base64:p.base64, fileName:p.fileName, mimeType:p.mimeType }, {noApply:true}); done++; }
        catch(e){ toast('사진 업로드 실패: '+e.message,'err'); }
      }
      if(done) toast(`인증사진 ${done}장 문서함 저장`,'ok');
    }
    const stTag = status!=='정상' ? ` ⚠️${status}` : '';
    toast(mode==='IN'?`입고 +${fmt(qty)} 완료 (현재고 ${fmt(r.after)})${stTag}`:`출고 −${fmt(qty)} 완료 (현재고 ${fmt(r.after)})`,'ok');
    S._inStatus='정상'; S._inIssue=''; S._inMakeIssue=undefined; S._inPhotos=[]; S._inReason='';   // 상태 초기화
    renderAlerts(); drawScanPanel();
  }catch(e){ toast(e.message,'err'); }
}

/* =========================================================
   일괄 입·출고 (ROBOSTOCK 인라인 표 + 붙여넣기 모티브)
========================================================= */
const blankBulkRow = ()=>({type:'IN',code:'',rev:'',qty:'',reason:''});
function renderBulkIO(){
  if(!Array.isArray(S._bulkRows) || !S._bulkRows.length) S._bulkRows = [blankBulkRow(),blankBulkRow(),blankBulkRow()];
  $('#main').innerHTML = `
    <div class="sec-title">📥 일괄 입·출고 <small>여러 품번을 한 번에 처리</small></div>
    <div class="card">
      <p class="muted" style="margin-bottom:12px">표에 직접 입력하거나, 엑셀/구글시트에서 <b>구분·품번·리비전·수량·사유</b> 열을 복사해 품번 칸에 붙여넣으면 여러 행이 자동으로 채워집니다. 품번 칸에 <b style="font-family:var(--mono)">RP-303-013 (D)</b> 처럼 넣으면 리비전이 자동 분리됩니다. (구분 생략 시 입고)</p>
      <div style="overflow-x:auto">
        <table class="table bulk-table">
          <thead><tr><th style="width:70px">구분</th><th>품번</th><th style="width:62px">리비전</th><th style="width:76px">수량</th><th>사유</th><th style="width:30px"></th></tr></thead>
          <tbody id="bulkBody">${S._bulkRows.map(bulkRowHtml).join('')}</tbody>
        </table>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn btn-ghost" id="bulkAddRow">＋ 행 추가</button>
        <button class="btn btn-ghost" id="bulkClear">전체 지우기</button>
      </div>
      <button class="btn btn-primary" id="bulkSubmit" style="width:100%;margin-top:10px">일괄 처리 실행</button>
    </div>
    <div id="bulkResult"></div>`;
  bindBulkEvents();
}
function bulkCodeInfo(code, rev){
  const v = String(code||'').trim();
  if(!v) return '';
  const it = findItem(String(code).toUpperCase(), String(rev||'').toUpperCase()) || (String(rev||'')===''? itemOf(String(code).toUpperCase()) : null);
  return it
    ? `<span class="muted" style="font-size:11px">${esc(it.name||it.code)} · ${esc(groupNameOf(it.code))} · 현재고 ${fmt(it.stock)}${esc(it.unit||'')}</span>`
    : `<span style="font-size:11px;color:var(--out)">⚠️ 미등록 품번/리비전</span>`;
}
function bulkRowHtml(r,i){
  const cell = 'padding:6px 8px;border:1.5px solid var(--bd);border-radius:7px;background:var(--sf)';
  return `<tr data-brow="${i}">
    <td><select data-bf="type" style="width:100%;${cell}">
      <option value="IN" ${r.type==='IN'?'selected':''}>입고</option>
      <option value="OUT" ${r.type==='OUT'?'selected':''}>출고</option></select></td>
    <td><input data-bf="code" value="${esc(r.code)}" placeholder="품번" style="width:100%;font-family:var(--mono);${cell}">
      <div class="brow-info">${bulkCodeInfo(r.code, r.rev)}</div></td>
    <td><input data-bf="rev" value="${esc(r.rev)}" placeholder="Rev" style="width:100%;text-transform:uppercase;text-align:center;font-family:var(--mono);${cell}"></td>
    <td><input data-bf="qty" value="${esc(r.qty)}" type="number" min="1" inputmode="numeric" style="width:100%;text-align:right;${cell}"></td>
    <td><input data-bf="reason" value="${esc(r.reason)}" placeholder="선택" style="width:100%;${cell}"></td>
    <td style="text-align:center"><button data-bdel="${i}" title="행 삭제" style="color:var(--t3);font-size:15px">✕</button></td>
  </tr>`;
}
function bindBulkEvents(){
  document.querySelectorAll('#bulkBody [data-bf]').forEach(el=>{
    const tr = el.closest('[data-brow]'), i = Number(tr.dataset.brow), f = el.dataset.bf;
    el.addEventListener(el.tagName==='SELECT'?'change':'input', ()=>{
      S._bulkRows[i][f] = el.value;                                  // 재렌더 없이 상태만 갱신 (포커스 보존)
      if(f==='code'){
        // 품번 칸에 "RP-303-013 (D)" 형태를 넣으면 리비전 자동 분리
        if(/\(.+\)/.test(el.value)){ const ps=parseScan(el.value); S._bulkRows[i].code=ps.code; S._bulkRows[i].rev=ps.rev; renderBulkIO(); return; }
        tr.querySelector('.brow-info').innerHTML = bulkCodeInfo(el.value, S._bulkRows[i].rev);
      }
      if(f==='rev') tr.querySelector('.brow-info').innerHTML = bulkCodeInfo(S._bulkRows[i].code, el.value);
    });
  });
  document.querySelectorAll('#bulkBody input[data-bf="code"]').forEach(el=>{
    el.addEventListener('paste', e=>{
      const text = (e.clipboardData||window.clipboardData).getData('text');
      if(!/[\t\n]/.test(text)) return;                               // 단일 값이면 기본 붙여넣기
      e.preventDefault();
      pasteBulk(text, Number(el.closest('[data-brow]').dataset.brow));
    });
  });
  document.querySelectorAll('#bulkBody [data-bdel]').forEach(b=>b.onclick=()=>{
    S._bulkRows.splice(Number(b.dataset.bdel),1);
    if(!S._bulkRows.length) S._bulkRows=[blankBulkRow()];
    renderBulkIO();
  });
  $('#bulkAddRow').onclick = ()=>{ S._bulkRows.push(blankBulkRow()); renderBulkIO(); };
  $('#bulkClear').onclick  = ()=>{ S._bulkRows=[blankBulkRow(),blankBulkRow(),blankBulkRow()]; renderBulkIO(); };
  $('#bulkSubmit').onclick = ()=>busy($('#bulkSubmit'), submitBulkIO);
}
function pasteBulk(text, startRow){
  const lines = text.replace(/\r/g,'').split('\n').filter(l=>l.trim()!=='');
  const isRev = s => /^[A-Za-z]{1,3}$/.test(String(s||'').trim());   // 리비전은 짧은 알파벳
  const parsed = lines.map(line=>{
    let cols = line.split('\t').map(c=>c.trim());
    let type='IN';
    const c0 = cols[0], up = (c0||'').toUpperCase();
    if(['입고','출고'].includes(c0) || ['IN','OUT'].includes(up)){ type=(c0==='출고'||up==='OUT')?'OUT':'IN'; cols=cols.slice(1); }
    let code=cols[0]||'', rev='', rest;
    const ps=parseScan(code);
    if(ps.rev){ code=ps.code; rev=ps.rev; rest=cols.slice(1); }        // 품번 칸에 "(D)" 포함
    else if(isRev(cols[1])){ rev=cols[1]; rest=cols.slice(2); }        // 두 번째 열이 리비전
    else { rest=cols.slice(1); }                                       // 리비전 열 없음
    return { type, code, rev, qty: rest[0]||'', reason: rest[1]||'' };
  });
  const before = S._bulkRows.slice(0,startRow), after = S._bulkRows.slice(startRow+parsed.length);
  S._bulkRows = before.concat(parsed, after);
  renderBulkIO();
}
async function submitBulkIO(){
  const submitted = S._bulkRows.map(r=>{
    let code=String(r.code||'').trim().toUpperCase(), rev=String(r.rev||'').trim().toUpperCase();
    if(/\(.+\)/.test(code)){ const ps=parseScan(code); code=ps.code; if(ps.rev) rev=ps.rev; }   // "(D)" 자동 분리
    return { type:r.type, code, rev, qty:Math.floor(Number(r.qty)||0), reason:String(r.reason||'').trim() };
  }).filter(r=>r.code!=='' || r.qty>0);                               // 완전히 빈 행은 제외
  if(!submitted.length) return toast('처리할 행을 입력하세요','err');
  const bad = submitted.find(r=>!r.code || r.qty<1);
  if(bad) return toast('모든 행에 품번과 1 이상의 수량을 입력하세요','err');
  try{
    const r = await api('bulkTx', { rows: submitted });
    drawBulkResult(r.results, submitted);
    renderAlerts(); buildTabs();
    const okN = r.results.filter(x=>x.ok).length, failN = r.results.length-okN;
    toast(`성공 ${okN}건${failN?` · 실패 ${failN}건`:''}`, failN?'err':'ok');
  }catch(e){ toast(e.message,'err'); }
}
function drawBulkResult(results, submitted){
  $('#bulkResult').innerHTML = `
    <div class="card">
      <b style="font-size:14px">처리 결과</b>
      <div style="overflow-x:auto"><table class="table" style="margin-top:8px">
        <thead><tr><th>품번</th><th style="width:56px">구분</th><th>결과</th></tr></thead><tbody>
        ${results.map(x=>{ const s=submitted[x.idx]||{};
          return `<tr><td style="font-family:var(--mono)">${esc(skuOf(s.code||x.code||'', s.rev||x.rev||''))}</td>
            <td>${s.type==='OUT'?'출고':'입고'}</td>
            <td>${x.ok?`<span class="chip chip-in">✓ 완료 · 재고 ${fmt(x.after)}</span>`:`<span class="chip chip-out">✕ ${esc(x.error||'실패')}</span>`}</td></tr>`;
        }).join('')}
      </tbody></table></div>
    </div>`;
  // 실패한 행만 표에 남겨 재시도를 돕는다
  const failed = results.filter(x=>!x.ok).map(x=>{ const s=submitted[x.idx]||{}; return {type:s.type||'IN',code:s.code||'',rev:s.rev||'',qty:String(s.qty||''),reason:s.reason||''}; });
  S._bulkRows = failed.length ? failed : [blankBulkRow(),blankBulkRow(),blankBulkRow()];
  $('#bulkBody').innerHTML = S._bulkRows.map(bulkRowHtml).join('');
  bindBulkEvents();
}

/* =========================================================
   관리자
========================================================= */
function renderAdmin(){
  if(S.me.role!=='admin'){ $('#main').innerHTML='<div class="empty">권한이 없습니다.</div>'; return; }
  const t = S._admTab || 'users';
  const seg = (id,label)=>`<button data-adm="${id}" class="${t===id?'on-move':''}">${label}</button>`;
  $('#main').innerHTML = `
    <div class="sec-title">⚙️ 관리</div>
    <div class="seg seg-compact" style="margin-bottom:12px">${seg('users','사용자')}${seg('items','품번')}${seg('locs','위치')}${seg('notify','알림')}${seg('devlog','메모')}${seg('data','데이터')}</div>
    <div id="admBody"></div>`;
  document.querySelectorAll('[data-adm]').forEach(b=>b.onclick=()=>{ S._admTab=b.dataset.adm; renderAdmin(); });
  ({users:admUsers, items:admItems, locs:admLocs, notify:admNotify, devlog:admDevLog, data:admData})[t]();
}
function admUsers(){
  $('#admBody').innerHTML = `
    <div class="card"><table class="table"><thead><tr><th>아이디</th><th>이름</th><th>역할</th><th></th></tr></thead><tbody>
      ${S.users.map(u=>`<tr><td style="font-family:var(--mono)">${esc(u.id)}</td><td>${esc(u.name)}</td>
        <td><span class="chip ${u.role==='admin'?'chip-move':'chip-gray'}">${u.role==='admin'?'관리자':'작업자'}</span></td>
        <td style="text-align:right">${u.id!=='admin'?`<button class="btn btn-danger btn-sm" data-del-user="${esc(u.id)}">삭제</button>`:''}
        <button class="btn btn-ghost btn-sm" data-pw-user="${esc(u.id)}">비번변경</button></td></tr>`).join('')}
    </tbody></table></div>
    <div class="card"><b style="font-size:14px">사용자 추가</b>
      <div class="row" style="margin-top:10px">
        <div class="field"><label>아이디</label><input id="nuId"></div>
        <div class="field"><label>이름</label><input id="nuName"></div></div>
      <div class="row">
        <div class="field"><label>비밀번호</label><input id="nuPw" type="password"></div>
        <div class="field"><label>역할</label><select id="nuRole"><option value="worker">작업자</option><option value="admin">관리자</option></select></div></div>
      <button class="btn btn-primary" id="nuAdd">추가</button></div>`;
  $('#nuAdd').onclick = ()=>busy($('#nuAdd'), async ()=>{
    const id=$('#nuId').value.trim(), name=$('#nuName').value.trim(), pw=$('#nuPw').value, role=$('#nuRole').value;
    if(!id||!name||pw.length<4) return toast('아이디/이름 입력, 비밀번호 4자 이상','err');
    try{ await api('addUser', { id, name, role, pwHash: await sha256(pw) }); toast('사용자 추가 완료','ok'); admUsers(); }
    catch(e){ toast(e.message,'err'); }
  });
  document.querySelectorAll('[data-del-user]').forEach(b=>b.onclick=async ()=>{
    const id=b.dataset.delUser;
    if(!confirm(`사용자 ${id} 를 삭제할까요?`)) return;
    try{ await api('delUser', { id }); toast('삭제 완료','ok'); admUsers(); }catch(e){ toast(e.message,'err'); }
  });
  document.querySelectorAll('[data-pw-user]').forEach(b=>b.onclick=async ()=>{
    const id=b.dataset.pwUser;
    const pw = prompt(`${id} 의 새 비밀번호 (4자 이상)`);
    if(!pw || pw.length<4) return;
    try{
      await api('setUserPw', { id, newPwHash: await sha256(pw) });
      toast('비밀번호 변경 완료','ok');
      if(id===S.me.id){ toast('본인 비밀번호가 변경되어 다시 로그인해야 합니다'); doLogout(); }
    }catch(e){ toast(e.message,'err'); }
  });
}
function admItems(){
  $('#admBody').innerHTML = `
    <div class="card" style="font-size:12.5px;color:var(--t2)">품번 마스터는 원칙적으로 <b>부품 품번 관리 시스템(AppSheet)</b>이 동기화합니다. 여기서는 급할 때 수동으로 보완할 수 있습니다. (재고 수량은 스캔 입·출고로만 변동)</div>
    <div class="card" style="overflow-x:auto"><table class="table"><thead><tr><th>품번</th><th>Rev</th><th>제품군</th><th>품명</th><th>단위</th><th>안전</th><th>재고</th><th></th></tr></thead><tbody>
      ${S.items.map(i=>`<tr><td style="font-family:var(--mono)">${esc(i.code)}</td><td style="font-family:var(--mono)">${esc(i.rev||'-')}</td>
        <td><span class="chip chip-gray">${esc(groupNameOf(i.code))}</span></td><td>${esc(i.name)}</td>
        <td>${esc(i.unit)}</td><td>${fmt(i.safetyStock)}</td><td>${fmt(i.stock)}</td>
        <td style="text-align:right"><button class="btn btn-danger btn-sm" data-del-item="${esc(i.code)}" data-del-rev="${esc(i.rev||'')}">삭제</button></td></tr>`).join('')}
    </tbody></table></div>
    <div class="card"><b style="font-size:14px">품번 추가</b>
      <div class="row" style="margin-top:10px">
        <div class="field" style="flex:2"><label>품번 (예: RP-303-013)</label><input id="niCode" placeholder="RP-303-013" style="text-transform:uppercase"></div>
        <div class="field"><label>리비전</label><input id="niRev" placeholder="D" style="text-transform:uppercase"></div></div>
      <div class="field"><label>품명</label><input id="niName" placeholder="예: COVER, E-RR"></div>
      <div class="row">
        <div class="field"><label>단위</label><input id="niUnit" value="EA"></div>
        <div class="field"><label>안전재고</label><input id="niSafe" type="number" min="0" value="0"></div></div>
      <button class="btn btn-primary" id="niAdd">추가</button></div>
    <div class="card"><b style="font-size:14px">📥 여러 품번 일괄 등록</b>
      <p class="muted" style="margin:6px 0 10px">엑셀/구글시트에서 <b>품번 · 리비전 · 품명 · 단위 · 안전재고</b> 순서로 복사해 붙여넣으세요. 한 줄에 한 품번, 단위 이후는 생략 가능합니다.</p>
      <textarea id="biText" rows="5" placeholder="RP-303-013	D	COVER, E-RR	EA	100&#10;RG-101-002	A	BRACKET, MAIN	EA	50" style="width:100%;padding:10px;border:1.5px solid var(--bd);border-radius:9px;font-family:var(--mono);font-size:13px;white-space:pre;overflow-x:auto"></textarea>
      <button class="btn btn-primary" id="biAdd" style="width:100%;margin-top:10px">붙여넣은 품번 일괄 등록</button>
      <div id="biResult"></div></div>`;
  if(S._prefillNewItemCode){ $('#niCode').value=S._prefillNewItemCode; if(S._prefillNewItemRev) $('#niRev').value=S._prefillNewItemRev; S._prefillNewItemCode=null; S._prefillNewItemRev=null; setTimeout(()=>$('#niName').focus(),0); }
  $('#niAdd').onclick = ()=>busy($('#niAdd'), async ()=>{
    try{
      await api('addItem', { code:$('#niCode').value.trim().toUpperCase(), rev:$('#niRev').value.trim().toUpperCase(), name:$('#niName').value.trim(),
        unit:$('#niUnit').value.trim()||'EA', safetyStock:Number($('#niSafe').value)||0 });
      toast('품번 추가 완료','ok'); admItems();
    }catch(e){ toast(e.message,'err'); }
  });
  $('#biAdd').onclick = ()=>busy($('#biAdd'), async ()=>{
    const rows = ($('#biText').value||'').replace(/\r/g,'').split('\n')
      .map(l=>l.split('\t').map(c=>c.trim())).filter(c=>c[0])
      .map(c=>({ code:(c[0]||'').toUpperCase(), rev:(c[1]||'').toUpperCase(), name:c[2]||'', unit:c[3]||'EA', safetyStock:Number(c[4])||0 }));
    if(!rows.length) return toast('붙여넣은 품번이 없습니다','err');
    try{
      const r = await api('bulkAddItem', { rows });
      const okN = r.results.filter(x=>x.ok).length, fails = r.results.filter(x=>!x.ok);
      toast(`품번 ${okN}건 등록${fails.length?` · ${fails.length}건 실패`:''}`, fails.length?'err':'ok');
      $('#biResult').innerHTML = fails.length
        ? `<div style="margin-top:10px;font-size:12.5px;color:var(--out)"><b>실패 ${fails.length}건</b>${fails.map(x=>`<div>· ${esc(skuOf(x.code||'',x.rev||''))} — ${esc(x.error)}</div>`).join('')}</div>`
        : '';
      if(okN) setTimeout(admItems, 900);   // 목록 새로고침 (결과 토스트를 잠깐 보여준 뒤)
    }catch(e){ toast(e.message,'err'); }
  });
  document.querySelectorAll('[data-del-item]').forEach(b=>b.onclick=async ()=>{
    const code=b.dataset.delItem, rev=b.dataset.delRev||'';
    if(!confirm(`품번 ${skuOf(code,rev)} 를 삭제할까요?`)) return;
    try{ await api('delItem', { code, rev }); toast('삭제 완료','ok'); admItems(); }catch(e){ toast(e.message,'err'); }
  });
}
function admLocs(){
  $('#admBody').innerHTML = `
    <div class="card"><table class="table"><thead><tr><th>코드</th><th>창고</th><th>구역</th><th>랙</th><th></th></tr></thead><tbody>
      ${S.locs.map(l=>`<tr><td style="font-family:var(--mono)">${esc(l.code)}</td><td>${esc(l.warehouse)}</td><td>${esc(l.zone)}</td><td>${esc(l.rack)}</td>
        <td style="text-align:right"><button class="btn btn-danger btn-sm" data-del-loc="${esc(l.code)}">삭제</button></td></tr>`).join('')}
    </tbody></table></div>
    <div class="card"><b style="font-size:14px">위치 추가</b>
      <div class="row" style="margin-top:10px">
        <div class="field"><label>창고</label><input id="nlWh" placeholder="A창고"></div>
        <div class="field"><label>구역</label><input id="nlZone" placeholder="01구역"></div>
        <div class="field"><label>랙</label><input id="nlRack" placeholder="03랙"></div></div>
      <div class="field"><label>위치코드</label><input id="nlCode" placeholder="예: A-01-03" style="text-transform:uppercase"></div>
      <button class="btn btn-primary" id="nlAdd">추가</button></div>`;
  $('#nlAdd').onclick = ()=>busy($('#nlAdd'), async ()=>{
    try{
      await api('addLoc', { code:$('#nlCode').value.trim().toUpperCase(), warehouse:$('#nlWh').value.trim(), zone:$('#nlZone').value.trim(), rack:$('#nlRack').value.trim() });
      toast('위치 추가 완료','ok'); admLocs();
    }catch(e){ toast(e.message,'err'); }
  });
  document.querySelectorAll('[data-del-loc]').forEach(b=>b.onclick=async ()=>{
    try{ await api('delLoc', { code:b.dataset.delLoc }); toast('삭제 완료','ok'); admLocs(); }catch(e){ toast(e.message,'err'); }
  });
}
function admData(){
  const inQ  = S.hist.filter(h=>h.type==='IN').reduce((s,h)=>s+Number(h.qty||0),0);
  const outQ = S.hist.filter(h=>h.type==='OUT').reduce((s,h)=>s+Number(h.qty||0),0);
  $('#admBody').innerHTML = `
    <div class="card">
      <b style="font-size:14px">요약 통계 <span class="muted">(최근 500건 이력 기준)</span></b>
      <table class="table" style="margin-top:8px">
        <tr><td>등록 품번 / 총 재고</td><td style="text-align:right"><b>${fmt(S.items.length)} / ${fmt(S.items.reduce((s,i)=>s+Number(i.stock||0),0))}</b></td></tr>
        <tr><td>입고 / 출고 수량</td><td style="text-align:right"><b style="color:var(--in)">+${fmt(inQ)}</b> / <b style="color:var(--out)">−${fmt(outQ)}</b></td></tr>
        <tr><td>총 이력 건수</td><td style="text-align:right"><b>${fmt(S.histTotal)}</b></td></tr>
        <tr><td>안전재고 미달 품번</td><td style="text-align:right"><b>${fmt(lowStockItems().length)}</b></td></tr>
      </table>
    </div>
    <div class="card">
      <b style="font-size:14px">데이터 관리</b>
      <div class="row" style="margin-top:10px">
        <button class="btn btn-ghost" id="expJson">전체 백업 (JSON 다운로드)</button>
        <button class="btn btn-danger" id="wipeAll">전체 초기화</button>
      </div>
      <p class="muted" style="margin-top:8px">원본 데이터는 연결된 <b>구글 시트</b>에 저장됩니다. 시트에서 직접 열람·필터·피벗 분석이 가능하며, 구글 드라이브 버전 기록으로 복원할 수 있습니다.</p>
    </div>`;
  $('#expJson').onclick = ()=>{
    const blob = new Blob([JSON.stringify({items:S.items,locs:S.locs,hist:S.hist},null,2)],{type:'application/json'});
    const a = document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`ims_backup_${today()}.json`; a.click();
  };
  $('#wipeAll').onclick = async ()=>{
    if(!confirm('모든 품번/재고/이력/위치 데이터를 삭제합니다. 계속할까요?')) return;
    if(prompt('확인을 위해 "초기화" 를 입력하세요') !== '초기화') return;
    try{ await api('wipe'); toast('초기화 완료','ok'); renderAdmin(); renderAlerts(); }catch(e){ toast(e.message,'err'); }
  };
}

/* =========================================================
   초기화
========================================================= */
(function init(){
  $('#apiUrl').value = DEFAULT_API_URL || recall('ims_api');
  // 기본 서버 주소가 지정돼 있으면 로그인 화면에서 주소 입력칸을 숨긴다
  if(DEFAULT_API_URL){ const f = $('#apiUrl').closest('.field'); if(f) f.style.display='none'; }
  $('#loginId').value = recall('ims_id');
  $('#loginBtn').onclick = doLogin;
  $('#loginPw').addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
  $('#logoutBtn').onclick = doLogout;
  $('#refreshBtn').onclick = refreshNow;
})();
