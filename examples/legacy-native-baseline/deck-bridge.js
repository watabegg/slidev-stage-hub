(() => {
  let diagnosticCount=0;for(const method of ['error','warn']){const original=console[method].bind(console);console[method]=(...args)=>{original(...args);if(diagnosticCount++<20)parent.postMessage({nativeDiagnostic:{console:method,message:args.map(String).join(' ').slice(0,1200)}},'*');};}
  window.addEventListener('error',event=>parent.postMessage({nativeDiagnostic:{error:event.message || 'resource error',source:event.filename || event.target?.src || event.target?.href}},'*'),true);
  window.addEventListener('unhandledrejection',event=>parent.postMessage({nativeDiagnostic:{rejection:String(event.reason)}},'*'));
  // Local frame only: Slidev must not become a competing cross-window authority.
  window.BroadcastChannel = class { constructor() {} addEventListener() {} removeEventListener() {} postMessage() {} close() {} };
  const preview=new URLSearchParams(location.search).has('nativePreview');
  const editing = target => target instanceof Element && !!target.closest('input,textarea,select,[contenteditable=true],[contenteditable=""]');
  const actionFor = key => ['ArrowRight', 'ArrowDown', ' ', 'Enter', 'PageDown'].includes(key) ? 'next' : ['ArrowLeft', 'ArrowUp', 'Backspace', 'PageUp'].includes(key) ? 'previous' : ['b','B','.'].includes(key) ? 'toggleBlackout' : null;
  window.addEventListener('keydown', event => {
    const kind=actionFor(event.key);
    if (!kind) return;
    if(editing(event.target)){event.stopImmediatePropagation();return;}
    event.preventDefault();event.stopImmediatePropagation();
    if(event.ctrlKey || event.metaKey || event.altKey || event.repeat)return;
    if(!preview)parent.postMessage({nativeInput:kind}, '*');
  }, true);
  window.addEventListener('click', event => {
    if (event.target.closest('nav')) { event.preventDefault();event.stopImmediatePropagation();return; }
    if (editing(event.target) || event.target.closest('a,button')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if(!preview)parent.postMessage({nativeInput:'next'}, '*');
  },true);
  window.addEventListener('contextmenu', event=>{event.preventDefault();event.stopImmediatePropagation();},true);
  // The wrapper replaces the controlled route for each accepted Rust state.
  // Hash navigation and Slidev controls are blocked because they would bypass Rust.
  window.addEventListener('message',event=>{if(event.source===parent && typeof event.data?.nativeTestKey==='string')window.dispatchEvent(new KeyboardEvent('keydown',{key:event.data.nativeTestKey,repeat:!!event.data.repeat,bubbles:true}));});
  window.addEventListener('message',event=>{if(event.source===parent && event.data?.nativeTestNavClick){const button=document.querySelector('#app nav button');if(button)button.dispatchEvent(new MouseEvent('click',{bubbles:true}));}});
  let renderedTimer; const report=()=>{clearTimeout(renderedTimer);renderedTimer=setTimeout(()=>{const slide=[...document.querySelectorAll('.slidev-page')].find(s=>getComputedStyle(s).display!=='none');if(slide)parent.postMessage({nativeRendered:{url:location.href,page:Number(slide.dataset.slidevNo),loaded:!slide.textContent.includes('Loading slide...'),text:slide.textContent.slice(0,600),clickElements:[...slide.querySelectorAll('.slidev-vclick-target')].map(e=>({text:e.textContent,visible:getComputedStyle(e).visibility!=='hidden' && getComputedStyle(e).opacity!=='0'}))}},'*');},300);};
  new MutationObserver(report).observe(document,{childList:true,subtree:true});
  document.addEventListener('DOMContentLoaded',()=>{
    const style=document.createElement('style'); style.textContent='#app nav{display:none!important}'; document.head.append(style);
    parent.postMessage({nativeDiagnostic:{ready:location.href}},'*');
  });
})();
