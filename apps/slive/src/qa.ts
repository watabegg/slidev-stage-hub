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
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => window.setTimeout(resolve, ms));
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
    const snapshot = await poc.invoke('snapshot');
    check('presenter starts at library', document.body.classList.contains('library-open'));
    await until(() => document.querySelector('.deck-card'));
    if (snapshot.decks.some((deck) => deck.id === 'aaa/aaa1')) {
      await until(() => document.querySelector('.deck-cover img'));
      const cover = document.querySelector<HTMLImageElement>('.deck-cover img')!;
      await until(() => cover.complete && cover.naturalWidth > 0);
      check(
        'library loads thumbnails and frontmatter',
        document.querySelector('.deck-info h2')!.textContent!.includes('AAA 1'),
      );
      await sleep(16000);
      check(
        'idle library does not start hidden slide loads',
        poc.frames.stats.documentLoads === 0 && !document.getElementById('status')!.textContent,
      );
      await poc.invoke('capture', { label: 'presenter', name: 'library' });
      const search = document.getElementById('library-search') as HTMLInputElement;
      search.value = 'bbb';
      search.dispatchEvent(new Event('input'));
      check('library search filters decks', document.querySelectorAll('.deck-card').length === 2);
      search.value = '';
      search.dispatchEvent(new Event('input'));
    }
    document.querySelector<HTMLButtonElement>('.deck-card')!.click();
    await until(() => !document.body.classList.contains('library-open'));
    check('card opens presenter without deck select', !document.getElementById('decks'));

    const rendered = async (): Promise<NativeRenderedReport> => {
      const state = poc.getState();
      const deck = snapshot.decks.find((item) => item.id === state.deckId);
      const playback = deck?.playback;
      let result: NativeRenderedReport | undefined;
      await until(() => {
        result = [...poc.rendered.values()].find(
          (current) =>
            current.deckId === state.deckId &&
            current.page === state.page &&
            current.clickIndex === state.clickIndex &&
            current.loaded &&
            current.sessionRevision === state.sessionRevision &&
            (playback?.kind !== 'revision-query' ||
              (deck !== undefined &&
                new URL(current.url).searchParams.getAll(playback.parameter).length === 1 &&
                new URL(current.url).searchParams.get(playback.parameter) === deck.revision)),
        );
        return result !== undefined;
      });
      return result!;
    };
    if (snapshot.notesMode === 'sidecar') {
      const initialRender = await rendered();
      await until(() => !element('notes').disabled);
      check('remote local notes enabled', snapshot.notesAvailable && !element('notes').disabled);
      const deckId = poc.getState().deckId;
      const page = poc.getState().page;
      const deck = snapshot.decks.find((item) => item.id === deckId);
      if (!deck) throw new Error('selected deck is missing from native snapshot');
      const revisionPlayback = deck.playback?.kind === 'revision-query' ? deck.playback : undefined;
      const revisionPinned = revisionPlayback !== undefined;
      const prior = await poc.invoke('read_notes', { deckId, page });
      const marker = revisionPinned ? 'STEP7_SIDECARE_NOTE_日本語' : 'REMOTE_LOCAL_NOTE_POC_日本語';
      const persistedFromPreviousRun = prior.text === marker;
      const revisionWarning = prior.sourceChanged;
      const revisionA = deck.revision;
      if (revisionPlayback) {
        const initialUrl = new URL(initialRender.url);
        const expectedContent = revisionWarning ? 'STEP7_REVISION_B' : 'STEP7_REVISION_A';
        check(
          'connected page is pinned to its manifest revision',
          initialUrl.searchParams.getAll(revisionPlayback.parameter).length === 1 &&
            initialUrl.searchParams.get(revisionPlayback.parameter) === revisionA,
        );
        check(
          'connected page displays its published revision content',
          initialRender.text.includes(expectedContent),
        );
        if (revisionWarning) {
          check(
            'reconnected config uses the newer Worker revision',
            initialUrl.searchParams.get(revisionPlayback.parameter) === revisionA,
          );
          check('notes from the previous connection remain available', persistedFromPreviousRun);
        }
        await poc.invoke('capture', {
          label: 'presenter',
          name: revisionWarning ? 'step7-b-connected-given' : 'step7-a-connected-given',
        });
      }
      if (revisionWarning)
        check(
          'updated source warning visible',
          element('note-status').textContent!.includes('更新'),
        );
      if (revisionPinned) {
        if (!persistedFromPreviousRun) {
          check('initial notes have no stale-source warning', !revisionWarning);
          element('notes').value = marker;
          element('notes').dispatchEvent(new Event('input'));
          element('save').click();
          await until(
            () =>
              element('save').disabled && element('note-status').textContent!.includes('保存済み'),
          );
          await poc.invoke('capture', { label: 'presenter', name: 'step7-note-saved' });
          await poc.invoke('capture', { label: 'presenter', name: 'revision-a-before-b' });
          await poc.invoke('capture', { label: 'audience', name: 'revision-a-before-b' });
        }
      } else {
        element('notes').value = marker;
        element('notes').dispatchEvent(new Event('input'));
        element('save').click();
        await until(
          () =>
            element('save').disabled && element('note-status').textContent!.includes('保存済み'),
        );
      }
      const reopened = await poc.invoke('qa_reopen_notes', { deckId, page });
      if (revisionPinned) {
        check(
          'remote note is visible after reopening its sidecar store',
          reopened.text === marker && reopened.sourceChanged === revisionWarning,
        );
        if (revisionWarning)
          await poc.invoke('capture', { label: 'presenter', name: 'step7-note-reopened' });
      } else {
        check(
          'remote note saved and reopened',
          reopened.text === marker && !reopened.sourceChanged,
        );
      }
      let conflicted = false;
      try {
        await poc.invoke('save_notes', {
          deckId,
          page,
          expectedRevision: revisionPinned ? (prior.revision === '0' ? '-1' : '0') : prior.revision,
          text: 'stale overwrite',
        });
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
      let pinning: Record<string, unknown> | undefined;
      if (revisionPinned && !revisionWarning) {
        const source = element('deck').src;
        const initialSession = poc.getState();
        const initialLoads = poc.frames.stats.documentLoads;
        const controlUrl = await poc.invoke('qa_control_url');
        const publishResponse = await fetch(`${controlUrl}/publish-b`, { method: 'POST' });
        if (!publishResponse.ok)
          throw new Error(`Worker B publish handshake returned HTTP ${publishResponse.status}`);
        const publication = (await publishResponse.json()) as {
          id?: string;
          revision?: string;
          entry?: string;
        };
        const revisionB = publication.revision;
        check(
          'Worker accepted a new publication for the same deck',
          publication.id === deckId &&
            typeof revisionB === 'string' &&
            revisionB !== revisionA &&
            typeof publication.entry === 'string' &&
            new URL(publication.entry).origin === snapshot.viewerOrigin &&
            new URL(publication.entry).pathname === `/${deckId}/1` &&
            new URL(publication.entry).searchParams.getAll('revision').length === 1 &&
            new URL(publication.entry).searchParams.get('revision') === revisionB,
        );
        const stateDuringPublish = poc.getState();
        check(
          'active Stage session remains on revision A after publishing B',
          stateDuringPublish.deckId === deckId &&
            stateDuringPublish.revision === revisionA &&
            stateDuringPublish.page === initialSession.page &&
            stateDuringPublish.sessionRevision === initialSession.sessionRevision &&
            element('deck').src === source &&
            new URL(source).searchParams.get('revision') === revisionA,
        );
        await poc.invoke('capture', { label: 'presenter', name: 'step7-b-published' });

        await poc.action('next');
        await until(() => poc.getState().page === initialSession.page + 1);
        const nextPage = await rendered();
        await poc.action('previous');
        await until(() => poc.getState().page === initialSession.page);
        const afterPublish = await rendered();
        const afterUrl = new URL(afterPublish.url);
        check(
          'persistent frame re-renders revision A content after B is current',
          afterPublish.sessionRevision > initialRender.sessionRevision &&
            afterUrl.searchParams.getAll('revision').length === 1 &&
            afterUrl.searchParams.get('revision') === revisionA &&
            afterPublish.text.includes('STEP7_REVISION_A') &&
            !afterPublish.text.includes('STEP7_REVISION_B') &&
            nextPage.documentToken === initialRender.documentToken &&
            afterPublish.documentToken === initialRender.documentToken &&
            poc.frames.stats.documentLoads === initialLoads,
        );
        await poc.invoke('capture', { label: 'presenter', name: 'revision-a-after-b' });
        await poc.invoke('capture', { label: 'presenter', name: 'step7-a-still-pinned' });
        await poc.invoke('capture', { label: 'audience', name: 'revision-a-after-b' });
        pinning = {
          revisionA,
          revisionB,
          initialUrl: initialRender.url,
          currentIframeSrc: source,
          reRenderedUrl: afterPublish.url,
          reRenderedText: afterPublish.text,
          documentToken: afterPublish.documentToken,
          documentLoads: poc.frames.stats.documentLoads,
        };
      } else if (revisionPinned) {
        await poc.invoke('capture', { label: 'presenter', name: 'step7-b-reconnected' });
        await poc.invoke('capture', { label: 'presenter', name: 'revision-b-reconnect' });
        await poc.invoke('capture', { label: 'audience', name: 'revision-b-reconnect' });
        pinning = {
          revisionB: revisionA,
          initialUrl: initialRender.url,
          content: initialRender.text,
          persistedFromPreviousRun,
          revisionWarning,
        };
      }
      if (revisionPinned && revisionWarning)
        await poc.invoke('capture', { label: 'presenter', name: 'step7-warning-visible' });
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
        check(
          `${deck.id} remote persistent document`,
          before.documentToken === after.documentToken,
        );
        const pageWithClicks = deck.clickTotals.findIndex((total) => total > 0) + 1;
        if (pageWithClicks > 0) {
          while (poc.getState().page < pageWithClicks) {
            await poc.action('next');
            await rendered();
          }
          const click = poc.getState().clickIndex;
          const clickDocument = (await rendered()).documentToken;
          await poc.action('next');
          const clicked = await rendered();
          check(
            `${deck.id} remote click remains in its document`,
            poc.getState().clickIndex === click + 1 &&
              clicked.documentToken === clickDocument &&
              (deck.playback?.kind !== 'revision-query' ||
                (new URL(clicked.url).searchParams.getAll(deck.playback.parameter).length === 1 &&
                  new URL(clicked.url).searchParams.get(deck.playback.parameter) ===
                    deck.revision)),
          );
        }
        check(
          `${deck.id} remote bounded frames`,
          document.querySelectorAll('#viewer>iframe').length <= 2,
        );
        remote.push({
          deckId: deck.id,
          documentToken: after.documentToken,
          runtimeVersion: after.runtimeVersion,
          theme: after.theme,
        });
      }
      await poc.invoke('capture', { label: 'audience', name: 'remote-audience' });
      await report({
        complete: true,
        assertions,
        remote,
        revisionPinning: pinning,
        viewerOrigin: snapshot.viewerOrigin,
        sourceOrigin: snapshot.sourceOrigin,
        notes: { persistedFromPreviousRun, revisionWarning },
      });
      return;
    }
    if (!snapshot.decks.some((deck) => deck.id === 'aaa/aaa1')) {
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
        check(
          `${deck.id} persistent document`,
          before.documentToken === after.documentToken && poc.frames.stats.documentLoads === loads,
        );
        check(
          `${deck.id} runtime version`,
          after.runtimeVersion === (deck.id.startsWith('v52/') ? '52.15.2' : '53.0.0'),
        );
        await poc.invoke('capture', {
          label: 'audience',
          name: `profile-${deck.id.replaceAll('/', '-')}`,
        });
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
        flicker: {
          stats: poc.frames.stats,
          activeFrames: document.querySelectorAll('#viewer>iframe').length,
        },
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
    check(
      'wrapper Enter one transition',
      poc.getState().sessionRevision === start + 1 && poc.getState().clickIndex === 0,
    );
    element('deck').contentWindow!.postMessage({ nativeTestKey: 'Enter' }, '*');
    await until(() => poc.getState().clickIndex === 1);
    await sleep(1400);
    check(
      'frame Enter one transition with theme shortcut suppressed',
      poc.getState().sessionRevision === start + 2,
    );
    const blocked = poc.getState().sessionRevision;
    element('deck').contentWindow!.postMessage({ nativeTestKey: 'Enter', repeat: true }, '*');
    element('deck').contentWindow!.postMessage({ nativeTestNavClick: true }, '*');
    await sleep(400);
    check(
      'frame repeats and stock controls cannot bypass Rust',
      poc.getState().sessionRevision === blocked,
    );
    element('deck').contentWindow!.postMessage({ nativeTestSlideClick: true }, '*');
    await sleep(300);
    check('slide click does not advance', poc.getState().sessionRevision === blocked);
    const clickOne = await rendered();
    check(
      'actual rendered click-one visibility',
      clickOne.page === 2 &&
        clickOne.clickElements.length === 2 &&
        clickOne.clickElements[0].visible &&
        !clickOne.clickElements[1].visible,
    );
    await poc.invoke('capture', { label: 'presenter', name: 'click-one' });
    await poc.invoke('capture', { label: 'audience', name: 'click-one' });
    await poc.action('next');
    await sleep(1200);
    await poc.action('next');
    await sleep(1200);
    const third = await rendered();
    check(
      'native third slide code and math loaded',
      third.page === 3 && third.loaded && third.text.includes('E'),
    );
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
    if (
      third.documentToken !== initialDocument ||
      poc.frames.stats.documentLoads !== initialLoads
    ) {
      throw new Error('same deck document reloaded');
    }
    check(
      'click sequence then page advance',
      poc.getState().page === 3 &&
        poc.getState().clickIndex === 0 &&
        poc.getState().sessionRevision === start + 4,
    );
    await poc.action('previous');
    await sleep(1400);
    await rendered();
    check(
      'previous returns previous final click',
      poc.getState().page === 2 && poc.getState().clickIndex === 2,
    );
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
    check(
      'audience input reaches Rust and preserves editor draft',
      Object.values(poc.getDrafts()).some((draft) => draft.text.endsWith('Preserved draft.')),
    );
    await poc.action('previous');
    await until(() => element('notes').value.endsWith('Preserved draft.'));
    check(
      'draft restored after audience navigation',
      element('note-status').textContent === '未保存',
    );
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
    check(
      'Rust timer pause elapsed',
      poc.getState().timer.startedAt === null && poc.getState().timer.elapsedMs >= 500,
    );
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
      poc.getState().deckId === 'bbb/bbb1' &&
        poc.getState().page === 1 &&
        poc.getState().clickIndex === 0 &&
        !poc.getState().blackout,
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
