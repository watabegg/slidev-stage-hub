(async () => {
  const role = new URLSearchParams(location.search).get('role');
  document.body.classList.add(role);
  const invoke = window.__TAURI__.core.invoke;
  const listen = window.__TAURI__.event.listen;
  const el = id => document.getElementById(id);
  let viewerOrigin='deck://localhost';
  let state, registry, sequence=Date.now()*1000, currentUrl='', noteView, notesDirty=false;
  const rendered=new Map();
  const drafts=new Map(); const noteKey=(id,page)=>`${id}:${page}`;
  const editing = target => target instanceof Element && !!target.closest('input,textarea,select,[contenteditable=true],[contenteditable=""]');
  async function action(kind,value) {
    if (notesDirty && kind !== 'toggleBlackout') { el('note-status').textContent='保存後にページを移動してください'; return; }
    try { const next=await invoke('transition',{input:{source:role,sequence:++sequence,editing:false,action:value === undefined ? {kind} : {kind,value}}}); await render(next); }
    catch(error) { el('status').textContent=String(error); }
  }
  async function render(next) {
    if (state && next.sessionRevision < state.sessionRevision) return;
    const previous=state;
    if (previous && notesDirty && noteView && (previous.deckId!==next.deckId || previous.page!==next.page)) drafts.set(noteKey(previous.deckId,previous.page),{text:el('notes').value,view:{...noteView}});
    state=next;
    const url=`${viewerOrigin}/${state.deckId}/${state.page}?clicks=${state.clickIndex}&embedded=true`;
    if (url !== currentUrl) { currentUrl=url; el('deck').src=url; }
    el('blackout').style.display=state.blackout ? 'block' : 'none';
    el('status').textContent=`${state.deckId} · ${state.page}頁 · click ${state.clickIndex}`;
    el('page').textContent=`${state.page} / ${registry.find(d=>d.id===state.deckId).clickTotals.length}`;
    if(role==='presenter'){
      const pages=registry.find(d=>d.id===state.deckId).clickTotals.length;
      el('next-preview').hidden=state.page>=pages;el('next-heading').textContent=state.page>=pages ? '次のスライドはありません' : '次スライド · 操作無効';
      const previewUrl=`${viewerOrigin}/${state.deckId}/${Math.min(state.page+1,pages)}?clicks=0&embedded=true&nativePreview=true`;
      if(el('next-preview').getAttribute('src')!==previewUrl)el('next-preview').src=previewUrl;
    }
    el('revision').textContent=`session ${state.sessionRevision}`; el('decks').value=state.deckId;
    if (role !== 'presenter' || (previous && previous.page===state.page && previous.deckId===state.deckId)) return;
    noteView=undefined; notesDirty=false; el('notes').value=''; el('notes').disabled=true; el('save').disabled=true;
    const deckId=state.deckId, page=state.page;
    try {
      const view=await invoke('read_notes',{deckId,page});
      if (state.deckId!==deckId || state.page!==page) return;
      const draft=drafts.get(noteKey(deckId,page));
      noteView=draft?.view || view; el('notes').value=draft?.text || view.text; el('notes').disabled=false;
      notesDirty=!!draft; el('save').disabled=!draft; el('note-status').textContent=draft ? '未保存の下書きを復元' : drafts.size ? `別ページの未保存下書き ${drafts.size} 件` : 'ローカルソースの既存コメント';
    } catch(error) { el('note-status').textContent=String(error); }
  }
  const initial=await invoke('snapshot'); registry=initial.decks;viewerOrigin=initial.viewerOrigin;
  el('decks').replaceChildren(...registry.map(d=>Object.assign(document.createElement('option'),{value:d.id,textContent:d.id})));
  await listen('session', event=>render(event.payload)); await render(initial.session);
  window.addEventListener('message', event=>{
    if (event.source !== el('deck').contentWindow) return;
    // WebKit custom protocols can report a null origin. Identity is the fixed
    // controlled frame WindowProxy; remote navigation is blocked in its CSP.
    if (!(event.origin === 'null' || event.origin === viewerOrigin)) return;
    if (event.data.nativeInput) action(event.data.nativeInput);
    if (event.data.nativeDiagnostic) invoke('viewer_ready',{report:{diagnostic:event.data.nativeDiagnostic,origin:event.origin}}).catch(console.error);
    if (event.data.nativeRendered) {rendered.set(event.data.nativeRendered.url,event.data.nativeRendered);invoke('viewer_ready',{report:{...event.data.nativeRendered,origin:event.origin}}).catch(console.error);}
  });
  window.addEventListener('keydown',event=>{
    if (editing(event.target) || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    const kind=['ArrowRight','ArrowDown',' ','Enter','PageDown'].includes(event.key)?'next':['ArrowLeft','ArrowUp','Backspace','PageUp'].includes(event.key)?'previous':['b','B','.'].includes(event.key)?'toggleBlackout':null;
    if(kind){event.preventDefault();event.stopImmediatePropagation();action(kind);}
  },true);
  document.querySelectorAll('[data-action]').forEach(button=>button.onclick=()=>action(button.dataset.action));
  el('decks').onchange=()=>action('selectDeck',el('decks').value);
  el('notes').oninput=()=>{notesDirty=true;el('save').disabled=false;el('note-status').textContent='未保存';};
  el('save').onclick=async()=>{
    if (!noteView) return;
    try { const saving={...noteView},text=el('notes').value; const revision=await invoke('save_notes',{deckId:saving.deckId,page:saving.page,expectedRevision:saving.revision,text});drafts.delete(noteKey(saving.deckId,saving.page));if(state.deckId===saving.deckId && state.page===saving.page){noteView.revision=revision;notesDirty=false;el('save').disabled=true;el('note-status').textContent='保存済み';} }
    catch(error){el('note-status').textContent=String(error);}
  };
  setInterval(()=>{if(!state?.timer)return;const elapsed=state.timer.elapsedMs+(state.timer.startedAt===null?0:Math.max(0,Date.now()-state.timer.startedAt));const secs=Math.floor(elapsed/1000);el('timer').textContent=`${String(Math.floor(secs/60)).padStart(2,'0')}:${String(secs%60).padStart(2,'0')}`;},200);
  window.__nativePoc={action,invoke,getState:()=>state,getDrafts:()=>Object.fromEntries(drafts),rendered,getOrigin:()=>viewerOrigin};
  if(role==='presenter') {
    try { const monitors=await invoke('displays'); el('displays').replaceChildren(...monitors.map(m=>Object.assign(document.createElement('option'),{value:String(m.index),textContent:`${m.name || 'Display '+m.index} · ${m.width}×${m.height}`}))); el('display-status').textContent=`${monitors.length} displays detected; OSによる移動制約は反映結果を確認`; }
    catch(error){el('display-status').textContent=String(error);}
    el('note-size').oninput=()=>{el('notes').style.fontSize=el('note-size').value+'px';};
    el('swap').onclick=async()=>{try{el('display-status').textContent=await invoke('swap_windows');}catch(error){el('display-status').textContent=String(error);}};
    el('apply-display').onclick=async()=>{try{el('display-status').textContent=await invoke('audience_display',{index:el('displays').value ? Number(el('displays').value):null,fullscreen:el('fullscreen').checked});}catch(error){el('display-status').textContent=String(error);}};
  }
})();
