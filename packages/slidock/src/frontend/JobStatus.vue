<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  isJobId,
  isJobSnapshot,
  isTerminalJobStatus,
} from '@slidock/protocol/contracts';
import type { JobPhase, JobSnapshot, StageSnapshot } from '@slidock/protocol/contracts';
import {
  clearJobViewToken,
  createPublishedSlideHref,
  jobViewStorageKey,
  resolveJobViewToken,
} from './job-status.js';
import type { JobStatusClient, JobStatusRequest } from './job-status.js';

const props = defineProps<{
  client: JobStatusClient;
  deckId: string;
  jobId: string;
  viewToken?: string;
  signal: AbortSignal;
}>();

const stages: Array<{ phase?: JobPhase; label: string; accepted?: boolean }> = [
  { label: '受付', accepted: true },
  { phase: 'runtime', label: 'ランタイム準備' },
  { phase: 'compile', label: 'コンパイル' },
  { phase: 'store', label: '保存' },
  { phase: 'publish', label: '公開' },
  { phase: 'thumbnail', label: 'サムネイル生成' },
];

const phaseLabels: Record<JobPhase, string> = {
  runtime: 'ランタイム準備',
  compile: 'コンパイル',
  store: '保存',
  publish: '公開',
  thumbnail: 'サムネイル生成',
};

const job = ref<JobSnapshot>();
const loading = ref(true);
const invalidLink = ref(false);
const stale = ref(false);
const now = ref(Date.now());
const phaseAnnouncement = ref('');
const resolvedViewToken = ref<string>();
let clockTimer: number | undefined;
let storageKey = jobViewStorageKey(window.location.origin, props.deckId, props.jobId);

const request = computed<JobStatusRequest>(() => ({
  deckId: props.deckId,
  jobId: props.jobId,
  ...(resolvedViewToken.value === undefined ? {} : { viewToken: resolvedViewToken.value }),
}));
const publishedHref = computed(() =>
  job.value
    ? createPublishedSlideHref(job.value, props.deckId, props.jobId, window.location.origin)
    : undefined,
);
const summaryTitle = computed(() => {
  const value = job.value;
  if (!value) return stale.value ? '接続を待っています' : 'ジョブの状態を確認しています';
  if (value.status === 'queued') return 'キューで待機中';
  if (value.status === 'succeeded')
    return value.result?.thumbnail === 'skipped' ? '公開完了・サムネイル生成を省略' : '完了';
  if (value.status === 'partial')
    return value.result?.thumbnail === 'unavailable'
      ? 'サムネイル生成を利用できません'
      : 'サムネイル生成に失敗';
  if (value.status === 'failed') return '公開に失敗';
  if (value.status === 'superseded') return '後続のジョブに置き換え';
  if (value.status === 'retry_wait' && value.result) return '公開済み・サムネイル生成中';
  if (value.phase === 'thumbnail' && value.result) return '公開済み・サムネイル生成中';
  if (value.status === 'retry_wait') return '再試行待ち';
  return `${phaseLabels[value.phase]}中`;
});
const summaryText = computed(() => {
  const value = job.value;
  if (!value)
    return stale.value
      ? '公開ジョブの状態を取得できません。自動で再接続しています。'
      : '最新の状態を読み込んでいます。';
  if (value.status === 'queued') return '公開処理の開始を待っています。';
  if (value.status === 'succeeded') {
    if (value.result?.thumbnail === 'skipped')
      return 'スライドの公開が完了しました。サムネイル生成は省略されました。';
    return 'スライドの公開とサムネイル生成が完了しました。';
  }
  if (value.status === 'partial') return '一部完了 · スライドは公開済みです。';
  if (value.status === 'failed') return 'このジョブの公開処理は完了しませんでした。';
  if (value.status === 'superseded') return '新しい公開ジョブが受け付けられています。';
  if (value.status === 'retry_wait') return '自動再試行を待っています。';
  if (value.result && value.phase === 'thumbnail')
    return '新しいスライドは閲覧できます。サムネイル生成を続けています。';
  if (value.phase === 'compile' && value.progress)
    return `${value.progress.completed} / ${value.progress.total} ${progressUnit(value.progress.unit)}を処理しています。`;
  return `${phaseLabels[value.phase]}を処理しています。`;
});
const summaryTone = computed(() => {
  if (job.value?.status === 'succeeded') return 'success';
  if (job.value?.status === 'partial' || job.value?.status === 'retry_wait') return 'partial';
  if (job.value?.status === 'failed' || job.value?.status === 'superseded') return 'failure';
  return 'running';
});
const elapsed = computed(() => {
  const value = job.value;
  if (!value) return '';
  const start = Date.parse(value.startedAt ?? value.createdAt);
  const end = Date.parse(
    value.finishedAt ??
      (isTerminalJobStatus(value.status) ? value.updatedAt : new Date(now.value).toISOString()),
  );
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  return formatDuration(end - start);
});
const retryCountdown = computed(() => {
  const nextRunAt = job.value?.nextRunAt;
  if (!nextRunAt) return '';
  const remaining = Date.parse(nextRunAt) - now.value;
  if (!Number.isFinite(remaining)) return '';
  if (remaining <= 0) return '次の再試行を待っています';
  return `次の再試行まで ${formatDuration(remaining)}`;
});
const retryCommand = computed(() => {
  const value = job.value;
  if (!value || (value.status !== 'failed' && value.status !== 'partial')) return '';
  const stage = value.status === 'partial' || value.phase === 'thumbnail' ? 'thumbnail' : 'all';
  return `hub jobs retry --id ${props.deckId} --job ${props.jobId} --stage ${stage}`;
});
const publicErrorCode = computed(() => {
  const value = job.value;
  return value && (value.status === 'failed' || value.status === 'partial')
    ? value.error?.code
    : undefined;
});

watch(
  () => job.value?.phase,
  (phase, previousPhase) => {
    if (phase && previousPhase && phase !== previousPhase)
      phaseAnnouncement.value = `${phaseLabels[phase]}の段階に進みました。`;
  },
  { immediate: true },
);

onMounted(() => {
  let storage: Storage;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    };
  }
  const resolved = resolveJobViewToken({
    location: window.location,
    history: window.history,
    storage,
    deckId: props.deckId,
    jobId: props.jobId,
    ...(props.viewToken === undefined ? {} : { providedToken: props.viewToken }),
  });
  storageKey = resolved.storageKey;
  if (resolved.invalid || !validIdentity()) {
    invalidLink.value = true;
    loading.value = false;
    return;
  }
  resolvedViewToken.value = resolved.token;

  clockTimer = window.setInterval(() => {
    now.value = Date.now();
  }, 1000);
  void loadAndWatch();
});

onBeforeUnmount(() => {
  if (clockTimer !== undefined) window.clearInterval(clockTimer);
});

function validIdentity(): boolean {
  return isJobId(props.jobId) && /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(props.deckId);
}

function progressUnit(unit: 'slides' | 'objects'): string {
  return unit === 'slides' ? 'スライド' : '項目';
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${remainingSeconds} 秒`;
  if (minutes < 60) return remainingSeconds ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} 時間 ${remainingMinutes} 分` : `${hours} 時間`;
}

function stageSnapshot(phase: JobPhase): StageSnapshot | undefined {
  return job.value?.stages.find((stage) => stage.phase === phase);
}

function stageClass(stage: { phase?: JobPhase; accepted?: boolean }): string {
  if (stage.accepted) return job.value ? 'done' : 'pending';
  const value = job.value;
  if (!value || !stage.phase) return 'pending';
  if (value.status === 'retry_wait' && value.phase === stage.phase) return 'retry';
  const state = stageSnapshot(stage.phase)?.status ?? 'pending';
  return state === 'succeeded' || state === 'skipped' ? 'done' : state;
}

function stageStatus(stage: { phase?: JobPhase; accepted?: boolean }): string {
  if (stage.accepted) return job.value ? '完了' : '未確認';
  const value = job.value;
  if (!value || !stage.phase) return '未開始';
  if (value.kind === 'thumbnail' && value.result && stage.phase !== 'thumbnail')
    return '元の公開で完了';
  const state = stageSnapshot(stage.phase)?.status ?? 'pending';
  if (value.status === 'retry_wait' && value.phase === stage.phase) return '再試行待ち';
  if (state === 'succeeded') {
    if (stage.phase === 'compile' && value.result)
      return `完了 · ${value.result.pages} スライド`;
    if (stage.phase === 'compile' && value.phase === 'compile' && value.progress)
      return `完了 · ${value.progress.completed} ${progressUnit(value.progress.unit)}`;
    return '完了';
  }
  if (state === 'running') {
    if (stage.phase === 'compile' && value.phase === 'compile' && value.progress)
      return `処理中 · ${value.progress.completed} / ${value.progress.total} ${progressUnit(value.progress.unit)}`;
    return '処理中';
  }
  if (state === 'failed') return '失敗';
  if (state === 'skipped') return '対象外';
  return '未開始';
}

function stageMarker(stage: { phase?: JobPhase; accepted?: boolean }): string {
  const style = stageClass(stage);
  if (style === 'done') return '✓';
  if (style === 'failed') return '!';
  if (style === 'retry') return '↻';
  return '';
}

function isCurrentStage(stage: { phase?: JobPhase }): boolean {
  return Boolean(stage.phase && job.value?.phase === stage.phase && job.value.status !== 'queued');
}

function hasPublishedResult(): boolean {
  return Boolean(publishedHref.value && job.value?.result);
}

function isInvalidLinkError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { status?: unknown; code?: unknown };
  return (
    value.status === 401 ||
    value.status === 403 ||
    value.status === 404 ||
    value.status === 410 ||
    ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VIEW_EXPIRED', 'INVALID_VIEW_TOKEN'].includes(
      String(value.code),
    )
  );
}

function rejectLink(): void {
  invalidLink.value = true;
  loading.value = false;
  stale.value = false;
  try {
    clearJobViewToken(window.sessionStorage, storageKey);
  } catch {
    // sessionStorage itself can be unavailable in browser privacy modes.
  }
}

function acceptSnapshot(value: unknown): boolean {
  if (!isJobSnapshot(value) || value.id !== props.jobId || value.deckId !== props.deckId) {
    rejectLink();
    return false;
  }
  job.value = value;
  loading.value = false;
  stale.value = false;
  return true;
}

async function loadAndWatch(): Promise<void> {
  if (props.signal.aborted) return;
  try {
    const response = await props.client.get(request.value, { signal: props.signal });
    if (props.signal.aborted || invalidLink.value) return;
    if (response.schemaVersion !== 1 || !acceptSnapshot(response.job)) return;
  } catch (error) {
    if (props.signal.aborted) return;
    if (isInvalidLinkError(error)) {
      rejectLink();
      return;
    }
    loading.value = false;
    stale.value = true;
  }

  if (props.signal.aborted || invalidLink.value || (job.value && isTerminalJobStatus(job.value.status)))
    return;

  try {
    const stream = props.client.watch(request.value, {
      signal: props.signal,
      pollIntervalMs: 2000,
      hiddenIntervalMs: 10000,
      maxBackoffMs: 15000,
      isHidden: () => document.hidden,
      onConnectionChange: (connection) => {
        if (!props.signal.aborted && !invalidLink.value) stale.value = connection === 'reconnecting';
      },
    });
    for await (const value of stream) {
      if (props.signal.aborted || invalidLink.value || !acceptSnapshot(value)) return;
      if (isTerminalJobStatus(value.status)) return;
    }
    if (
      !props.signal.aborted &&
      !invalidLink.value &&
      (!job.value || !isTerminalJobStatus(job.value.status))
    )
      stale.value = true;
  } catch (error) {
    if (props.signal.aborted || invalidLink.value) return;
    if (isInvalidLinkError(error)) rejectLink();
    else stale.value = true;
  }
}
</script>

<template>
  <main class="hub-job-status" aria-labelledby="job-title">
    <header class="library-header">
      <a class="brand" href="/">SLIDE LIBRARY<span>資料ライブラリ</span></a>
      <span class="library-caption">考えを、スライドから。</span>
    </header>

    <div v-if="invalidLink" class="job-main invalid-link">
      <p class="eyebrow">PUBLICATION JOB</p>
      <h1 id="job-title">確認リンクを開けません</h1>
      <p>この確認リンクは無効または有効期限切れです。</p>
      <a class="back-link" href="/">← 資料一覧へ</a>
    </div>

    <div v-else class="job-main">
      <a class="back-link" href="/">← 資料一覧へ</a>
      <p class="eyebrow">PUBLICATION JOB</p>
      <div class="job-heading">
        <h1 id="job-title">{{ deckId }}</h1>
        <span class="readonly-badge">閲覧専用</span>
      </div>
      <p class="job-id">
        {{ deckId }} · ジョブ <code>{{ jobId }}</code>
      </p>

      <section class="summary" :class="`is-${summaryTone}`" aria-label="ジョブの概要">
        <h2>{{ summaryTitle }}</h2>
        <p>{{ summaryText }}</p>
        <p v-if="publicErrorCode" class="error-code">
          エラーコード <code>{{ publicErrorCode }}</code>
        </p>
        <p v-if="elapsed" class="elapsed">経過時間 {{ elapsed }}</p>
      </section>
      <p v-if="stale" class="stale-notice">
        {{
          job
            ? '通信が途切れています。最後に確認した状態を表示しています。'
            : '接続できません。状態を取得でき次第、自動で再接続します。'
        }}
      </p>
      <p v-if="loading" class="loading-notice">最新の状態を確認しています。</p>
      <p class="sr-only" aria-live="polite" aria-atomic="true">{{ phaseAnnouncement }}</p>

      <ol class="steps" aria-label="公開処理の段階">
        <li
          v-for="stage in stages"
          :key="stage.label"
          :class="[`step-${stageClass(stage)}`, { 'is-current': isCurrentStage(stage) }]"
          :aria-current="isCurrentStage(stage) ? 'step' : undefined"
        >
          <span class="step-name">
            <span class="step-marker" aria-hidden="true">{{ stageMarker(stage) }}</span
            >{{ stage.label }}
          </span>
          <span class="step-status">
            {{ stageStatus(stage) }}
            <small
              v-if="stage.phase === job?.phase && job?.status === 'retry_wait' && retryCountdown"
            >
              {{ retryCountdown }}
            </small>
          </span>
        </li>
      </ol>

      <section v-if="hasPublishedResult()" class="publication" aria-label="公開済み資料">
        <p v-if="job?.result?.thumbnail === 'pending'">
          スライドは公開済みです。サムネイル生成を続けています。
        </p>
        <p v-else-if="job?.result?.thumbnail === 'failed'">
          公開済みのスライドは引き続き閲覧できます。
        </p>
        <p v-else-if="job?.result?.thumbnail === 'ready'">公開とサムネイル生成が完了しました。</p>
        <p v-else>スライドは公開済みです。</p>
        <a class="slide-link" :href="publishedHref">公開済みのスライドを開く ↗</a>
        <dl class="details">
          <div>
            <dt>リビジョン</dt>
            <dd>
              <code>{{ job?.result?.revision.slice(0, 8) }}</code>
            </dd>
          </div>
          <div v-if="job?.result?.runtimeId">
            <dt>ランタイム</dt>
            <dd>
              <code>{{ job.result.runtimeId.slice(0, 8) }}</code>
            </dd>
          </div>
          <div>
            <dt>ページ数</dt>
            <dd>{{ job?.result?.pages }} ページ</dd>
          </div>
        </dl>
      </section>

      <section v-if="retryCommand" class="retry-help" aria-label="CLI から再試行">
        <h2>再試行するには</h2>
        <p>公開権限を持つ環境で、CLI から実行してください。</p>
        <code>{{ retryCommand }}</code>
      </section>
    </div>

    <footer class="library-footer">
      SLIDE LIBRARY · この画面では公開ジョブの状態を確認できます
    </footer>
  </main>
</template>
