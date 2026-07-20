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
/* QR + 주요 1D(막대) 포맷을 명시 지정 → 안드로이드(네이티브 디코더)·아이폰(JS 디코더) 양쪽에서
   QR·막대 둘 다 확실히 인식. 라이브러리 미로드 등으로 enum이 없으면 undefined 반환(전체 포맷 기본값 사용). */
function scanFormats(){
  const F = window.Html5QrcodeSupportedFormats;
  if(!F) return undefined;
  return [F.QR_CODE, F.CODE_128, F.CODE_39, F.CODE_93, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.ITF, F.CODABAR];
}
async function startScan(){
  try{
    initAudio();   // 사용자 제스처(버튼 클릭) 안에서 오디오 활성화 → 이후 인식음 재생 허용
    // 네이티브 BarcodeDetector 우선 사용(안드로이드/크롬에서 훨씬 빠름) · 아이폰 사파리는 미지원이라 JS 디코더로 자동 폴백
    S.scanner = new Html5Qrcode('reader', { formatsToSupport: scanFormats(), experimentalFeatures:{ useBarCodeDetectorIfSupported:true }, verbose:false });
    // 스캔 영역을 뷰파인더 크기에 맞춰 크고 가로로 넓게(1D 바코드 인식률↑) · fps 상향으로 초당 인식 시도 증가
    const qrbox = (vw, vh) => { const w = Math.round(Math.min(vw*0.9, 440)); return { width:w, height:Math.round(Math.min(vh*0.7, w)) }; };
    await S.scanner.start({ facingMode:'environment' }, { fps:15, qrbox },
      txt=>onCode(txt,false), ()=>{});
    S.scanning = true;
    setupTapFocus('reader');   // 탭하여 초점 재조정(안드로이드 지원 · iOS는 무시)
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

/* =========================================================
   탭하여 초점 재조정 — 기본은 연속(오토) 초점, 화면 탭 시 단발 재초점 후 연속 복귀.
   지원: 안드로이드 크롬(focusMode/pointsOfInterest). 미지원(iOS 사파리 등)은 조용히 무시.
========================================================= */
let _lastFocusAt = 0;
function setupTapFocus(readerId){
  const attach = tries => {
    const reader = document.getElementById(readerId);
    const video = reader && reader.querySelector('video');
    const track = video && video.srcObject && video.srcObject.getVideoTracks && video.srcObject.getVideoTracks()[0];
    if(!track){ if(tries>0) setTimeout(()=>attach(tries-1), 250); return; }   // 비디오 트랙 준비될 때까지 잠깐 대기
    try{ const caps = track.getCapabilities ? track.getCapabilities() : {};   // 기본: 연속(오토) 초점
      if(caps.focusMode && caps.focusMode.indexOf('continuous')>=0) track.applyConstraints({ advanced:[{ focusMode:'continuous' }] }).catch(()=>{}); }catch(e){}
    reader.style.position = 'relative'; reader.style.cursor = 'pointer';
    reader.onclick = e => tapFocusAt(track, reader, e);
  };
  attach(4);
}
async function tapFocusAt(track, reader, e){
  const now = Date.now();
  if(now - _lastFocusAt < 700) return;              // 너무 잦은 재초점 방지(쓰로틀)
  _lastFocusAt = now;
  let caps = {}; try{ caps = track.getCapabilities ? track.getCapabilities() : {}; }catch(err){ return; }
  const modes = caps.focusMode || [];
  if(!modes.length && !caps.pointsOfInterest) return;   // 초점 제어 미지원 → 무시(iOS 등)
  const adv = {};
  if(caps.pointsOfInterest){                         // 탭한 좌표를 초점 지점으로(지원 기기)
    const r = reader.getBoundingClientRect();
    adv.pointsOfInterest = [{ x: Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)), y: Math.min(1,Math.max(0,(e.clientY-r.top)/r.height)) }];
  }
  try{
    if(modes.indexOf('single-shot')>=0){
      await track.applyConstraints({ advanced:[Object.assign({ focusMode:'single-shot' }, adv)] });
      if(modes.indexOf('continuous')>=0) setTimeout(()=>track.applyConstraints({ advanced:[{ focusMode:'continuous' }] }).catch(()=>{}), 1600);  // 재초점 후 연속 복귀
    }else if(modes.indexOf('continuous')>=0){
      await track.applyConstraints({ advanced:[Object.assign({ focusMode:'continuous' }, adv)] });
    }else if(adv.pointsOfInterest){
      await track.applyConstraints({ advanced:[adv] });
    }else return;
    focusRing(reader, e);                            // 시각 피드백(초점 링)
  }catch(err){}
}
function focusRing(reader, e){
  const r = reader.getBoundingClientRect();
  const ring = document.createElement('div');
  ring.className = 'focus-ring';
  ring.style.left = (e.clientX - r.left) + 'px';
  ring.style.top = (e.clientY - r.top) + 'px';
  reader.appendChild(ring);
  setTimeout(()=>ring.remove(), 700);
}

/* =========================================================
   공용 바코드 스캔 모달 — 어느 화면에서든 입력칸 옆 바코드 버튼으로 카메라 스캔.
   onDetect(text): 인식된 바코드 문자열을 받아 처리(예: 품번 입력칸 채우기).
   모달을 닫으면(취소·배경클릭·인식완료) closeModal → stopModalScan 으로 카메라가 확실히 정지된다.
========================================================= */
let _modalScanner = null;
async function stopModalScan(){
  if(_modalScanner){ const s=_modalScanner; _modalScanner=null; try{ await s.stop(); s.clear(); }catch(e){} }
}
async function openScanModal(onDetect){
  openModal(`<h3>📷 바코드 스캔</h3>
    <div id="scanModalReader" style="width:100%;min-height:240px;border-radius:12px;overflow:hidden;background:#000"></div>
    <p class="muted" style="margin-top:10px">QR 또는 막대 바코드를 화면 안에 비추면 자동 인식됩니다.</p>
    <div class="row" style="margin-top:12px"><button class="btn btn-ghost" id="scanModalCancel" style="width:100%">취소</button></div>`);
  $('#scanModalCancel').onclick = async ()=>{ await stopModalScan(); closeModal(); };
  initAudio();   // 버튼 클릭 제스처 안에서 오디오 활성화 → 인식음 재생 허용
  try{
    _modalScanner = new Html5Qrcode('scanModalReader', { formatsToSupport: scanFormats(), experimentalFeatures:{ useBarCodeDetectorIfSupported:true }, verbose:false });
    const qrbox = (vw, vh) => { const w = Math.round(Math.min(vw*0.9, 440)); return { width:w, height:Math.round(Math.min(vh*0.7, w)) }; };
    let handled=false;
    await _modalScanner.start({ facingMode:'environment' }, { fps:15, qrbox }, async txt=>{
      if(handled) return; handled=true;         // 첫 인식만 처리(연속 콜백 방지)
      beep('ok'); if(navigator.vibrate) navigator.vibrate(30);
      await stopModalScan(); closeModal();
      onDetect(txt);
    }, ()=>{});
    setupTapFocus('scanModalReader');   // 탭하여 초점 재조정
  }catch(e){
    await stopModalScan(); closeModal();
    toast('카메라를 열 수 없습니다. HTTPS 접속·카메라 권한을 확인하거나 직접 입력하세요','err');
  }
}
async function onCode(raw, manual){
  const now = Date.now();                       // 중복 스캔 방지 (2.5초)
  if(!manual && raw===S.lastScan.code && now-S.lastScan.at<2500) return;
  S.lastScan = { code: raw, at:now };
  let r = resolveScan(raw);
  if(!r.item && !r.ambiguous){ await loadAll(); r = resolveScan(raw); }   // 없으면 시트 재조회
  if(r.item){
    beep('ok');                                  // 인식 성공 삑
    if(navigator.vibrate) navigator.vibrate(30);
    S.scanTarget = { code:r.item.code, rev:r.item.rev||'' }; S.scanMode='IN';
    S._inStatus='정상'; S._inIssue=''; S._inMakeIssue=undefined;   // 새 스캔마다 품질 이상 여부 초기화
    S._inPhotos=[]; S._inReason='';                                 // 인증사진·사유 초기화
    drawScanPanel();
    return;
  }
  beep('err');                                   // 미등록/불명확 — 낮은 삑
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
  const mode = S.scanMode;
  const cur = Number(it.stock||0);
  const modeBtn = { IN:'btn-in', OUT:'btn-out', MOVE:'btn-move', ADJUST:'btn-move' }[mode] || 'btn-primary';
  const modeLabel = { IN:'입고 처리', OUT:'출고 처리', MOVE:'위치 이동', ADJUST:'재고 조정' }[mode] || '처리';
  $('#scanPanel').innerHTML = `
    <div class="lot-tag scan-hit">
      <div class="lot-no">${esc(skuOf(it.code,it.rev))}</div>
      <div class="lot-meta"><span class="chip chip-move">${esc(groupNameOf(it.code))}</span> ${esc(it.name||it.code)} · 현재고 <b>${fmt(it.stock)}${esc(it.unit||'')}</b> · 📍${esc(it.location||'위치 미지정')}${it.safetyStock>0?` · 안전재고 ${fmt(it.safetyStock)}${esc(it.unit||'')}`:''}</div>
    </div>
    <div class="row" style="margin-bottom:10px">
      <button class="btn btn-ghost btn-sm" id="goDocBtn">📁 문서/사진</button>
      <button class="btn btn-ghost btn-sm" id="goIssueBtn">🚨 이상신고</button>
      ${isAssy(it.code,it.rev)?`<button class="btn btn-ghost btn-sm" id="goAssyBtn">🔧 조립/분해</button>`:''}
    </div>
    <div class="card">
      <div class="seg seg-compact" style="margin-bottom:12px">
        <button id="mIn"     class="${mode==='IN'?'on-in':''}">입고</button>
        <button id="mOut"    class="${mode==='OUT'?'on-out':''}">출고</button>
        <button id="mMove"   class="${mode==='MOVE'?'on-move':''}">이동</button>
        <button id="mAdjust" class="${mode==='ADJUST'?'on-warn':''}">조정</button>
      </div>
      ${mode!=='MOVE'?`
      <div class="field"><label>${mode==='ADJUST'?'실사 수량 (실물 카운트)':'수량'}</label>
        <div class="big-qty"><button id="qMinus">−</button><input id="qVal" type="number" min="${mode==='ADJUST'?0:1}" value="${mode==='ADJUST'?cur:1}" inputmode="numeric"><button id="qPlus">+</button></div>
        ${mode==='ADJUST'?`<p class="muted" style="margin-top:6px">현재 시스템 재고 <b>${fmt(cur)}${esc(it.unit||'')}</b> · 실물 수량을 입력하면 차이만큼 조정됩니다</p>`:''}
      </div>`:''}
      ${mode==='IN'?`
        <div class="field"><label>보관 위치 (선택)</label>
          <select id="qLoc"><option value="">- 미지정 -</option>${S.locs.map(l=>`<option value="${esc(l.code)}" ${it.location===l.code?'selected':''}>${esc(l.code)} · ${esc(l.warehouse)} ${esc(l.zone)} ${esc(l.rack)}</option>`).join('')}</select></div>`:''}
      ${mode==='MOVE'?`
        <div class="field"><label>현재 위치</label><input value="${esc(it.location||'미지정')}" disabled style="opacity:.65"></div>
        <div class="field"><label>이동할 위치</label>
          <select id="qMoveLoc"><option value="">- 위치 선택 -</option>${S.locs.filter(l=>l.code!==it.location).map(l=>`<option value="${esc(l.code)}">${esc(l.code)} · ${esc(l.warehouse)} ${esc(l.zone)} ${esc(l.rack)}</option>`).join('')}</select>
          ${S.locs.length?'':'<p class="muted" style="margin-top:6px">등록된 위치가 없습니다. 관리 → 위치에서 먼저 등록하세요.</p>'}</div>`:''}
      <div class="field"><label>사유 (선택)</label><input id="qReason" value="${esc(S._inReason||'')}" placeholder="${mode==='IN'?'예: 정기 입고, 반품 입고':mode==='OUT'?'예: 생산 투입, 판매 출고':mode==='MOVE'?'예: 랙 재배치':'예: 정기 실사, 파손 폐기'}"></div>
      ${mode==='IN'?`
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
      <button class="btn ${modeBtn}" style="width:100%" id="qGo">${modeLabel}</button>
    </div>`;
  [['mIn','IN'],['mOut','OUT'],['mMove','MOVE'],['mAdjust','ADJUST']].forEach(([id,m])=>{ const b=$('#'+id); if(b) b.onclick=()=>{ S.scanMode=m; drawScanPanel(); }; });
  $('#goDocBtn').onclick = ()=>{ S._docCode = it.code; S._docRev = it.rev||''; go('doc'); };
  $('#goIssueBtn').onclick = ()=>{ S._isCode = it.code; S._isRev = it.rev||''; S._issueTab = 'new'; go('issue'); };
  { const b=$('#goAssyBtn'); if(b) b.onclick=()=>openAssyDetail(it.code, it.rev||''); }
  { const qm=$('#qMinus'), qp=$('#qPlus'), floor=mode==='ADJUST'?0:1;
    if(qm) qm.onclick=()=>{ const i=$('#qVal'); i.value=Math.max(floor,Number(i.value)-1); };
    if(qp) qp.onclick =()=>{ const i=$('#qVal'); i.value=Number(i.value)+1; }; }
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
  let reason = ($('#qReason')?.value||'').trim();

  // ── 위치 이동 (수량 변화 없음, 보관 위치만 변경) ──
  if(mode==='MOVE'){
    const toLoc = $('#qMoveLoc').value;
    if(!toLoc) return toast('이동할 위치를 선택하세요','err');
    try{
      await api('tx', { type:'MOVE', code, rev, loc:toLoc, reason });
      if(navigator.vibrate) navigator.vibrate(30);
      toast(`위치 이동 완료 → ${toLoc}`,'ok');
      S._inReason=''; renderAlerts(); drawScanPanel();
    }catch(e){ toast(e.message,'err'); }
    return;
  }
  // ── 재고 실사 조정 (실물 카운트로 재고를 맞춤) ──
  if(mode==='ADJUST'){
    const counted = Math.floor(Number($('#qVal').value));
    if(isNaN(counted)||counted<0) return toast('실사 수량은 0 이상이어야 합니다','err');
    const curStock = Number(findItem(code,rev)?.stock||0);
    if(counted===curStock) return toast('실사 수량이 현재고와 같습니다','err');
    const diff = counted-curStock;
    if(!confirm(`재고 실사 조정\n현재고 ${fmt(curStock)} → 실물 ${fmt(counted)} (${diff>=0?'+':''}${fmt(diff)})\n이대로 조정할까요?`)) return;
    try{
      const r = await api('tx', { type:'ADJUST', code, rev, qty:counted, reason });
      if(navigator.vibrate) navigator.vibrate(30);
      toast(`재고 조정 완료 (${diff>=0?'+':''}${fmt(diff)} · 현재고 ${fmt(r.after)})`,'ok');
      S._inReason=''; renderAlerts(); drawScanPanel();
    }catch(e){ toast(e.message,'err'); }
    return;
  }

  // ── 입고 / 출고 ──
  const qty = Math.floor(Number($('#qVal').value)||0);
  const loc = mode==='IN' ? $('#qLoc').value : '';
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
   조립(assy) 상세 · BOM 트리 · 조립/분해
========================================================= */
/* 재귀 BOM 트리. mult = 이 노드 자식 소요량에 곱할 배수(루트 직계=조립수량, 그 아래는 null → 정보표시). */
function renderBomTree(code, rev, mult, path){
  path = path || new Set();
  const key = bomKey(code, rev);
  if(path.has(key) || path.size > 10) return '';        // 순환/깊이 가드
  const kids = bomChildrenOf(code, rev);
  if(!kids.length) return '';
  const np = new Set(path); np.add(key);
  return `<div class="bom-tree">${kids.map(e=>{
    const ci = findItem(e.childCode, e.childRev);
    const stock = itemQty(e.childCode, e.childRev);
    const per = Number(e.qtyPer)||0;
    const childAssy = isAssy(e.childCode, e.childRev);
    const openKey = key + '>' + bomKey(e.childCode, e.childRev);
    const open = S._treeOpen && S._treeOpen.has(openKey);
    const need = (mult!=null) ? per*mult : null;
    const short = (need!=null) && stock < need;
    return `<div class="bom-row" style="padding:5px 0;border-top:1px solid var(--line)">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        ${childAssy?`<button class="bom-caret" data-tree="${esc(openKey)}" style="width:20px">${open?'▾':'▸'}</button>`:'<span style="width:20px;display:inline-block"></span>'}
        <span class="ln" style="font-family:var(--mono)">${esc(skuOf(e.childCode,e.childRev))}</span>
        ${childAssy?'<span class="chip chip-move">🔧</span>':''}
        <span class="muted">${esc(ci?.name||(ci?'':'미등록'))}</span>
        <span class="chip chip-gray">×${fmt(per)}</span>
        <span style="margin-left:auto;font-variant-numeric:tabular-nums${short?';color:var(--out);font-weight:700':''}">재고 ${fmt(stock)}${need!=null?` / 소요 ${fmt(need)}`:''}${short?' ⚠️':''}</span>
      </div>
      ${childAssy&&open?`<div style="margin-left:20px">${renderBomTree(e.childCode, e.childRev, null, np)}</div>`:''}
    </div>`;
  }).join('')}</div>`;
}
/* =========================================================
   부품 상세 모달 — 재고 카드 본문을 탭하면 이 부품이 무엇인지 한눈에 보여준다.
   (품명·품번·제품군·현재고·안전재고·위치·조립정보·최근 이력 + 바로가기)
========================================================= */
function openItemDetail(code, rev){
  const it = findItem(code, rev);
  if(!it) return toast('품번을 찾을 수 없습니다','err');
  const qty = Number(it.stock||0), low = it.safetyStock>0 && qty < it.safetyStock;
  const assy = isAssy(it.code, it.rev), buildable = assy ? buildableOf(it.code, it.rev) : null;
  const lc = locOf(it.location);
  const recent = S.hist.filter(h=>h.itemCode===it.code && String(h.rev||'')===String(it.rev||'')).slice(-6).reverse();
  openModal(`
    <h3>${esc(it.name||it.code)} ${it.rev?`<span class="chip chip-gray">Rev ${esc(it.rev)}</span>`:''} ${assy?'<span class="chip chip-move">🔧 조립품</span>':''}</h3>
    <div class="muted" style="font-family:var(--mono);margin:-4px 0 12px">${esc(skuOf(it.code,it.rev))} · ${esc(groupNameOf(it.code))}</div>
    <div class="detail-grid">
      <div class="dg-cell"><span class="dg-k">현재고</span><span class="dg-v ${low?'low':''}">${fmt(qty)}${esc(it.unit||'')}${low?' ⚠️':''}</span></div>
      <div class="dg-cell"><span class="dg-k">안전재고</span><span class="dg-v">${it.safetyStock>0?fmt(it.safetyStock)+esc(it.unit||''):'—'}</span></div>
      <div class="dg-cell"><span class="dg-k">보관 위치</span><span class="dg-v" style="font-size:15px">${it.location?esc(it.location):'미지정'}</span></div>
      <div class="dg-cell"><span class="dg-k">창고·구역·랙</span><span class="dg-v" style="font-size:13px">${lc?esc(lc.warehouse+' · '+lc.zone+' · '+lc.rack):'—'}</span></div>
      ${assy?`<div class="dg-cell"><span class="dg-k">조립 가능</span><span class="dg-v">${fmt(buildable)}${esc(it.unit||'')}</span></div>
      <div class="dg-cell"><span class="dg-k">구성품</span><span class="dg-v">${bomChildrenOf(it.code,it.rev).length}종</span></div>`:''}
    </div>
    ${low?`<div class="detail-warn">⚠️ 안전재고 미달 — 보충이 필요합니다</div>`:''}
    <div class="detail-actions" style="margin:12px 0">
      <button class="btn btn-move" id="dtTx">⇅ 입·출고</button>
      ${assy?`<button class="btn btn-ghost" id="dtAssy">🔧 조립/분해</button>`:''}
      <button class="btn btn-ghost" id="dtDoc">📁 문서·사진</button>
      <button class="btn btn-ghost" id="dtIssue">🚨 이상신고</button>
    </div>
    <div class="dg-k">최근 입·출고</div>
    <div class="card" style="margin-top:6px">${recent.length?recent.map(h=>`
      <div class="hist-line" style="padding:6px 0">
        <div class="when">${new Date(h.ts).toLocaleDateString('ko-KR',{month:'2-digit',day:'2-digit'})}</div>
        <div class="what"><span class="chip chip-${histChipCls(h.type)}">${TYPE_KO[h.type]||h.type}</span> <span class="muted">${esc(h.user||'')}${h.reason?' · '+esc(h.reason):''}</span></div>
        ${HIST_POS.includes(h.type)?`<div class="q in">+${fmt(h.qty)}</div>`:HIST_NEG.includes(h.type)?`<div class="q out">−${fmt(h.qty)}</div>`:h.type==='ADJUST'?`<div class="q ${h.after>=h.before?'in':'out'}">${h.after>=h.before?'+':'−'}${fmt(Math.abs(h.after-h.before))}</div>`:''}
      </div>`).join(''):'<div class="muted" style="padding:2px 0">이력 없음</div>'}</div>
    <div class="row" style="margin-top:12px"><button class="btn btn-ghost" id="dtClose" style="width:100%">닫기</button></div>
  `);
  $('#dtTx').onclick = ()=>{ closeModal(); openTxSheet(it.code, it.rev||'', ['IN','OUT']); };
  { const b=$('#dtAssy'); if(b) b.onclick=()=>{ closeModal(); openAssyDetail(it.code, it.rev||''); }; }
  $('#dtDoc').onclick = ()=>{ closeModal(); S._docCode=it.code; S._docRev=it.rev||''; go('doc'); };
  $('#dtIssue').onclick = ()=>{ closeModal(); S._isCode=it.code; S._isRev=it.rev||''; S._issueTab='new'; go('issue'); };
  $('#dtClose').onclick = ()=>closeModal();
}

/* =========================================================
   입·출고 바텀시트 — 재고현황/상세에서 바로 처리. modes 로 노출 작업 제한
   (재고 카드=['IN','OUT'] · 조정·이동 화면=['MOVE','ADJUST']). 백엔드는 기존 api('tx') 공유.
========================================================= */
function openTxSheet(code, rev, modes){
  modes = (modes && modes.length) ? modes : ['IN','OUT'];
  const it = findItem(code, rev);
  if(!it) return toast('품번을 찾을 수 없습니다','err');
  const NAMES={IN:'입고',OUT:'출고',MOVE:'이동',ADJUST:'조정'};
  const ONCLS={IN:'on-in',OUT:'on-out',MOVE:'on-move',ADJUST:'on-warn'};
  const BTN={IN:'btn-in',OUT:'btn-out',MOVE:'btn-move',ADJUST:'btn-move'};
  const LABEL={IN:'입고 처리',OUT:'출고 처리',MOVE:'위치 이동',ADJUST:'재고 조정'};
  const HELP={MOVE:'재고 수량은 그대로 두고 보관 위치만 바꿉니다.',ADJUST:'실물을 세어 시스템 재고를 실제 수량에 맞춥니다(차이는 자동 기록).'};
  let mode = modes[0];
  const draw = ()=>{
    const cur = Number(findItem(code,rev)?.stock||0);
    openModal(`
      <h3>⇅ <span style="font-family:var(--mono)">${esc(skuOf(it.code,it.rev))}</span></h3>
      <div class="muted" style="margin:-4px 0 12px">${esc(it.name||it.code)} · 현재고 <b>${fmt(cur)}${esc(it.unit||'')}</b> · 📍${esc(it.location||'미지정')}</div>
      <div class="seg seg-compact" style="margin-bottom:12px">
        ${modes.map(m=>`<button data-txm="${m}" class="${mode===m?ONCLS[m]:''}">${NAMES[m]}</button>`).join('')}
      </div>
      ${HELP[mode]?`<p class="muted" style="margin:-4px 0 10px">ℹ️ ${esc(HELP[mode])}</p>`:''}
      ${mode!=='MOVE'?`<div class="field"><label>${mode==='ADJUST'?'실사 수량 (실물 카운트)':'수량'}</label>
        <div class="big-qty"><button id="txMinus">−</button><input id="txVal" type="number" min="${mode==='ADJUST'?0:1}" value="${mode==='ADJUST'?cur:1}" inputmode="numeric"><button id="txPlus">+</button></div>
        ${mode==='ADJUST'?`<p class="muted" style="margin-top:6px">현재 재고 <b>${fmt(cur)}${esc(it.unit||'')}</b> — 실물 수량을 입력하면 차이만큼 조정됩니다</p>`:''}</div>`:''}
      ${mode==='IN'?`<div class="field"><label>보관 위치 (선택)</label><select id="txLoc"><option value="">- 미지정 -</option>${S.locs.map(l=>`<option value="${esc(l.code)}" ${it.location===l.code?'selected':''}>${esc(l.code)} · ${esc(l.warehouse)} ${esc(l.zone)} ${esc(l.rack)}</option>`).join('')}</select></div>`:''}
      ${mode==='MOVE'?`<div class="field"><label>현재 위치</label><input value="${esc(it.location||'미지정')}" disabled style="opacity:.65"></div>
        <div class="field"><label>이동할 위치</label><select id="txMoveLoc"><option value="">- 위치 선택 -</option>${S.locs.filter(l=>l.code!==it.location).map(l=>`<option value="${esc(l.code)}">${esc(l.code)} · ${esc(l.warehouse)} ${esc(l.zone)} ${esc(l.rack)}</option>`).join('')}</select>
        ${S.locs.length?'':'<p class="muted" style="margin-top:6px">등록된 위치가 없습니다. 관리 → 위치에서 먼저 등록하세요.</p>'}</div>`:''}
      <div class="field"><label>사유 (선택)</label><input id="txReason" placeholder="${mode==='IN'?'예: 정기 입고':mode==='OUT'?'예: 생산 투입':mode==='MOVE'?'예: 랙 재배치':'예: 정기 실사'}"></div>
      ${mode==='IN'?`<button class="btn btn-ghost btn-sm" id="txDetail" style="width:100%;margin-bottom:10px">📷 사진·품질검사가 필요하면 정밀 입고(스캔) →</button>`:''}
      <div class="row"><button class="btn btn-ghost" id="txCancel">취소</button><button class="btn ${BTN[mode]}" id="txGo">${LABEL[mode]}</button></div>
    `);
    document.querySelectorAll('[data-txm]').forEach(b=>b.onclick=()=>{ mode=b.dataset.txm; draw(); });
    { const mB=$('#txMinus'), pB=$('#txPlus'), fl=mode==='ADJUST'?0:1;
      if(mB) mB.onclick=()=>{ const i=$('#txVal'); i.value=Math.max(fl,Number(i.value)-1); };
      if(pB) pB.onclick=()=>{ const i=$('#txVal'); i.value=Number(i.value)+1; }; }
    $('#txCancel').onclick = ()=>closeModal();
    { const dt=$('#txDetail'); if(dt) dt.onclick=()=>{ closeModal(); S.scanTarget={code:it.code,rev:it.rev||''}; S.scanMode='IN'; S._inStatus='정상'; S._inIssue=''; S._inMakeIssue=undefined; S._inPhotos=[]; S._inReason=''; go('scan'); }; }
    $('#txGo').onclick = ()=>busy($('#txGo'), ()=>submitTxSheet(code, rev, mode));
  };
  draw();
}
async function submitTxSheet(code, rev, mode){
  const reason = ($('#txReason')?.value||'').trim();
  try{
    if(mode==='MOVE'){
      const toLoc = $('#txMoveLoc').value;
      if(!toLoc) return toast('이동할 위치를 선택하세요','err');
      await api('tx', { type:'MOVE', code, rev, loc:toLoc, reason });
      toast(`위치 이동 완료 → ${toLoc}`,'ok');
    }else if(mode==='ADJUST'){
      const counted = Math.floor(Number($('#txVal').value));
      if(isNaN(counted)||counted<0) return toast('실사 수량은 0 이상이어야 합니다','err');
      const curStock = Number(findItem(code,rev)?.stock||0);
      if(counted===curStock) return toast('실사 수량이 현재고와 같습니다','err');
      const diff = counted-curStock;
      if(!confirm(`재고 실사 조정\n현재고 ${fmt(curStock)} → 실물 ${fmt(counted)} (${diff>=0?'+':''}${fmt(diff)})\n이대로 조정할까요?`)) return;
      const r = await api('tx', { type:'ADJUST', code, rev, qty:counted, reason });
      toast(`재고 조정 완료 (${diff>=0?'+':''}${fmt(diff)} · 현재고 ${fmt(r.after)})`,'ok');
    }else{
      const qty = Math.floor(Number($('#txVal').value)||0);
      if(qty<1) return toast('수량은 1 이상이어야 합니다','err');
      const loc = mode==='IN' ? $('#txLoc').value : '';
      const r = await api('tx', { type:mode, code, rev, qty, loc, reason });
      toast(mode==='IN'?`입고 +${fmt(qty)} 완료 (현재고 ${fmt(r.after)})`:`출고 −${fmt(qty)} 완료 (현재고 ${fmt(r.after)})`,'ok');
    }
    if(navigator.vibrate) navigator.vibrate(20);
    closeModal(); renderCurrent();   // 처리 후 현재 화면(재고/조정·이동) 즉시 갱신
  }catch(e){ toast(e.message,'err'); }
}

function openAssyDetail(code, rev){
  S._assyView = { code, rev: rev||'' };
  S._assyQty = S._assyQty || 1;
  S._treeOpen = S._treeOpen || new Set();
  openModal('');
  drawAssyModal();
}
function drawAssyModal(){
  const { code, rev } = S._assyView;
  const it = findItem(code, rev);
  if(!it){ closeModal(); return toast('품번을 찾을 수 없습니다','err'); }
  const N = Math.max(1, Number(S._assyQty)||1);
  const buildable = buildableOf(code, rev);
  $('#modalBox').innerHTML = `
    <h3>🔧 조립 · <span style="font-family:var(--mono)">${esc(skuOf(code,rev))}</span></h3>
    <div class="lot-meta" style="margin-bottom:10px">${esc(it.name||'')} · 현재고 <b>${fmt(it.stock)}${esc(it.unit||'')}</b> · 조립가능 <b>${fmt(buildable)}</b></div>
    <div class="field"><label>조립/분해 수량</label>
      <div class="big-qty"><button id="aMinus">−</button><input id="aQty" type="number" min="1" value="${N}" inputmode="numeric"><button id="aPlus">+</button></div></div>
    <div style="font-size:13px;font-weight:600;margin:12px 0 2px">구성품 <span class="muted">(조립 ${N}개 기준 소요)</span></div>
    ${renderBomTree(code, rev, N)}
    <div class="row" style="margin-top:14px">
      <button class="btn btn-out" id="aDisassemble" style="flex:1">분해</button>
      <button class="btn btn-in" id="aAssemble" style="flex:1">조립</button>
    </div>`;
  $('#aMinus').onclick=()=>{ S._assyQty=Math.max(1,N-1); drawAssyModal(); };
  $('#aPlus').onclick =()=>{ S._assyQty=N+1; drawAssyModal(); };
  $('#aQty').onchange =()=>{ S._assyQty=Math.max(1,Number($('#aQty').value)||1); drawAssyModal(); };
  document.querySelectorAll('[data-tree]').forEach(b=>b.onclick=()=>{ const k=b.dataset.tree; S._treeOpen.has(k)?S._treeOpen.delete(k):S._treeOpen.add(k); drawAssyModal(); });
  $('#aAssemble').onclick=()=>busy($('#aAssemble'), ()=>doAssemble(code, rev));
  $('#aDisassemble').onclick=()=>busy($('#aDisassemble'), ()=>doDisassemble(code, rev));
}
async function doAssemble(code, rev){
  const qty = Math.max(1, Number($('#aQty').value)||1);
  try{
    const r = await api('assemble', { code, rev, qty });   // 스냅샷 자동 반영 → S.items/S.bom 갱신
    toast(`조립 +${fmt(qty)} 완료 (현재고 ${fmt(r.after)})`,'ok');
    renderCurrent(); drawAssyModal();
  }catch(e){ toast(e.message,'err'); }
}
async function doDisassemble(code, rev){
  const qty = Math.max(1, Number($('#aQty').value)||1);
  if(!confirm(`${skuOf(code,rev)} ${qty}개를 분해할까요? (조립품 재고 ↓ · 구성품 복원 ↑)`)) return;
  try{
    const r = await api('disassemble', { code, rev, qty });
    toast(`분해 ${fmt(qty)} 완료 (현재고 ${fmt(r.after)})`,'ok');
    renderCurrent(); drawAssyModal();
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
    <div class="seg seg-compact" style="margin-bottom:12px">${seg('users','사용자')}${seg('items','품번')}${seg('bom','BOM')}${seg('locs','위치')}${seg('notify','알림')}${seg('data','데이터')}</div>
    <div id="admBody"></div>`;
  document.querySelectorAll('[data-adm]').forEach(b=>b.onclick=()=>{ S._admTab=b.dataset.adm; renderAdmin(); });
  ({users:admUsers, items:admItems, bom:admBOM, locs:admLocs, notify:admNotify, data:admData})[t]();
}
function admUsers(){
  $('#admBody').innerHTML = `
    <div class="card"><table class="table"><thead><tr><th>아이디</th><th>이름</th><th>역할</th><th></th></tr></thead><tbody>
      ${S.users.map(u=>`<tr><td style="font-family:var(--mono)">${esc(u.id)}</td><td>${esc(u.name)}</td>
        <td><span class="chip ${u.role==='admin'?'chip-move':'chip-gray'}">${u.role==='admin'?'관리자':'사용자'}</span></td>
        <td style="text-align:right">${u.id!=='admin'?`<button class="btn btn-danger btn-sm" data-del-user="${esc(u.id)}">삭제</button>`:''}
        <button class="btn btn-ghost btn-sm" data-pw-user="${esc(u.id)}">비번변경</button></td></tr>`).join('')}
    </tbody></table></div>
    <div class="card"><b style="font-size:14px">사용자 추가</b>
      <div class="row" style="margin-top:10px">
        <div class="field"><label>아이디</label><input id="nuId"></div>
        <div class="field"><label>이름</label><input id="nuName"></div></div>
      <div class="row">
        <div class="field"><label>비밀번호</label><input id="nuPw" type="password"></div>
        <div class="field"><label>역할</label><select id="nuRole"><option value="worker">사용자</option><option value="admin">관리자</option></select></div></div>
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
        <td style="text-align:right;white-space:nowrap"><button class="btn btn-ghost btn-sm" data-edit-item="${esc(i.code)}" data-edit-rev="${esc(i.rev||'')}">수정</button>
        <button class="btn btn-danger btn-sm" data-del-item="${esc(i.code)}" data-del-rev="${esc(i.rev||'')}">삭제</button></td></tr>`).join('')}
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
  document.querySelectorAll('[data-edit-item]').forEach(b=>b.onclick=async ()=>{
    const code=b.dataset.editItem, rev=b.dataset.editRev||'';
    const it = findItem(code, rev);
    if(!it) return toast('대상을 찾을 수 없습니다','err');
    const holder = await lockAcquire('item:'+code+'|'+rev);      // 편집 잠금 확보 (다른 사람이 수정 중이면 차단)
    if(holder) return toast(`${holder.name}님이 수정 중입니다 (${agoText(holder.ageSec)})`,'err');
    S._lockModal = true;                                          // 모달을 닫으면 잠금 해제되도록 표시
    const baseVersion = [it.name, it.unit||'EA', Number(it.safetyStock)||0].join('|');   // 버전 충돌 감지용 (editItem_과 동일 규칙)
    openModal(`<h3>품번 수정 · <span style="font-family:var(--mono)">${esc(skuOf(code,rev))}</span></h3>
      <div class="field"><label>품명</label><input id="eiName" value="${esc(it.name||'')}"></div>
      <div class="row">
        <div class="field"><label>단위</label><input id="eiUnit" value="${esc(it.unit||'EA')}"></div>
        <div class="field"><label>안전재고</label><input id="eiSafe" type="number" min="0" value="${esc(String(it.safetyStock||0))}"></div>
      </div>
      <p class="muted" style="font-size:12px;margin-top:4px">재고 수량·보관위치는 여기서 바꿀 수 없습니다 (스캔 입·출고로만 변동).</p>
      <div class="row" style="margin-top:12px"><button class="btn btn-ghost" id="eiCancel" style="flex:1">취소</button><button class="btn btn-primary" id="eiSave" style="flex:1">저장</button></div>`);
    ['eiName','eiUnit','eiSafe'].forEach(id=>$('#'+id)?.addEventListener('input', lockTouch));   // 타이핑 중 잠금 유지
    $('#eiCancel').onclick = ()=>closeModal();                    // closeModal이 잠금 해제까지 처리
    $('#eiSave').onclick = ()=>busy($('#eiSave'), async ()=>{
      const name=$('#eiName').value.trim();
      if(!name) return toast('품명을 입력하세요','err');
      try{
        await api('editItem', { code, rev, name, unit:$('#eiUnit').value.trim()||'EA', safetyStock:Number($('#eiSafe').value)||0, baseVersion });
        toast('수정 완료','ok'); closeModal(); admItems();        // editItem_이 서버 잠금을 자동 해제, closeModal이 클라 상태 정리
      }catch(e){ toast(e.message,'err'); }
    });
  });
  document.querySelectorAll('[data-del-item]').forEach(b=>b.onclick=async ()=>{
    const code=b.dataset.delItem, rev=b.dataset.delRev||'';
    if(!confirm(`품번 ${skuOf(code,rev)} 를 삭제할까요?`)) return;
    try{ await api('delItem', { code, rev }); toast('삭제 완료','ok'); admItems(); }catch(e){ toast(e.message,'err'); }
  });
}

/* =========================================================
   관리 › BOM (조립 구조)
========================================================= */
/* S.bom 을 부모별로 묶는다 */
function bomParents(){
  const map = {};
  S.bom.forEach(e=>{ const k=bomKey(e.parentCode,e.parentRev); (map[k]=map[k]||{code:e.parentCode,rev:e.parentRev||'',edges:[]}).edges.push(e); });
  return Object.values(map).sort((a,b)=> a.code.localeCompare(b.code) || String(a.rev).localeCompare(String(b.rev)));
}
function admBOM(){
  const parents = bomParents();
  $('#admBody').innerHTML = `
    <div class="card" style="font-size:12.5px;color:var(--t2)">BOM은 <b>부모→자식 소요량</b>으로 조립 구조를 정의합니다. 부모·자식 모두 <b>이미 등록된 품번</b>이어야 하며, 재고는 <b>조립/분해</b>로만 연동됩니다(여기선 구조만 편집). BOM에 자식이 있는 품번이 자동으로 <b>조립품</b>이 됩니다.</div>
    <div class="card">
      <b style="font-size:14px">조립품 목록 <span class="muted">(${parents.length})</span></b>
      ${parents.length? parents.map(p=>{
        const buildable = buildableOf(p.code, p.rev), it = findItem(p.code,p.rev);
        return `<div style="border-top:1px solid var(--line);padding:8px 0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <b style="font-family:var(--mono)">${esc(skuOf(p.code,p.rev))}</b>
            <span class="muted">${esc(it?.name||'(미등록 품번)')}</span>
            <span class="chip chip-gray">구성 ${p.edges.length}</span>
            <span class="chip ${buildable>0?'chip-in':'chip-out'}">조립가능 ${fmt(buildable)}</span>
            <button class="btn btn-ghost btn-sm" style="margin-left:auto" data-bom-edit="${esc(p.code)}" data-bom-rev="${esc(p.rev||'')}">수정</button>
          </div>
          <div style="margin-top:4px">${p.edges.slice().sort((a,b)=>(a.seq||0)-(b.seq||0)).map(e=>`
            <div class="lot-line"><span class="ln" style="font-family:var(--mono)">${esc(skuOf(e.childCode,e.childRev))}</span>
              <span class="muted">${esc(findItem(e.childCode,e.childRev)?.name||'')}${isAssy(e.childCode,e.childRev)?' 🔧':''}</span>
              <span class="q">×${fmt(e.qtyPer)}</span>
              <button class="btn btn-danger btn-sm" style="margin-left:8px" data-bom-del="${esc(e.id)}">삭제</button></div>`).join('')}</div>
        </div>`;
      }).join('') : '<div class="empty" style="margin-top:8px"><b>등록된 BOM이 없습니다</b>아래에서 붙여넣기로 등록하세요.</div>'}
    </div>
    <div class="card"><b style="font-size:14px">📥 BOM 일괄 붙여넣기</b>
      <p class="muted" style="margin:6px 0 10px">엑셀/시트에서 <b>부모품번 · 자식품번 · 소요량</b> 3열(탭 구분)로 복사해 붙여넣으세요. 한 줄에 한 구성. <b>Rev은 자동으로 최신 리비전</b>이 적용됩니다. 특정 Rev이 필요할 때만 품번 칸에 <b style="font-family:var(--mono)">RP-303-013 (C)</b> 처럼 입력하세요.</p>
      <textarea id="bomText" rows="5" placeholder="RP-300-000&#9;A&#9;RP-303-013&#9;D&#9;2&#10;RP-300-000&#9;A&#9;RG-101-002&#9;A&#9;4" style="width:100%;padding:10px;border:1.5px solid var(--bd);border-radius:9px;font-family:var(--mono);font-size:13px;white-space:pre;overflow-x:auto"></textarea>
      <button class="btn btn-primary" id="bomBulkAdd" style="width:100%;margin-top:10px">붙여넣은 BOM 일괄 등록</button>
      <div id="bomResult"></div></div>
    <div class="card"><b style="font-size:14px">구성 1건 추가</b>
      <p class="muted" style="margin:6px 0 2px">Rev은 각 품번의 <b>최신 리비전</b>이 자동 적용됩니다. 특정 Rev이 필요할 때만 품번 칸에 <b style="font-family:var(--mono)">RP-303-013 (C)</b> 처럼 입력하세요.</p>
      <div class="row" style="margin-top:8px">
        <div class="field" style="flex:2"><label>부모 품번</label><input id="b1pc" placeholder="RP-300-000" style="text-transform:uppercase"></div>
        <div class="field"><label>소요량</label><input id="b1q" type="number" min="1" value="1"></div></div>
      <div class="field"><label>자식 품번</label><input id="b1cc" placeholder="RP-303-013" style="text-transform:uppercase"></div>
      <div id="b1info" class="muted" style="margin:-4px 0 8px;min-height:16px"></div>
      <button class="btn btn-primary" id="b1add">추가</button></div>`;
  document.querySelectorAll('[data-bom-del]').forEach(b=>b.onclick=async ()=>{
    if(!confirm('이 구성을 삭제할까요?')) return;
    try{ await api('delBOM', { id:b.dataset.bomDel }); toast('삭제 완료','ok'); admBOM(); }catch(e){ toast(e.message,'err'); }
  });
  document.querySelectorAll('[data-bom-edit]').forEach(b=>b.onclick=()=>openBomEdit(b.dataset.bomEdit, b.dataset.bomRev||''));
  $('#bomBulkAdd').onclick = ()=>busy($('#bomBulkAdd'), async ()=>{
    const rows = ($('#bomText').value||'').replace(/\r/g,'').split('\n').map(l=>l.split('\t').map(c=>c.trim())).filter(c=>c.join('')!=='')
      .map(c=>{
        let pc=c[0]||'', cc=c[1]||'', q=c[2]||'', pr='', cr='';
        const pp=parseScan(pc); if(pp.rev){ pc=pp.code; pr=pp.rev; }   // "(C)" 인라인 리비전만 특정 지정
        const cp=parseScan(cc); if(cp.rev){ cc=cp.code; cr=cp.rev; }
        pc=pc.toUpperCase(); cc=cc.toUpperCase();
        if(!pr) pr=latestRevOf(pc);   // Rev 비었으면 최신 리비전 자동 적용
        if(!cr) cr=latestRevOf(cc);
        return { parentCode:pc, parentRev:pr, childCode:cc, childRev:cr, qtyPer:Number(q)||0 };
      });
    if(!rows.length) return toast('붙여넣은 BOM이 없습니다','err');
    try{
      const r = await api('bulkAddBOM', { rows });
      const okN = r.results.filter(x=>x.ok).length, fails = r.results.filter(x=>!x.ok);
      toast(`BOM ${okN}건 등록${fails.length?` · ${fails.length}건 실패`:''}`, fails.length?'err':'ok');
      $('#bomResult').innerHTML = fails.length
        ? `<div style="margin-top:10px;font-size:12.5px;color:var(--out)"><b>실패 ${fails.length}건</b>${fails.map(x=>`<div>· ${esc(skuOf(x.parentCode||'',x.parentRev||''))} → ${esc(skuOf(x.childCode||'',x.childRev||''))} — ${esc(x.error)}</div>`).join('')}</div>`
        : '';
      if(okN) setTimeout(admBOM, 900);
    }catch(e){ toast(e.message,'err'); }
  });
  // 입력한 품번에 대해 자동 적용될 리비전을 실시간으로 미리보기
  const b1preview = ()=>{
    const pv = $('#b1pc').value.trim(), cv = $('#b1cc').value.trim();
    if(!pv && !cv){ $('#b1info').innerHTML=''; return; }
    const parts = [];
    if(pv){ const r=resolveBomRef(pv); parts.push(`부모 <b style="font-family:var(--mono)">${esc(skuOf(r.code,r.rev))}</b>${!findItem(r.code,r.rev)?' <span style="color:var(--out)">미등록</span>':''}`); }
    if(cv){ const r=resolveBomRef(cv); parts.push(`자식 <b style="font-family:var(--mono)">${esc(skuOf(r.code,r.rev))}</b>${!findItem(r.code,r.rev)?' <span style="color:var(--out)">미등록</span>':''}`); }
    $('#b1info').innerHTML = '→ ' + parts.join(' · ');
  };
  $('#b1pc').oninput = b1preview; $('#b1cc').oninput = b1preview;
  $('#b1add').onclick = ()=>busy($('#b1add'), async ()=>{
    const pr = resolveBomRef($('#b1pc').value.trim()), cr = resolveBomRef($('#b1cc').value.trim());
    if(!pr.code || !cr.code) return toast('부모·자식 품번을 입력하세요','err');
    try{
      await api('addBOM', { parentCode:pr.code, parentRev:pr.rev, childCode:cr.code, childRev:cr.rev, qtyPer:Number($('#b1q').value)||0 });
      toast(`구성 추가 완료 · ${skuOf(cr.code,cr.rev)}`,'ok'); admBOM();
    }catch(e){ toast(e.message,'err'); }
  });
}
/* 부모 단위 BOM 편집 (soft-lock + 버전 충돌) — setBOMParent 로 전체 교체 */
async function openBomEdit(code, rev){
  const holder = await lockAcquire('bom:'+bomKey(code,rev));
  if(holder) return toast(`${holder.name}님이 수정 중입니다 (${agoText(holder.ageSec)})`,'err');
  S._lockModal = true;
  const edges = bomChildrenOf(code, rev);
  const baseVersion = edges.map(e=>bomKey(e.childCode,e.childRev)+':'+(Number(e.qtyPer)||0)).sort().join(',');   // setBOMParent_ 와 동일 규칙
  S._bomEdit = { code, rev:rev||'', baseVersion, rows: edges.map(e=>({ childCode:e.childCode, childRev:e.childRev||'', qtyPer:Number(e.qtyPer)||0 })) };
  if(!S._bomEdit.rows.length) S._bomEdit.rows=[{childCode:'',childRev:'',qtyPer:1}];
  openModal('');
  drawBomEdit();
}
function bomEditRow(r,i){
  const cell='padding:6px 8px;border:1.5px solid var(--bd);border-radius:7px;background:var(--sf)';
  return `<tr data-berow="${i}">
    <td><input data-bef="childCode" value="${esc(r.childCode)}" placeholder="품번" style="width:100%;font-family:var(--mono);text-transform:uppercase;${cell}"></td>
    <td><input data-bef="childRev" value="${esc(r.childRev)}" placeholder="Rev" style="width:100%;text-align:center;text-transform:uppercase;font-family:var(--mono);${cell}"></td>
    <td><input data-bef="qtyPer" value="${esc(String(r.qtyPer))}" type="number" min="1" style="width:100%;text-align:right;${cell}"></td>
    <td style="text-align:center"><button data-bedel="${i}" style="color:var(--t3);font-size:15px">✕</button></td></tr>`;
}
function drawBomEdit(){
  const { code, rev, rows } = S._bomEdit;
  $('#modalBox').innerHTML = `
    <h3>BOM 수정 · <span style="font-family:var(--mono)">${esc(skuOf(code,rev))}</span></h3>
    <p class="muted" style="font-size:12px">자식 구성품과 소요량을 편집합니다. 저장하면 이 부모의 BOM 전체가 교체됩니다.</p>
    <div style="overflow-x:auto"><table class="table"><thead><tr><th>자식 품번</th><th style="width:56px">Rev</th><th style="width:72px">소요량</th><th style="width:28px"></th></tr></thead>
    <tbody id="bomEditBody">${rows.map(bomEditRow).join('')}</tbody></table></div>
    <button class="btn btn-ghost btn-sm" id="bomAddRow" style="margin-top:8px">＋ 자식 추가</button>
    <div class="row" style="margin-top:12px"><button class="btn btn-ghost" id="bomCancel" style="flex:1">취소</button><button class="btn btn-primary" id="bomSave" style="flex:1">저장</button></div>`;
  bindBomEdit();
}
function bindBomEdit(){
  document.querySelectorAll('#bomEditBody [data-bef]').forEach(el=>{
    const i=Number(el.closest('[data-berow]').dataset.berow), f=el.dataset.bef;
    el.addEventListener('input', ()=>{ S._bomEdit.rows[i][f]=el.value; lockTouch(); });   // 재렌더 없이 상태만(포커스 보존)
  });
  document.querySelectorAll('#bomEditBody [data-bedel]').forEach(b=>b.onclick=()=>{
    S._bomEdit.rows.splice(Number(b.dataset.bedel),1);
    if(!S._bomEdit.rows.length) S._bomEdit.rows=[{childCode:'',childRev:'',qtyPer:1}];
    drawBomEdit();
  });
  $('#bomAddRow').onclick=()=>{ S._bomEdit.rows.push({childCode:'',childRev:'',qtyPer:1}); drawBomEdit(); };
  $('#bomCancel').onclick=()=>closeModal();   // closeModal 이 잠금 해제 처리
  $('#bomSave').onclick=()=>busy($('#bomSave'), async ()=>{
    const { code, rev, baseVersion, rows } = S._bomEdit;
    const children = rows.map(r=>{
      const ps=parseScan(r.childCode); let cc=ps.code, cr=String(r.childRev||'').trim().toUpperCase();
      if(ps.rev && !cr) cr=ps.rev;
      return { childCode:cc, childRev:cr, qtyPer:Number(r.qtyPer)||0 };
    }).filter(r=>r.childCode);
    try{
      await api('setBOMParent', { parentCode:code, parentRev:rev, children, baseVersion });
      toast('BOM 저장 완료','ok'); closeModal(); admBOM();   // setBOMParent_ 가 서버 잠금 자동 해제
    }catch(e){ toast(e.message,'err'); }
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
  initTheme();
  $('#themeBtn').onclick = toggleTheme;
  $('#apiUrl').value = DEFAULT_API_URL || recall('ims_api');
  // 기본 서버 주소가 지정돼 있으면 로그인 화면에서 주소 입력칸을 숨긴다
  if(DEFAULT_API_URL){ const f = $('#apiUrl').closest('.field'); if(f) f.style.display='none'; }
  $('#loginId').value = recall('ims_id');
  $('#loginBtn').onclick = doLogin;
  $('#loginPw').addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
  $('#logoutBtn').onclick = doLogout;
  $('#refreshBtn').onclick = refreshNow;
  $('#errHelpLink').onclick = openErrorHelp;
})();
