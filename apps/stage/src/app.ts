type NativeAppElementMap = {
  blackout: HTMLDivElement;
  status: HTMLDivElement;
  page: HTMLSpanElement;
  'next-preview': HTMLIFrameElement;
  'next-heading': HTMLDivElement;
  revision: HTMLSpanElement;
  decks: HTMLSelectElement;
  notes: HTMLTextAreaElement;
  save: HTMLButtonElement;
  'note-status': HTMLSpanElement;
  displays: HTMLSelectElement;
  'display-status': HTMLParagraphElement;
  'note-size': HTMLInputElement;
  swap: HTMLButtonElement;
  'apply-display': HTMLButtonElement;
  fullscreen: HTMLInputElement;
  timer: HTMLSpanElement;
  deck: HTMLIFrameElement;
};

(async () => {
  const role = new URLSearchParams(location.search).get('role')!;
  document.body.classList.add(String(role));
  const invoke = window.__TAURI__.core.invoke;
  const listen = window.__TAURI__.event.listen;
  const el = <Id extends keyof NativeAppElementMap>(id: Id): NativeAppElementMap[Id] =>
    document.getElementById(id) as NativeAppElementMap[Id];
  let viewerOrigin = 'deck://localhost';
  let state: NativeSession | undefined;
  let registry: NativeDeck[] | undefined;
  let sequence = Date.now() * 1000;
  let noteView: NativeNoteView | undefined;
  let notesDirty = false;
  let frames: NativeFrameControllerInstance | undefined;
  let previewFrames: NativeFrameControllerInstance | undefined;
  let notesAvailable = true;
  let notesMode: 'markdown' | 'sidecar' = 'markdown';
  const rendered = new Map<string, NativeRenderedReport>();
  const drafts = new Map<string, NativeDraft>();
  const noteKey = (id: string, page: number): string => `${id}:${page}`;
  const editing = (target: EventTarget | null): boolean =>
    target instanceof Element &&
    !!target.closest('input,textarea,select,[contenteditable=true],[contenteditable=""]');

  async function action(kind: NativeActionKind, value?: string): Promise<void> {
    if (notesDirty && kind !== 'toggleBlackout') {
      el('note-status').textContent = '保存後にページを移動してください';
      return;
    }
    try {
      const actionValue: NativeAction = kind === 'selectDeck' ? { kind, value: value! } : { kind };
      const next = await invoke('transition', {
        input: { source: role, sequence: ++sequence, editing: false, action: actionValue },
      });
      await render(next);
    } catch (error) {
      el('status').textContent = String(error);
    }
  }

  function deckFor(deckId: string): NativeDeck {
    return registry!.find((deck) => deck.id === deckId)!;
  }

  async function render(next: NativeSession): Promise<void> {
    if (state && next.sessionRevision < state.sessionRevision) return;
    const previous = state;
    if (
      previous &&
      notesDirty &&
      noteView &&
      (previous.deckId !== next.deckId || previous.page !== next.page)
    ) {
      drafts.set(noteKey(previous.deckId, previous.page), {
        text: el('notes').value,
        view: { ...noteView },
      });
    }
    state = next;
    frames!.update(state);
    el('blackout').style.display = state.blackout ? 'block' : 'none';
    el('status').textContent = `${state.deckId} · ${state.page}頁 · click ${state.clickIndex}`;
    el('page').textContent = `${state.page} / ${deckFor(state.deckId).clickTotals.length}`;
    if (role === 'presenter') {
      const pages = deckFor(state.deckId).clickTotals.length;
      el('next-preview').hidden = state.page >= pages;
      el('next-heading').textContent =
        state.page >= pages ? '次のスライドはありません' : '次スライド · 操作無効';
      if (state.page < pages)
        previewFrames!.update({ ...state, page: state.page + 1, clickIndex: 0 });
    }
    el('revision').textContent = `session ${state.sessionRevision}`;
    el('decks').value = state.deckId;
    if (
      role !== 'presenter' ||
      (previous && previous.page === state.page && previous.deckId === state.deckId)
    )
      return;
    noteView = undefined;
    notesDirty = false;
    el('notes').value = '';
    el('notes').disabled = true;
    el('save').disabled = true;
    if (!notesAvailable) {
      el('note-status').textContent =
        'ホストされた資料は閲覧専用です（ノート保存用のローカルソースがありません）';
      return;
    }
    const deckId = state.deckId;
    const page = state.page;
    try {
      const view = await invoke('read_notes', { deckId, page });
      if (!state || state.deckId !== deckId || state.page !== page) return;
      const draft = drafts.get(noteKey(deckId, page));
      noteView = draft?.view || view;
      el('notes').value = draft?.text ?? view.text;
      el('notes').disabled = false;
      notesDirty = !!draft;
      el('save').disabled = !draft;
      el('note-status').textContent = draft
        ? '未保存の下書きを復元'
        : drafts.size
          ? `別ページの未保存下書き ${drafts.size} 件`
          : view.sourceChanged
            ? '資料が更新されています。ノートとページの対応を確認してください'
            : notesMode === 'sidecar'
              ? 'この端末に保存するノート（公開先には送信しません）'
              : 'ローカルソースの既存コメント';
    } catch (error) {
      el('note-status').textContent = String(error);
    }
  }

  const initial = await invoke('snapshot');
  registry = initial.decks;
  viewerOrigin = initial.viewerOrigin;
  notesAvailable = initial.notesAvailable !== false;
  notesMode = initial.notesMode || 'markdown';
  frames = new window.NativeFrameController(el('deck'), {
    origin: viewerOrigin,
    onInput: (kind) => action(kind),
    onRendered: (report, origin) => {
      rendered.set(report.url, report);
      invoke('viewer_ready', { report: { ...report, origin } }).catch(console.error);
    },
    onDiagnostic: (diagnostic, origin) =>
      invoke('viewer_ready', { report: { diagnostic, origin } }).catch(console.error),
    onError: (error) => {
      el('status').textContent = error;
    },
  });
  if (role === 'presenter') {
    previewFrames = new window.NativeFrameController(el('next-preview'), {
      origin: viewerOrigin,
      onError: (error) => {
        el('next-heading').textContent = error;
      },
    });
  }
  // Register before the first src assignment: cached documents can be ready fast.
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (!frames!.message(event)) previewFrames?.message(event);
  });
  el('decks').replaceChildren(
    ...registry.map((deck) =>
      Object.assign(document.createElement('option'), {
        value: deck.id,
        textContent: deck.id,
      }),
    ),
  );
  await listen('session', (event) => render(event.payload));
  await render(initial.session);
  window.addEventListener(
    'keydown',
    (event) => {
      if (editing(event.target) || event.repeat || event.ctrlKey || event.metaKey || event.altKey)
        return;
      const kind: NativeActionKind | null = [
        'ArrowRight',
        'ArrowDown',
        ' ',
        'Enter',
        'PageDown',
      ].includes(event.key)
        ? 'next'
        : ['ArrowLeft', 'ArrowUp', 'Backspace', 'PageUp'].includes(event.key)
          ? 'previous'
          : ['b', 'B', '.'].includes(event.key)
            ? 'toggleBlackout'
            : null;
      if (kind) {
        event.preventDefault();
        event.stopImmediatePropagation();
        action(kind);
      }
    },
    true,
  );
  document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => {
    button.onclick = () => action(button.dataset.action as NativeActionKind);
  });
  el('decks').onchange = () => action('selectDeck', el('decks').value);
  el('notes').oninput = () => {
    notesDirty = true;
    el('save').disabled = false;
    el('note-status').textContent = '未保存';
  };
  el('save').onclick = async () => {
    if (!noteView) return;
    try {
      const saving = { ...noteView };
      const text = el('notes').value;
      const revision = await invoke('save_notes', {
        deckId: saving.deckId,
        page: saving.page,
        expectedRevision: saving.revision,
        text,
      });
      drafts.delete(noteKey(saving.deckId, saving.page));
      if (state!.deckId === saving.deckId && state!.page === saving.page) {
        noteView.revision = revision;
        noteView.sourceChanged = false;
        notesDirty = false;
        el('save').disabled = true;
        el('note-status').textContent =
          notesMode === 'sidecar' ? '端末内に保存しました' : '保存済み';
      }
    } catch (error) {
      el('note-status').textContent = String(error);
    }
  };
  window.setInterval(() => {
    if (!state?.timer) return;
    const elapsed =
      state.timer.elapsedMs +
      (state.timer.startedAt === null ? 0 : Math.max(0, Date.now() - state.timer.startedAt));
    const secs = Math.floor(elapsed / 1000);
    el('timer').textContent =
      `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  }, 200);
  window.__nativePoc = {
    action,
    invoke,
    getState: () => state!,
    getDrafts: () => Object.fromEntries(drafts),
    rendered,
    getOrigin: () => viewerOrigin,
    frames,
  };
  if (role === 'presenter') {
    try {
      const monitors = await invoke('displays');
      el('displays').replaceChildren(
        ...monitors.map((monitor) =>
          Object.assign(document.createElement('option'), {
            value: String(monitor.index),
            textContent: `${monitor.name || 'Display ' + monitor.index} · ${monitor.width}×${monitor.height}`,
          }),
        ),
      );
      el('display-status').textContent =
        `${monitors.length} displays detected; OSによる移動制約は反映結果を確認`;
    } catch (error) {
      el('display-status').textContent = String(error);
    }
    el('note-size').oninput = () => {
      el('notes').style.fontSize = `${el('note-size').value}px`;
    };
    el('swap').onclick = async () => {
      try {
        el('display-status').textContent = await invoke('swap_windows');
      } catch (error) {
        el('display-status').textContent = String(error);
      }
    };
    el('apply-display').onclick = async () => {
      try {
        el('display-status').textContent = await invoke('audience_display', {
          index: el('displays').value ? Number(el('displays').value) : null,
          fullscreen: el('fullscreen').checked,
        });
      } catch (error) {
        el('display-status').textContent = String(error);
      }
    };
  }
})();
