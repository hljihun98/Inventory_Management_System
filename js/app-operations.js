/* =========================================================
   바코드 생성 (로트 채번은 서버=구글시트 기준으로 수행)
========================================================= */
function renderLabel(){
  $('#main').innerHTML = `
    <div class="sec-title">🏷️ 로트 바코드 생성</div>
    <div class="card">
      <div class="field"><label>품목</label>
        <select id="lbItem">${S.items.map(i=>`<option value="${esc(i.code)}">${esc(i.name)} (${esc(i.code)})</option>`).join('')}</select></div>
      <div class="row">
        <div class="field"><label>제조일자</label><input id="lbMfg" type="date" value="${today()}"></div>
        <div class="field"><label>초기 입고 수량 (0 = 라벨만)</label><input id="lbQty" type="number" min="0" value="0" inputmode="numeric"></div>
      </div>
      <div class="field"><label>초기 보관 위치 (선택)</label>
        <select id="lbLoc"><option value="">- 미지정 -</option>${S.locs.map(l=>`<option value="${esc(l.code)}">${esc(l.code)} · ${esc(l.warehouse)}</option>`).join('')}</select></div>
      <div class="field"><label>바코드 형식</label>
        <div class="seg"><button id="segQR" class="on-move">QR 코드</button><button id="seg1D">1D · Code128</button></div></div>
      <button class="btn btn-primary" id="lbGen">로트 생성 + 바코드 발행</button>
      <p class="muted" style="margin-top:8px">로트번호 규칙: <b style="font-family:var(--mono)">품목코드-제조일자(YYYYMMDD)-일련번호(3자리)</b> · 일련번호는 시트 기준 자동 증가 (동시 발행 충돌 방지)</p>
    </div>
    <div id="lbResult"></div>`;
  let fmt1D = false;
  $('#segQR').onclick = ()=>{ fmt1D=false; $('#segQR').className='on-move'; $('#seg1D').className=''; };
  $('#seg1D').onclick = ()=>{ fmt1D=true;  $('#seg1D').className='on-move'; $('#segQR').className=''; };
  $('#lbGen').onclick = ()=>busy($('#lbGen'), async ()=>{
    const itemCode = $('#lbItem').value;
    if(!itemCode) return toast('품목을 먼저 등록하세요','err');
    try{
      const r = await api('createLot', { p:null, itemCode, mfg: $('#lbMfg').value || today(),
        qty: Math.max(0, Number($('#lbQty').value)||0), loc: $('#lbLoc').value });
      toast(`로트 ${r.lotNo} 생성 완료 (시트 기록됨)`,'ok');
      showLabel(r.lotNo, fmt1D);
      renderAlerts();
    }catch(e){ toast(e.message,'err'); }
  });
}
function showLabel(lotNo, is1D){
  const lot = lotOf(lotNo), it = itemOf(lot.itemCode);
  $('#lbResult').innerHTML = `
    <div class="label-wrap" id="labelCard">
      <div class="l-item">${esc(it?.name||lot.itemCode)}</div>
      <div id="codeBox" style="display:flex;justify-content:center"><div id="qrBox"></div><svg id="bcSvg" class="hidden"></svg></div>
      <div class="l-lot">${esc(lotNo)}</div>
      <div class="l-meta">제조 ${esc(lot.mfgDate)} · 발행 ${new Date().toLocaleDateString('ko-KR')} · ${esc(S.me.name)}</div>
    </div>
    <div class="row">
      <button class="btn btn-ghost" id="dlPng">이미지 다운로드 (PNG)</button>
      <button class="btn btn-ghost" id="printLb">라벨 인쇄</button>
    </div>`;
  if(is1D){
    $('#bcSvg').classList.remove('hidden');
    JsBarcode('#bcSvg', lotNo, { format:'CODE128', height:64, width:1.6, fontSize:0, margin:4 });
  }else{
    new QRCode($('#qrBox'), { text:lotNo, width:180, height:180, correctLevel:QRCode.CorrectLevel.M });
  }
  $('#dlPng').onclick = ()=>downloadLabel(lotNo, is1D);
  $('#printLb').onclick = ()=>window.print();
}
function downloadLabel(lotNo, is1D){
  const cv = document.createElement('canvas');
  if(is1D){ JsBarcode(cv, lotNo, { format:'CODE128', height:80, width:2, displayValue:true, fontSize:16, margin:12 }); triggerDL(cv,lotNo); }
  else{
    const src = $('#qrBox').querySelector('canvas') || $('#qrBox').querySelector('img');
    cv.width = 260; cv.height = 300;
    const ctx = cv.getContext('2d');
    ctx.fillStyle='#fff'; ctx.fillRect(0,0,cv.width,cv.height);
    ctx.drawImage(src, 40, 20, 180, 180);
    ctx.fillStyle='#111'; ctx.font='bold 15px monospace'; ctx.textAlign='center';
    ctx.fillText(lotNo, 130, 232);
    triggerDL(cv,lotNo);
  }
}
function triggerDL(canvas, lotNo){
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png'); a.download = `label_${lotNo}.png`; a.click();
}
/* 사진 확대 라이트박스 (입고 인증사진 등에서 공용 사용) */
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
        <div class="row"><input id="manualLot" placeholder="로트번호 입력 또는 리더기로 스캔" style="flex:2;padding:11px 12px;border:1.5px solid var(--line);border-radius:9px">
        <button class="btn btn-ghost" id="manualGo">조회</button></div>
        <p class="muted" style="margin-top:6px">USB/블루투스 바코드 리더기는 이 입력칸에 초점을 두고 스캔하면 됩니다.</p>
      </div>
    </div>
    <div id="scanPanel"></div>`;
  $('#scanToggle').onclick = ()=> S.scanning ? stopScan(true) : startScan();
  $('#manualGo').onclick = ()=>{ const v=$('#manualLot').value.trim(); if(v) onCode(v,true); };
  $('#manualLot').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); const v=e.target.value.trim(); if(v) onCode(v,true); e.target.select(); }});
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
async function onCode(code, manual){
  const now = Date.now();                       // 중복 스캔 방지 (2.5초)
  if(!manual && code===S.lastScan.code && now-S.lastScan.at<2500) return;
  S.lastScan = { code, at:now };
  const lot = lotOf(code) || (await loadAll(), lotOf(code)); // 없으면 시트 재조회
  if(!lot){ if(navigator.vibrate) navigator.vibrate(80); return toast(`등록되지 않은 코드: ${code}`,'err'); }
  if(navigator.vibrate) navigator.vibrate(30);
  S.scanTarget = lot.lotNo; S.scanMode='IN';
  S._inStatus='정상'; S._inIssue=''; S._inMakeIssue=undefined;   // 새 스캔마다 품질 이상 여부 초기화
  S._inPhotos=[]; S._inReason='';                                 // 인증사진·사유 초기화
  drawScanPanel();
}
function drawScanPanel(){
  const lot = lotOf(S.scanTarget);
  if(!lot){ $('#scanPanel').innerHTML=''; return; }
  const it = itemOf(lot.itemCode);
  const older = S.lots.filter(l=>l.itemCode===lot.itemCode && l.qty>0 && l.mfgDate < lot.mfgDate);
  const ex = expiryOf(lot), d = dday(ex);
  const st = S._inStatus || '정상';   // 입고 품질 이상 여부 (ROBOSTOCK 입출고 모티브)
  $('#scanPanel').innerHTML = `
    <div class="lot-tag scan-hit">
      <div class="lot-no">${esc(lot.lotNo)}</div>
      <div class="lot-meta">${esc(it?.name||lot.itemCode)} · 현재고 <b>${fmt(lot.qty)}${esc(it?.unit||'')}</b> · 📍${esc(lot.location||'위치 미지정')} · 제조 ${esc(lot.mfgDate)}
      ${ex?` · ${d<=0?'⚠️기한만료':'유통 D-'+d}`:''}</div>
    </div>
    <div class="row" style="margin-bottom:10px">
      <button class="btn btn-ghost btn-sm" id="goDocBtn">📁 문서/사진</button>
      <button class="btn btn-ghost btn-sm" id="goIssueBtn">🚨 이상신고</button>
    </div>
    <div class="card">
      <div class="seg" style="margin-bottom:12px">
        <button id="mIn"  class="${S.scanMode==='IN'?'on-in':''}">입고</button>
        <button id="mOut" class="${S.scanMode==='OUT'?'on-out':''}">출고</button>
        <button id="mMove" class="${S.scanMode==='MOVE'?'on-move':''}">위치이동</button>
      </div>
      ${S.scanMode!=='MOVE'?`
        <div class="field"><label>수량</label>
          <div class="big-qty"><button id="qMinus">−</button><input id="qVal" type="number" min="1" value="1" inputmode="numeric"><button id="qPlus">+</button></div></div>`:''}
      ${S.scanMode!=='OUT'?`
        <div class="field"><label>${S.scanMode==='MOVE'?'이동할 위치':'보관 위치'}</label>
          <select id="qLoc"><option value="">- 미지정 -</option>${S.locs.map(l=>`<option value="${esc(l.code)}" ${lot.location===l.code&&S.scanMode==='IN'?'selected':''}>${esc(l.code)} · ${esc(l.warehouse)} ${esc(l.zone)} ${esc(l.rack)}</option>`).join('')}</select></div>`:''}
      <div class="field"><label>사유 (선택)</label><input id="qReason" value="${esc(S._inReason||'')}" placeholder="${S.scanMode==='IN'?'예: 정기 입고, 반품 입고':S.scanMode==='OUT'?'예: 생산 투입, 판매 출고':'예: 랙 재배치'}"></div>
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
      ${S.scanMode==='OUT'&&older.length?`<p class="muted" style="margin-bottom:10px">⚠️ <b>FIFO 주의:</b> 더 오래된 로트 ${esc(older[0].lotNo)} (제조 ${esc(older[0].mfgDate)}, ${fmt(older[0].qty)}${esc(it?.unit||'')}) 가 남아 있습니다.</p>`:''}
      <button class="btn ${S.scanMode==='IN'?'btn-in':S.scanMode==='OUT'?'btn-out':'btn-move'}" style="width:100%" id="qGo">
        ${S.scanMode==='IN'?'입고 처리':S.scanMode==='OUT'?'출고 처리':'위치 이동'}</button>
    </div>`;
  ['In','Out','Move'].forEach(m=>{ $('#m'+m).onclick=()=>{ S.scanMode=m.toUpperCase(); drawScanPanel(); }; });
  $('#goDocBtn').onclick = ()=>{ S._docLot = lot.lotNo; go('doc'); };
  $('#goIssueBtn').onclick = ()=>{ S._isLot = lot.lotNo; S._issueTab = 'new'; go('issue'); };
  if(S.scanMode!=='MOVE'){
    $('#qMinus').onclick=()=>{ const i=$('#qVal'); i.value=Math.max(1,Number(i.value)-1); };
    $('#qPlus').onclick =()=>{ const i=$('#qVal'); i.value=Number(i.value)+1; };
  }
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
  $('#qGo').onclick = ()=>busy($('#qGo'), ()=>processTx(lot.lotNo));
}
async function processTx(lotNo){
  const mode = S.scanMode;
  const qty = mode==='MOVE' ? 0 : Math.floor(Number($('#qVal').value)||0);
  const loc = mode!=='OUT' ? $('#qLoc').value : '';
  let reason = $('#qReason').value.trim();
  if(mode!=='MOVE' && qty<1) return toast('수량은 1 이상이어야 합니다','err');
  if(mode==='MOVE' && !loc) return toast('이동할 위치를 선택하세요','err');

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
    // 재고 검증·차감·이력 기록은 서버(Apps Script)에서 잠금 후 단일 처리
    const r = await api('tx', { type:mode, lotNo, qty, loc, reason });
    // 이상 입고 → 기존 품질신고(Issues) 시스템에 자동 등록
    if(mode==='IN' && status!=='정상' && makeIssue){
      const lot = lotOf(lotNo), it = itemOf(lot?.itemCode);
      const sev = status==='이상' ? '긴급' : '경미';
      try{
        await api('reportIssue', { lotNo, severity:sev,
          title:`입고 시 ${status} — ${it?.name || lot?.itemCode || lotNo}`, description:issue });
        buildTabs();   // 미해결 신고 배지 갱신
      }catch(e){ toast('입고는 완료됐지만 품질신고 등록 실패: '+e.message,'err'); }
    }
    // 입고 인증사진 → 문서함(Drive) 저장 (ROBOSTOCK 입고 인증사진 모티브)
    if(mode==='IN' && (S._inPhotos||[]).length){
      let done=0;
      for(const p of S._inPhotos){
        try{ await api('uploadDoc', { lotNo, category:'입고검수', base64:p.base64, fileName:p.fileName, mimeType:p.mimeType }, {noApply:true}); done++; }
        catch(e){ toast('사진 업로드 실패: '+e.message,'err'); }
      }
      if(done) toast(`인증사진 ${done}장 문서함 저장`,'ok');
    }
    const stTag = status!=='정상' ? ` ⚠️${status}` : '';
    toast(mode==='IN'?`입고 +${fmt(qty)} 완료 (현재고 ${fmt(r.after)})${stTag}`:mode==='OUT'?`출고 −${fmt(qty)} 완료 (현재고 ${fmt(r.after)})`:'위치 이동 완료','ok');
    S._inStatus='정상'; S._inIssue=''; S._inMakeIssue=undefined; S._inPhotos=[]; S._inReason='';   // 상태 초기화
    renderAlerts(); drawScanPanel();
  }catch(e){ toast(e.message,'err'); }
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
    <div class="seg seg-compact" style="margin-bottom:12px">${seg('users','사용자')}${seg('items','품목')}${seg('locs','위치')}${seg('notify','알림')}${seg('devlog','메모')}${seg('data','데이터')}</div>
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
    <div class="card"><table class="table"><thead><tr><th>코드</th><th>품목명</th><th>안전재고</th><th>유통(일)</th><th></th></tr></thead><tbody>
      ${S.items.map(i=>`<tr><td style="font-family:var(--mono)">${esc(i.code)}</td><td>${esc(i.name)}</td>
        <td>${fmt(i.safetyStock)}${esc(i.unit)}</td><td>${i.shelfLifeDays||'-'}</td>
        <td style="text-align:right"><button class="btn btn-danger btn-sm" data-del-item="${esc(i.code)}">삭제</button></td></tr>`).join('')}
    </tbody></table></div>
    <div class="card"><b style="font-size:14px">품목 추가</b>
      <div class="row" style="margin-top:10px">
        <div class="field"><label>품목코드 (영문/숫자)</label><input id="niCode" placeholder="예: BRKT02" style="text-transform:uppercase"></div>
        <div class="field"><label>품목명</label><input id="niName"></div></div>
      <div class="row">
        <div class="field"><label>단위</label><input id="niUnit" value="EA"></div>
        <div class="field"><label>안전재고</label><input id="niSafe" type="number" min="0" value="0"></div>
        <div class="field"><label>유통기한(일, 0=없음)</label><input id="niShelf" type="number" min="0" value="0"></div></div>
      <button class="btn btn-primary" id="niAdd">추가</button></div>`;
  $('#niAdd').onclick = ()=>busy($('#niAdd'), async ()=>{
    try{
      await api('addItem', { code:$('#niCode').value.trim().toUpperCase(), name:$('#niName').value.trim(),
        unit:$('#niUnit').value.trim()||'EA', safetyStock:Number($('#niSafe').value)||0, shelfLifeDays:Number($('#niShelf').value)||0 });
      toast('품목 추가 완료','ok'); admItems();
    }catch(e){ toast(e.message,'err'); }
  });
  document.querySelectorAll('[data-del-item]').forEach(b=>b.onclick=async ()=>{
    const code=b.dataset.delItem;
    if(!confirm(`품목 ${code} 를 삭제할까요?`)) return;
    try{ await api('delItem', { code }); toast('삭제 완료','ok'); admItems(); }catch(e){ toast(e.message,'err'); }
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
        <tr><td>등록 품목 / 로트</td><td style="text-align:right"><b>${fmt(S.items.length)} / ${fmt(S.lots.length)}</b></td></tr>
        <tr><td>입고 / 출고 수량</td><td style="text-align:right"><b style="color:var(--in)">+${fmt(inQ)}</b> / <b style="color:var(--out)">−${fmt(outQ)}</b></td></tr>
        <tr><td>총 이력 건수</td><td style="text-align:right"><b>${fmt(S.histTotal)}</b></td></tr>
        <tr><td>안전재고 미달 품목</td><td style="text-align:right"><b>${fmt(lowStockItems().length)}</b></td></tr>
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
    const blob = new Blob([JSON.stringify({items:S.items,lots:S.lots,locs:S.locs,hist:S.hist},null,2)],{type:'application/json'});
    const a = document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`ims_backup_${today()}.json`; a.click();
  };
  $('#wipeAll').onclick = async ()=>{
    if(!confirm('모든 품목/로트/이력/위치 데이터를 삭제합니다. 계속할까요?')) return;
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
