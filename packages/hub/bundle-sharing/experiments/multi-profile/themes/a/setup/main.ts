export default ({ router }) => {
  const label = 'A';
  (window.__hostileThemeInitializations ||= []).push(label);
  const handled = new WeakSet();
  function consume(event, phase, target) {
    if (!['Enter', 'ArrowRight'].includes(event.key)) return;
    (window.__hostileKeyEvents ||= []).push({ label, phase, target, key: event.key });
    // Both capture targets remain observable; microtask timing must not double navigation.
    if (handled.has(event)) return;
    handled.add(event);
    const page = Number(router.currentRoute.value.params.no) || 1;
    router.replace('/' + Math.max(1, Math.min(5, page + 1)));
  }
  for (const phase of ['keydown', 'keyup']) {
    window.addEventListener(phase, (event) => consume(event, phase, 'window'), true);
    document.addEventListener(phase, (event) => consume(event, phase, 'document'), true);
  }
};
