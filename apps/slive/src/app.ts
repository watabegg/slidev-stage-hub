import { mountLibrary } from './library';
import { installIcons, setIcon } from './icons';

type NativeAppElementMap = {
  blackout: HTMLDivElement;
  status: HTMLDivElement;
  page: HTMLSpanElement;
  'next-preview': HTMLIFrameElement;
  'next-heading': HTMLDivElement;
  'home-button': HTMLButtonElement;
  library: HTMLElement;
  'deck-title': HTMLHeadingElement;
  'preview-container': HTMLDivElement;
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
  installIcons();
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
  let homeOpen = role === 'presenter';
  const titles = new Map<string, string>();
  function showHome(open: boolean): void {
    homeOpen = open;
    document.body.classList.toggle('library-open', open);
    el('library').hidden = !open;
    el('deck-title').textContent = open ? 'Slive' : titles.get(state!.deckId) || state!.deckId;
    if (!open && state) {
      frames?.update(state);
      if (state.page < deckFor(state.deckId).clickTotals.length)
        previewFrames?.update({ ...state, page: state.page + 1, clickIndex: 0 });
    }
  }
  function showError(element: HTMLElement, message: string, error: unknown): void {
    element.textContent = message;
    element.title = String(error);
  }
  const rendered = new Map<string, NativeRenderedReport>();
  const drafts = new Map<string, NativeDraft>();
  const noteKey = (id: string, page: number): string => `${id}:${page}`;
  const editing = (target: EventTarget | null): boolean =>
    target instanceof Element &&
    !!target.closest('input,textarea,select,[contenteditable=true],[contenteditable=""]');

  async function action(kind: NativeActionKind, value?: string): Promise<void> {
    if (notesDirty && ['next', 'previous', 'selectDeck'].includes(kind)) {
      el('note-status').textContent = 'ノートを保存してください';
      el('save').focus();
      return;
    }
    try {
      const actionValue: NativeAction = kind === 'selectDeck' ? { kind, value: value! } : { kind };
      const next = await invoke('transition', {
        input: { source: role, sequence: ++sequence, editing: false, action: actionValue },
      });
      el('status').textContent = '';
      await render(next);
      if (kind === 'selectDeck' && role === 'presenter') {
        showHome(false);
        el('home-button').focus();
      }
    } catch (error) {
      showError(el('status'), '操作できませんでした。もう一度お試しください。', error);
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
    if (!homeOpen) frames!.update(state);
    el('blackout').style.display = state.blackout ? 'block' : 'none';
    if (!homeOpen) el('deck-title').textContent = titles.get(state.deckId) || state.deckId;
    const blackoutButton = document.querySelector<HTMLButtonElement>(
      '[data-action=toggleBlackout]',
    )!;
    blackoutButton.setAttribute('aria-pressed', String(state.blackout));
    const timerButton = document.querySelector<HTMLButtonElement>('[data-action=toggleTimer]')!;
    const running = state.timer.startedAt !== null;
    setIcon(timerButton, running ? 'pause' : 'play');
    timerButton.title = running ? 'タイマーを一時停止' : 'タイマー開始';
    timerButton.setAttribute('aria-label', timerButton.title);
    el('page').textContent = `${state.page} / ${deckFor(state.deckId).clickTotals.length}`;
    if (role === 'presenter') {
      const pages = deckFor(state.deckId).clickTotals.length;
      el('preview-container').hidden = state.page >= pages;
      el('next-heading').textContent = state.page >= pages ? '最後のスライド' : '次のスライド';
      if (!homeOpen && state.page < pages)
        previewFrames!.update({ ...state, page: state.page + 1, clickIndex: 0 });
    }
    if (
      role !== 'presenter' ||
      (previous && previous.page === state.page && previous.deckId === state.deckId)
    )
      return;
    noteView = undefined;
    notesDirty = false;
    el('notes').value = '';
    el('notes').placeholder = '読み込み中…';
    el('notes').title = '';
    el('note-status').textContent = '';
    el('note-status').title = '';
    el('notes').disabled = true;
    el('save').disabled = true;
    if (!notesAvailable) {
      el('notes').placeholder = 'この資料ではノートを使えません';
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
      el('notes').placeholder = 'ノートを書く';
      notesDirty = !!draft;
      el('save').disabled = !draft;
      el('note-status').textContent = draft
        ? '未保存'
        : drafts.size
          ? `未保存のノート ${drafts.size} 件`
          : view.sourceChanged
            ? '資料が更新されました。ノートを確認してください'
            : '';
      el('save').title =
        notesMode === 'sidecar'
          ? 'ノートをこの端末に保存（公開されません）'
          : 'ノートを資料ファイルに保存';
    } catch (error) {
      if (!state || state.deckId !== deckId || state.page !== page) return;
      if (String(error).includes('no existing notes comment')) {
        el('notes').placeholder = 'このページにはノートがありません';
        el('notes').title = '資料のこのページにノートを追加すると、ここで編集できます';
      } else {
        el('notes').placeholder = 'ノートを読み込めませんでした';
        showError(el('note-status'), '資料を開き直してください', error);
      }
    }
  }

  const initial = await invoke('snapshot');
  registry = initial.decks;
  viewerOrigin = initial.viewerOrigin;
  notesAvailable = initial.notesAvailable !== false;
  notesMode = initial.notesMode || 'markdown';
  frames = new window.NativeFrameController(el('deck'), {
    origin: viewerOrigin,
    decks: registry,
    onInput: (kind) => action(kind),
    onRendered: (report, origin) => {
      rendered.set(report.url, report);
      invoke('viewer_ready', { report: { ...report, origin } }).catch(console.error);
    },
    onDiagnostic: (diagnostic, origin) =>
      invoke('viewer_ready', { report: { diagnostic, origin } }).catch(console.error),
    onError: (error) => {
      if (!homeOpen) showError(el('status'), 'スライドを表示できませんでした', error);
    },
  });
  if (role === 'presenter') {
    previewFrames = new window.NativeFrameController(el('next-preview'), {
      origin: viewerOrigin,
      decks: registry,
      onError: (error) => {
        if (!homeOpen) showError(el('next-heading'), '次のスライドを読み込めませんでした', error);
      },
    });
  }
  // Register before the first src assignment: cached documents can be ready fast.
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (!frames!.message(event)) previewFrames?.message(event);
  });
  await listen('session', (event) => render(event.payload));
  await render(initial.session);
  showHome(homeOpen);
  if (role === 'presenter') {
    mountLibrary({
      origin: viewerOrigin,
      decks: registry,
      open: (id) => action('selectDeck', id),
      title: (id, title) => {
        titles.set(id, title);
        if (!homeOpen && state?.deckId === id) el('deck-title').textContent = title;
      },
    });
  }
  el('home-button').onclick = () => {
    if (notesDirty) {
      el('note-status').textContent = 'ノートを保存してください';
      el('save').focus();
      return;
    }
    showHome(true);
    (document.getElementById('library-search') as HTMLInputElement).focus();
  };
  window.addEventListener(
    'keydown',
    (event) => {
      if (
        homeOpen ||
        (event.target instanceof Element &&
          event.target.closest('button,summary') &&
          ['Enter', ' '].includes(event.key)) ||
        editing(event.target) ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
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
        notesDirty = el('notes').value !== text;
        el('save').disabled = !notesDirty;
        el('note-status').textContent = notesDirty ? '未保存' : '保存済み';
      }
    } catch (error) {
      showError(
        el('note-status'),
        '保存できませんでした。ノートをコピーしてから開き直してください。',
        error,
      );
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
            textContent: `${monitor.name || '画面 ' + (monitor.index + 1)} (${monitor.width}×${monitor.height})`,
          }),
        ),
      );
      el('display-status').textContent =
        monitors.length === 1 ? '外部ディスプレイは接続されていません' : '';
      el('swap').disabled = monitors.length < 2;
    } catch (error) {
      showError(el('display-status'), '画面の設定を変更できませんでした', error);
    }
    el('note-size').oninput = () => {
      el('notes').style.fontSize = `${el('note-size').value}px`;
    };
    el('swap').onclick = async () => {
      try {
        await invoke('swap_windows');
        el('display-status').textContent = '画面の配置を確認してください';
      } catch (error) {
        showError(el('display-status'), '画面の設定を変更できませんでした', error);
      }
    };
    el('apply-display').onclick = async () => {
      try {
        await invoke('audience_display', {
          index: el('displays').value ? Number(el('displays').value) : null,
          fullscreen: el('fullscreen').checked,
        });
        el('display-status').textContent = '投影先の画面を確認してください';
      } catch (error) {
        showError(el('display-status'), '画面の設定を変更できませんでした', error);
      }
    };
  }
})();
