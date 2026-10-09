type NativeQaElementMap = {
  notes: HTMLTextAreaElement;
  'note-status': HTMLSpanElement;
  save: HTMLButtonElement;
  deck: HTMLIFrameElement;
  'next-preview': HTMLIFrameElement;
};

(async () => {
  const element = <Id extends keyof NativeQaElementMap>(id: Id): NativeQaElementMap[Id] =>
    document.getElementById(id) as NativeQaElementMap[Id];
  const sleep = (ms: number): Promise<void> => new Promise(resolve => window.setTimeout(resolve, ms));
  const until = async (fn: () => unknown): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      if (fn()) return;
      await sleep(100);
    }
    throw new Error('condition timeout');
  };
  const assertions: Array<{ name: string; pass: boolean }> = [];
  const check = (name: string, condition: unknown): void => {
    assertions.push({ name, pass: !!condition });
    if (!condition) throw new Error(name);
  };
  const report = (data: Record<string, unknown>): Promise<void> =>
    window.__nativePoc!.invoke('viewer_ready', { report: { qa: data } });
  try {
    await until(() => window.__nativePoc);
    const poc = window.__nativePoc!;
    const rendered = async (): Promise<NativeRenderedReport> => {
      const state = poc.getState();
      const url = `${poc.getOrigin()}/${state.deckId}/${state.page}?clicks=${state.clickIndex}&embedded=true`;
      await until(() => {
        const current = poc.rendered.get(url);
        return current?.page === state.page
          && current.loaded
          && current.sessionRevision === state.sessionRevision;
      });
      await sleep(100);
      return poc.rendered.get(url)!;
    };
    const snapshot = await poc.invoke('snapshot');
    if (snapshot.notesMode === 'sidecar') {
      await rendered();
      await until(() => !element('notes').disabled);
      check('remote local notes enabled', snapshot.notesAvailable && !element('notes').disabled);
      const deckId = poc.getState().deckId;
      const page = poc.getState().page;
      const prior = await poc.invoke('read_notes', { deckId, page });
      const marker = 'REMOTE_LOCAL_NOTE_POC_日本語';
      const persistedFromPreviousRun = prior.text === marker;
      const revisionWarning = prior.sourceChanged;
      if (revisionWarning) check('updated source warning visible', element('note-status').textContent!.includes('更新'));
      element('notes').value = marker;
      element('notes').dispatchEvent(new Event('input'));
      element('save').click();
      await until(() => element('save').disabled && element('note-status').textContent!.includes('端末内'));
      const reopened = await poc.invoke('qa_reopen_notes', { deckId, page });
      check('remote note saved and reopened', reopened.text === marker && !reopened.sourceChanged);
      let conflicted = false;
      try {
        await poc.invoke('save_notes', { deckId, page, expectedRevision: prior.revision, text: 'stale overwrite' });
      } catch {
        conflicted = true;
      }
      check('remote note rejects stale write', conflicted);
      let invalid = false;
      try {
        await poc.invoke('read_notes', { deckId, page: 0 });
      } catch {
        invalid = true;
      }
      check('remote note rejects invalid page', invalid);
      const remote: Array<Record<string, unknown>> = [];
      for (const deck of snapshot.decks) {
        await poc.action('selectDeck', deck.id);
        await until(() => poc.getState().deckId === deck.id && poc.getState().page === 1);
        const before = await rendered();
        const revision = poc.getState().sessionRevision;
        element('deck').contentWindow!.postMessage(
          { nativeTestKey: 'Enter', nativeTestKeyUp: 'Enter' },
          snapshot.viewerOrigin,
        );
        await until(() => poc.getState().sessionRevision === revision + 1);
        const after = await rendered();
        await sleep(200);
        check(`${deck.id} remote shortcut once`, poc.getState().sessionRevision === revision + 1);
        check(`${deck.id} remote persistent document`, before.documentToken === after.documentToken);
        if (deck.clickTotals[poc.getState().page - 1] > 0) {
          const click = poc.getState().clickIndex;
          await poc.action('next');
          await rendered();
          check(`${deck.id} remote click`, poc.getState().clickIndex === click + 1);
        }
        check(`${deck.id} remote bounded frames`, document.querySelectorAll('#viewer>iframe').length <= 2);
        remote.push({ deckId: deck.id, documentToken: after.documentToken, runtimeVersion: after.runtimeVersion, theme: after.theme });
      }
      await poc.invoke('capture', { label: 'audience', name: 'remote-audience' });
      await report({
        complete: true,
        assertions,
        remote,
        viewerOrigin: snapshot.viewerOrigin,
        sourceOrigin: snapshot.sourceOrigin,
        notes: { persistedFromPreviousRun, revisionWarning },
      });
      return;
    }
    if (!snapshot.decks.some(deck => deck.id === 'aaa/aaa1')) {
      const profiles: Array<Record<string, unknown>> = [];
      for (const deck of snapshot.decks) {
        await poc.action('selectDeck', deck.id);
        await until(() => poc.getState().deckId === deck.id && poc.getState().page === 1);
        const before = await rendered();
        const revision = poc.getState().sessionRevision;
        const loads = poc.frames.stats.documentLoads;
        element('deck').contentWindow!.postMessage(
          { nativeTestKey: 'Enter', nativeTestKeyUp: 'Enter' },
          '*',
        );
        await until(() => poc.getState().page === 2);
        const after = await rendered();
        await sleep(250);
        check(
          `${deck.id} hostile keydown/keyup one Rust transition`,
          poc.getState().sessionRevision === revision + 1 && poc.getState().clickIndex === 0,
        );
        check(`${deck.id} persistent document`, before.documentToken === after.documentToken && poc.frames.stats.documentLoads === loads);
        check(`${deck.id} runtime version`, after.runtimeVersion === (deck.id.startsWith('v52/') ? '52.15.2' : '53.0.0'));
        await poc.invoke('capture', { label: 'audience', name: `profile-${deck.id.replaceAll('/', '-')}` });
        profiles.push({
          deckId: deck.id,
          runtimeVersion: after.runtimeVersion,
          theme: after.theme,
          documentToken: after.documentToken,
          readyLatencyMs: after.nativeReadyLatencyMs,
        });
      }
      await report({
        complete: true,
        assertions,
        profiles,
        session: poc.getState(),
        flicker: { stats: poc.frames.stats, activeFrames: document.querySelectorAll('#viewer>iframe').length },
      });
      return;
    }
    await until(() => poc.getState()?.page === 1);
    const initialRender = await rendered();
    const initialDocument = initialRender.documentToken;
    const initialLoads = poc.frames.stats.documentLoads;
    await poc.invoke('capture', { label: 'presenter', name: 'initial' });
    await poc.invoke('capture', { label: 'audience', name: 'initial' });
    const start = poc.getState().sessionRevision;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await until(() => poc.getState().page === 2);
    await sleep(1800);
    check('wrapper Enter one transition', poc.getState().sessionRevision === start + 1 && poc.getState().clickIndex === 0);
    element('deck').contentWindow!.postMessage({ nativeTestKey: 'Enter' }, '*');
    await until(() => poc.getState().clickIndex === 1);
    await sleep(1400);
    check('frame Enter one transition with theme shortcut suppressed', poc.getState().sessionRevision === start + 2);
    const blocked = poc.getState().sessionRevision;
    element('deck').contentWindow!.postMessage({ nativeTestKey: 'Enter', repeat: true }, '*');
    element('deck').contentWindow!.postMessage({ nativeTestNavClick: true }, '*');
    await sleep(400);
    check('frame repeats and stock controls cannot bypass Rust', poc.getState().sessionRevision === blocked);
    const clickOne = await rendered();
    check(
      'actual rendered click-one visibility',
      clickOne.page === 2
        && clickOne.clickElements.length === 2
        && clickOne.clickElements[0].visible
        && !clickOne.clickElements[1].visible,
    );
    await poc.invoke('capture', { label: 'presenter', name: 'click-one' });
    await poc.invoke('capture', { label: 'audience', name: 'click-one' });
    await poc.action('next');
    await sleep(1200);
    await poc.action('next');
    await sleep(1200);
    const third = await rendered();
    check('native third slide code and math loaded', third.page === 3 && third.loaded && third.text.includes('E'));
    await poc.invoke('capture', { label: 'presenter', name: 'page-three' });
    await report({
      flicker: {
        phase: 'same-deck',
        documentStable: third.documentToken === initialDocument,
        documentLoads: poc.frames.stats.documentLoads,
        initialLoads,
        stats: poc.frames.stats,
      },
    });
    if (third.documentToken !== initialDocument || poc.frames.stats.documentLoads !== initialLoads) {
      throw new Error('same deck document reloaded');
    }
    check(
      'click sequence then page advance',
      poc.getState().page === 3 && poc.getState().clickIndex === 0 && poc.getState().sessionRevision === start + 4,
    );
    await poc.action('previous');
    await sleep(1400);
    await rendered();
    check('previous returns previous final click', poc.getState().page === 2 && poc.getState().clickIndex === 2);
    const editor = element('notes');
    await until(() => !editor.disabled);
    editor.focus();
    const before = poc.getState().sessionRevision;
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(300);
    check('notes keyboard suppression', poc.getState().sessionRevision === before);
    const original = editor.value;
    editor.value = `${original}\nNative PoC save roundtrip.`;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    element('save').click();
    await until(() => element('note-status').textContent === '保存済み');
    check('notes native save', element('note-status').textContent === '保存済み');
    const reopened = await poc.invoke('qa_reopen_notes', {
      deckId: poc.getState().deckId,
      page: poc.getState().page,
    });
    check('saved private mapping survives new document instance', reopened.text === editor.value);
    editor.value = original;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    element('save').click();
    await until(() => element('note-status').textContent === '保存済み');
    check('notes restore roundtrip', editor.value === original);
    editor.value = `${original}\nPreserved draft.`;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await poc.invoke('qa_audience_next');
    await until(() => poc.getState().page === 3);
    await sleep(1200);
    check('audience input reaches Rust and preserves editor draft', Object.values(poc.getDrafts()).some(draft => draft.text.endsWith('Preserved draft.')));
    await poc.action('previous');
    await until(() => element('notes').value.endsWith('Preserved draft.'));
    check('draft restored after audience navigation', element('note-status').textContent === '未保存の下書きを復元');
    editor.value = original;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    element('save').click();
    await until(() => element('note-status').textContent === '保存済み');
    const beforePreview = poc.getState().sessionRevision;
    element('next-preview').contentWindow!.postMessage({ nativeTestKey: 'Enter' }, '*');
    await sleep(300);
    check('next preview is read only', poc.getState().sessionRevision === beforePreview);
    await poc.action('toggleTimer');
    await sleep(600);
    await poc.action('toggleTimer');
    check('Rust timer pause elapsed', poc.getState().timer.startedAt === null && poc.getState().timer.elapsedMs >= 500);
    await poc.action('resetTimer');
    check('Rust timer reset', poc.getState().timer.elapsedMs === 0);
    await poc.action('toggleBlackout');
    await sleep(600);
    await poc.invoke('capture', { label: 'audience', name: 'blackout' });
    check('blackout', poc.getState().blackout);
    await poc.action('toggleBlackout');
    const monitors = await poc.invoke('displays');
    const displayResult = await poc.invoke('audience_display', {
      index: monitors.length ? 0 : null,
      fullscreen: true,
    });
    await sleep(600);
    const swapResult = await poc.invoke('swap_windows');
    await report({ assertions, monitors, displayResult, swapResult });
    await poc.invoke('audience_display', { index: null, fullscreen: false });
    await poc.action('selectDeck', 'bbb/bbb1');
    await rendered();
    await sleep(400);
    await poc.invoke('capture', { label: 'audience', name: 'other-deck' });
    check(
      'deck switch resets page/click/blackout',
      poc.getState().deckId === 'bbb/bbb1'
        && poc.getState().page === 1
        && poc.getState().clickIndex === 0
        && !poc.getState().blackout,
    );
    await report({
      complete: true,
      assertions,
      session: poc.getState(),
      flicker: {
        sameDeckDocumentStable: true,
        initialDocument,
        initialLoads,
        stats: poc.frames.stats,
        activeFrames: document.querySelectorAll('#viewer>iframe').length,
      },
    });
  } catch (error) {
    await report({ complete: false, error: String(error), assertions });
  }
})();
