/* =========================================================
   문서함 (Google Drive 연동)
========================================================= */
function renderDoc(){
  $('#main').innerHTML = `
    <div class="sec-title">📁 문서함 <small>로트별 사진·문서 보관 (Google Drive)</small></div>
    <div class="searchbar"><input id="docLotQ" placeholder="로트번호 입력 후 조회" value="${esc(S._docLot||'')}"><button class="btn btn-ghost" id="docGo">조회</button></div>
    <div id="docBody">${S._docLot?'':'<div class="empty"><b>로트번호를 입력하세요</b>해당 로트에 첨부된 문서·사진을 확인하고 새로 업로드할 수 있습니다.</div>'}</div>`;
  $('#docGo').onclick = ()=>loadDocLot($('#docLotQ').value.trim());
  $('#docLotQ').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); loadDocLot(e.target.value.trim()); }});
  if(S._docLot) loadDocLot(S._docLot);
}
async function loadDocLot(lotNo){
  if(!lotNo) return;
  S._docLot = lotNo;
  const lot = lotOf(lotNo);
  $('#docBody').innerHTML = '<div class="empty">불러오는 중…</div>';
  if(!lot){ $('#docBody').innerHTML = `<div class="empty"><b>등록되지 않은 로트입니다</b>로트번호를 다시 확인하세요.</div>`; return; }
  try{
    const r = await api('listDocs', { lotNo }, {noApply:true});
    drawDocBody(lot, r.docs);
  }catch(e){ toast(e.message,'err'); }
}
function drawDocBody(lot, docs){
  const it = itemOf(lot.itemCode);
  $('#docBody').innerHTML = `
    <div class="lot-tag"><div class="lot-no">${esc(lot.lotNo)}</div><div class="lot-meta">${esc(it?.name||lot.itemCode)} · 현재고 ${fmt(lot.qty)}${esc(it?.unit||'')} · 📍${esc(lot.location||'위치 미지정')}</div></div>
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
      const r = await api('uploadDoc', Object.assign({ lotNo: lot.lotNo, category: $('#docCat').value }, pending), {noApply:true});
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
      <div class="field"><label>로트번호 (선택 — 로트와 무관한 신고는 비워두세요)</label>
        <input id="isLot" placeholder="예: BRKT01-20260714-001" value="${esc(S._isLot||'')}"></div>
      <div id="isLotInfo"></div>
      <div class="field"><label>심각도</label>
        <div class="sev-seg">${['경미','중대','긴급'].map(s=>`<button data-sev="${s}" class="sev-${s} ${S._issueSev===s?'on':''}">${s}</button>`).join('')}</div></div>
      <div class="field"><label>제목</label><input id="isTitle" placeholder="예: 포장 파손 발견"></div>
      <div class="field"><label>상세 내용</label><textarea id="isDesc" rows="4" placeholder="발생 상황을 구체적으로 적어주세요" style="width:100%;padding:10px;border:1.5px solid var(--line);border-radius:9px"></textarea></div>
      <label class="upload-drop" id="isDrop">📷 사진 첨부 (선택, 탭하여 촬영/선택)
        <input type="file" id="isFile" accept="image/*" capture="environment" style="display:none"></label>
      <img id="isPrev" class="thumb-prev hidden">
      <button class="btn btn-out" style="width:100%;margin-top:12px" id="isSubmit">신고 접수</button>
    </div>`;
  document.querySelectorAll('[data-sev]').forEach(b=>b.onclick=()=>{ S._issueSev=b.dataset.sev; drawIssueForm(); });
  const showLotInfo = v=>{
    const lot = lotOf(v.trim());
    $('#isLotInfo').innerHTML = !v.trim() ? '' : lot
      ? `<p class="muted" style="margin:-6px 0 10px">${esc(itemOf(lot.itemCode)?.name||lot.itemCode)} · 현재고 ${fmt(lot.qty)}${esc(itemOf(lot.itemCode)?.unit||'')}</p>`
      : `<p class="muted" style="margin:-6px 0 10px;color:var(--out)">일치하는 로트를 찾을 수 없습니다</p>`;
  };
  $('#isLot').oninput = e=>{ S._isLot=e.target.value; showLotInfo(e.target.value); };
  showLotInfo(S._isLot||'');
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
    const lotNo = $('#isLot').value.trim();
    if(lotNo && !lotOf(lotNo)) return toast('일치하는 로트가 없습니다','err');
    try{
      const payload = { lotNo, severity:S._issueSev, title, description:$('#isDesc').value.trim() };
      if(pending) Object.assign(payload, pending);
      await api('reportIssue', payload);
      toast('신고가 접수되었습니다','ok');
      S._isLot=''; S._issueSev='경미'; S._issueTab='list';
      renderIssue();
    }catch(e){ toast(e.message,'err'); }
  });
}
async function drawIssueList(){
  $('#issueBody').innerHTML = '<div class="empty">불러오는 중…</div>';
  const f = S._issueStatusF || 'ALL';
  try{
    const r = await api('listIssues', { status:f }, {noApply:true});
    $('#issueBody').innerHTML = `
      <div class="searchbar"><select id="issF" style="flex:1">${['ALL','접수','처리중','완료'].map(s=>`<option value="${s}" ${f===s?'selected':''}>${s==='ALL'?'전체 상태':s}</option>`).join('')}</select></div>
      ${r.issues.length? r.issues.map(issueCard).join('') : '<div class="empty"><b>신고 내역이 없습니다</b></div>'}`;
    $('#issF').onchange = e=>{ S._issueStatusF = e.target.value; drawIssueList(); };
    bindIssueEvents();
  }catch(e){ toast(e.message,'err'); }
}
function issueCard(i){
  return `<div class="issue-card" data-issue="${esc(i.id)}">
    <div class="ihead">
      <span class="chip chip-sev-${esc(i.severity)}">${esc(i.severity)}</span>
      <span class="chip chip-st-${esc(i.status)}">${esc(i.status)}</span>
      <span class="ititle">${esc(i.title)}</span>
    </div>
    ${i.lotNo?`<div class="muted">로트 ${esc(i.lotNo)} · ${esc(itemOf(i.itemCode)?.name||i.itemCode||'')}</div>`:''}
    ${i.description?`<div class="idesc">${esc(i.description)}</div>`:''}
    ${i.photoThumb?`<a href="${i.photoView}" target="_blank" rel="noopener"><img src="${i.photoThumb}" loading="lazy"></a>`:''}
    <div class="imeta">신고 ${esc(i.reportedBy)} · ${new Date(i.reportedAt).toLocaleString('ko-KR')}${i.updatedAt?` · 최종수정 ${esc(i.updatedBy)} ${new Date(i.updatedAt).toLocaleDateString('ko-KR')}`:''}</div>
    ${i.resolutionNote?`<div class="muted" style="margin-top:4px">💬 ${esc(i.resolutionNote)}</div>`:''}
    ${i.status!=='완료'?`
    <div class="issue-actions">
      <select data-st-sel="${esc(i.id)}"><option value="접수" ${i.status==='접수'?'selected':''}>접수</option><option value="처리중" ${i.status==='처리중'?'selected':''}>처리중</option><option value="완료">완료</option></select>
      <input type="text" data-note="${esc(i.id)}" placeholder="처리 메모 (선택)" style="flex:1;min-width:110px;padding:8px 10px;border:1.5px solid var(--line);border-radius:8px;font-size:13px">
      <button class="btn btn-primary btn-sm" data-save-issue="${esc(i.id)}">저장</button>
    </div>`:''}
  </div>`;
}
function bindIssueEvents(){
  document.querySelectorAll('[data-save-issue]').forEach(b=>b.onclick=()=>busy(b, async ()=>{
    const id = b.dataset.saveIssue;
    const status = document.querySelector(`[data-st-sel="${id}"]`).value;
    const note = document.querySelector(`[data-note="${id}"]`).value.trim();
    try{ await api('updateIssue', { id, status, resolutionNote:note }); toast('업데이트 완료','ok'); drawIssueList(); }
    catch(e){ toast(e.message,'err'); }
  }));
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
  $('#main').innerHTML = `
    <div class="sec-title">📊 리포트 · 대시보드</div>
    <div class="kpi-grid">
      <div class="kpi"><b>${fmt(rep.totalItems)}</b><span>등록 품목</span></div>
      <div class="kpi"><b>${fmt(rep.totalLots)}</b><span>활성 로트</span></div>
      <div class="kpi ${rep.lowStockCount?'warn':''}"><b>${fmt(rep.lowStockCount)}</b><span>안전재고 미달</span></div>
      <div class="kpi ${rep.openIssueCount?'bad':''}"><b>${fmt(rep.openIssueCount)}</b><span>미해결 품질신고</span></div>
    </div>
    <div class="chart-card">
      <h4>품목별 재고 (상위 ${top.length}개)</h4>
      ${top.length ? top.map(t=>`
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12.5px">
          <div style="width:74px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</div>
          <div style="flex:1;background:#EEF1F4;border-radius:5px;overflow:hidden;height:16px">
            <div style="width:${Math.max(3,t.qty/maxQty*100)}%;height:100%;background:${t.safetyStock>0&&t.qty<t.safetyStock?'var(--out)':'var(--ink)'};border-radius:5px"></div>
          </div>
          <div style="width:56px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums">${fmt(t.qty)}${esc(t.unit)}</div>
        </div>`).join('') : '<div class="muted">데이터 없음</div>'}
    </div>
    <div class="chart-card">
      <h4>최근 14일 입·출고 추이</h4>
      ${trendChart(rep.trend, maxTrend)}
      <div style="display:flex;gap:14px;margin-top:8px;font-size:11.5px;color:#7A8494"><span>🟩 입고</span><span>🟥 출고</span></div>
    </div>
    <div class="looker-card">
      📈 <b>더 깊은 분석이 필요하신가요?</b><br>
      연결된 구글 시트에는 품목명·창고 등이 미리 조인된 <b>Report_Stock</b> / <b>Report_Tx</b> 탭이
      자동으로 최신 상태로 유지됩니다. <a href="https://lookerstudio.google.com" target="_blank" rel="noopener">Looker Studio</a>
      에서 구글 시트 커넥터로 이 두 탭을 연결하면 기간별 추이, 재고 회전율, 창고별 비교 같은
      더 정교한 대시보드를 코드 없이 만들고 팀과 공유할 수 있습니다.
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
        <div style="font-size:8px;color:#98A2B3">${esc(d.date.slice(5))}</div>
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
      <p class="muted" style="margin:6px 0 10px">매일 지정 시각에 안전재고 미달·유통기한 임박·미해결 신고 요약을 이메일로 발송합니다.</p>
      <div class="field"><label>수신 이메일 (쉼표로 구분)</label><input id="ntEmails" value="${esc(s.alertEmails)}" placeholder="a@company.com, b@company.com"></div>
      <div class="row">
        <div class="field"><label>유통기한 임박 기준(일)</label><input id="ntWarnDays" type="number" min="1" value="${esc(s.expiryWarnDays)}"></div>
        <div class="field"><label>발송 시각 (0~23시)</label><input id="ntHour" type="number" min="0" max="23" value="${esc(s.alertHour)}"></div>
      </div>
      <div class="row"><button class="btn btn-ghost" id="ntEmailTest">지금 테스트 발송</button><button class="btn btn-primary" id="ntSave">저장</button></div>
      <button class="btn btn-ghost" style="width:100%;margin-top:8px" id="ntInstall">⏰ 일일 알림 자동 발송 설치</button>
      <p class="muted" style="margin-top:6px">설치 후 매일 지정 시각에 자동 실행됩니다. 시각·기준일을 바꾼 뒤에는 다시 설치를 눌러 갱신하세요.</p>
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
    try{ await api('setSettings', { settings:{ alertEmails:$('#ntEmails').value.trim(), expiryWarnDays:$('#ntWarnDays').value, alertHour:$('#ntHour').value } }, {noApply:true}); toast('저장 완료','ok'); }
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
   관리 › 메모 (개발로그) — 개발 방향·결정사항·할 일·버그를 타임라인으로 기록
========================================================= */
const DEVLOG_META = {
  '아이디어':{ ic:'💡', chip:'chip-warn' },
  '결정':    { ic:'✅', chip:'chip-in' },
  '할일':    { ic:'📌', chip:'chip-move' },
  '버그':    { ic:'🐛', chip:'chip-out' },
};
function admDevLog(){
  $('#admBody').innerHTML = '<div class="empty">불러오는 중…</div>';
  loadDevLog();
}
async function loadDevLog(){
  const f = S._devlogF || 'ALL';
  try{ const r = await api('listDevLog', { category:f }, {noApply:true}); drawDevLog(r.logs); }
  catch(e){ toast(e.message,'err'); }
}
function drawDevLog(logs){
  const f = S._devlogF || 'ALL';
  $('#admBody').innerHTML = `
    <div class="card">
      <b style="font-size:14px">📝 새 기록 추가</b>
      <p class="muted" style="margin:6px 0 10px">개발 방향, 결정 이유, 할 일, 버그를 시간순으로 남겨두는 팀 개발로그입니다. 구글 시트 DevLog 탭에 그대로 저장됩니다.</p>
      <div class="row">
        <div class="field"><label>분류</label><select id="dlCat">${Object.keys(DEVLOG_META).map(c=>`<option>${c}</option>`).join('')}</select></div>
        <div class="field" style="flex:2"><label>제목</label><input id="dlTitle" placeholder="예: 로트 다중 위치 보관 지원 검토"></div>
      </div>
      <div class="field"><label>내용 (선택)</label><textarea id="dlContent" rows="3" placeholder="배경, 이유, 참고 링크 등을 자유롭게 적어두세요" style="width:100%;padding:10px;border:1.5px solid var(--line);border-radius:9px"></textarea></div>
      <button class="btn btn-primary" id="dlAdd" style="width:100%">기록 추가</button>
    </div>
    <div class="searchbar"><select id="dlFilter" style="flex:1">${['ALL',...Object.keys(DEVLOG_META)].map(c=>`<option value="${c}" ${f===c?'selected':''}>${c==='ALL'?'전체':c}</option>`).join('')}</select></div>
    <div id="dlList">${logs.length? logs.map(devLogCard).join('') : '<div class="empty"><b>기록이 없습니다</b>개발 방향, 결정 사항, 할 일을 남겨보세요.</div>'}</div>`;
  $('#dlFilter').onchange = e=>{ S._devlogF = e.target.value; loadDevLog(); };
  $('#dlAdd').onclick = ()=>busy($('#dlAdd'), async ()=>{
    const title = $('#dlTitle').value.trim();
    if(!title) return toast('제목을 입력하세요','err');
    try{
      const r = await api('addDevLog', { category:$('#dlCat').value, title, content:$('#dlContent').value.trim() }, {noApply:true});
      toast('기록이 추가되었습니다','ok');
      $('#dlTitle').value=''; $('#dlContent').value='';
      renderDevLogList(r.logs);
    }catch(e){ toast(e.message,'err'); }
  });
  bindDevLogEvents();
}
function renderDevLogList(logs){
  $('#dlList').innerHTML = logs.length? logs.map(devLogCard).join('') : '<div class="empty"><b>기록이 없습니다</b></div>';
  bindDevLogEvents();
}
function devLogCard(l){
  const m = DEVLOG_META[l.category] || { ic:'📝', chip:'chip-gray' };
  const doneToggle = (l.category==='할일'||l.category==='버그') ? `
    <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:#7A8494;margin-left:auto;white-space:nowrap">
      <input type="checkbox" data-done="${esc(l.id)}" ${l.done?'checked':''}> ${l.category==='버그'?'해결됨':'완료'}
    </label>` : '';
  return `<div class="issue-card" style="${l.done?'opacity:.6':''}">
    <div class="ihead">
      <span class="chip ${m.chip}">${m.ic} ${esc(l.category)}</span>
      <span class="ititle" style="${l.done?'text-decoration:line-through':''}">${esc(l.title)}</span>
      ${doneToggle}
    </div>
    ${l.content?`<div class="idesc">${esc(l.content).replace(/\n/g,'<br>')}</div>`:''}
    <div class="imeta">${esc(l.author)} · ${new Date(l.ts).toLocaleString('ko-KR')}
      <button class="btn btn-danger btn-sm" style="margin-left:8px" data-del-log="${esc(l.id)}">삭제</button>
    </div>
  </div>`;
}
function bindDevLogEvents(){
  document.querySelectorAll('[data-done]').forEach(cb=>cb.onchange=async ()=>{
    try{ const r = await api('updateDevLog', { id:cb.dataset.done, done:cb.checked }, {noApply:true}); renderDevLogList(r.logs); }
    catch(e){ toast(e.message,'err'); }
  });
  document.querySelectorAll('[data-del-log]').forEach(b=>b.onclick=async ()=>{
    if(!confirm('이 기록을 삭제할까요?')) return;
    try{ const r = await api('delDevLog', { id:b.dataset.delLog }, {noApply:true}); toast('삭제 완료','ok'); renderDevLogList(r.logs); }
    catch(e){ toast(e.message,'err'); }
  });
}
