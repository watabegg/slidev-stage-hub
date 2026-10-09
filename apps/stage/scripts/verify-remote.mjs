#!/usr/bin/env node
import { chromium } from 'playwright-chromium';
import { buildNativeUi } from './build-ui.mjs';
// Chromium protocol PoC. This does not attest Rust/Tauri permissions or WebKit.
import assert from 'node:assert/strict';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '@slidev-stage-hub/hub/serve';

buildNativeUi();
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const stageRoot = resolve(repoRoot, 'apps/stage');
const hubRoot = resolve(repoRoot, 'packages/hub');
const site = resolve(process.argv[2] || resolve(hubRoot, 'artifacts/module-graph-offline/site'));
const output = resolve(stageRoot, 'artifacts/remote-browser', basename(dirname(site)));
const servers = [];
let browser;
const result = {
  site,
  command: `node apps/stage/scripts/verify-remote.mjs ${site}`,
  experiment: 'Chromium cross-origin public-player protocol simulation',
  limitations: [
    'Not a Rust/Tauri or WebKit runtime test',
    'No native API permission attestation',
    'HTTPS uses an ephemeral self-signed certificate and fixture-only browser trust bypass; no OS trust changes',
    'No physical dual-display, Windows, or external deployment validation',
  ],
  runs: {},
};
const listen = async (server) => {
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
};
const controllerSource = await readFile(resolve(stageRoot, 'dist/frame-controller.js'), 'utf8');
const hostHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Remote player protocol PoC</title><style>body{margin:0;background:#161920;color:#fff;font:16px sans-serif}#status{padding:10px}#viewer{position:relative;width:1100px;height:650px}iframe{position:absolute;border:0;width:100%;height:100%}.native-standby{opacity:0;pointer-events:none}</style><script src="/frame-controller.js"></script></head><body><div id="status">loading</div><div id="viewer"><iframe id="deck" title="remote slides"></iframe></div><script>
window.poc={reports:[],inputs:[],errors:[],diagnostics:[],rejected:0};
window.start=(origin,state)=>{
  const p=window.poc;
  p.controller=new NativeFrameController(document.getElementById('deck'),{origin,
    onRendered:(report,messageOrigin)=>{p.reports.push({...report,messageOrigin});document.getElementById('status').textContent='rendered '+report.deckId+' '+report.page+':'+report.clickIndex},
    onInput:input=>p.inputs.push(input),onError:error=>{p.errors.push(error);document.getElementById('status').textContent=error},
    onDiagnostic:diagnostic=>p.diagnostics.push(diagnostic)});
  window.addEventListener('message',event=>{if(!p.controller.message(event))p.rejected++});
  p.controller.update(state);
};
</script></body></html>`;

async function verify(remoteOrigin, protocol, metadata) {
  const run = (result.runs[protocol] = {
    remoteOrigin,
    checks: [],
    diagnostics: [],
    trustBypass: protocol === 'https',
  });
  // This flag is scoped to the self-signed HTTPS fixture context, never HTTP.
  const context = await browser.newContext({
    viewport: { width: 1200, height: 760 },
    ...(protocol === 'https' ? { ignoreHTTPSErrors: true } : {}),
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => run.diagnostics.push({ pageError: error.message }));
  const navigations = [];
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() !== page.mainFrame())
      navigations.push(request.url());
  });
  const check = (name, value, details) => {
    run.checks.push({ name, pass: !!value, ...(details === undefined ? {} : { details }) });
    assert.ok(value, name);
  };
  let revision = 0;
  let state;
  const setState = async (deck, pageNumber = 1, clickIndex = 0) => {
    state = {
      deckId: deck.id,
      revision: deck.revision,
      page: pageNumber,
      clickIndex,
      sessionRevision: revision++,
    };
    await page.evaluate((state) => window.poc.controller.update(state), state);
    await page.waitForFunction(
      (state) =>
        window.poc.reports.some(
          (report) =>
            report.deckId === state.deckId &&
            report.page === state.page &&
            report.clickIndex === state.clickIndex &&
            report.sessionRevision === state.sessionRevision,
        ),
      state,
      { timeout: 18000 },
    );
    return page.evaluate(() => window.poc.reports.at(-1));
  };
  try {
    await page.goto(`${result.hostOrigin}/`);
    check('host and remote have different origins', new URL(page.url()).origin !== remoteOrigin);
    const deck = metadata.decks[0];
    state = {
      deckId: deck.id,
      revision: deck.revision,
      page: 1,
      clickIndex: 0,
      sessionRevision: revision++,
    };
    await page.evaluate(({ remoteOrigin, state }) => window.start(remoteOrigin, state), {
      remoteOrigin,
      state,
    });
    await page.waitForFunction(() => window.poc.reports.length > 0, null, { timeout: 18000 });
    const initial = await page.evaluate(() => ({
      report: window.poc.reports.at(-1),
      token: window.poc.controller.active.token,
      mount: window.poc.controller.active.mount,
      src: window.poc.controller.active.frame.src,
    }));
    check(
      'public player renders through its opt-in bridge',
      initial.report.loaded &&
        initial.report.text.trim().length > 0 &&
        initial.report.messageOrigin === remoteOrigin,
      initial,
    );
    const query = new URL(initial.src).searchParams;
    check(
      'controller supplies opt-in, exact parent origin and mount',
      query.get('nativeProtocol') === '1' &&
        query.get('nativeParentOrigin') === result.hostOrigin &&
        query.get('nativeMount') === initial.mount,
    );
    await page.screenshot({ path: resolve(output, `${protocol}-initial.png`) });
    const sameDeckNavs = navigations.length;
    for (let pageNumber = 1; pageNumber <= deck.clickTotals.length; pageNumber++) {
      for (let clicks = 0; clicks <= deck.clickTotals[pageNumber - 1]; clicks++) {
        const report = await setState(deck, pageNumber, clicks);
        const frame = page
          .frames()
          .find((frame) => frame.url().startsWith(`${remoteOrigin}/${deck.id}/`));
        // A nativeRendered acknowledgement may precede the CSS click animation.
        // Confirm final visual state in the actual remote DOM rather than its snapshot.
        await frame.waitForFunction(
          ({ pageNumber, clicks }) => {
            const slide = [...document.querySelectorAll('#slide-content .slidev-page')].find(
              (slide) =>
                Number(slide.dataset.slidevNo) === pageNumber &&
                getComputedStyle(slide).display !== 'none',
            );
            return (
              slide &&
              [...slide.querySelectorAll('.slidev-vclick-target')].filter(
                (element) =>
                  getComputedStyle(element).visibility !== 'hidden' &&
                  Number(getComputedStyle(element).opacity) > 0,
              ).length === clicks
            );
          },
          { pageNumber, clicks },
          { timeout: 3000 },
        );
        const visibleClicks = await frame.evaluate((pageNumber) => {
          const slide = [...document.querySelectorAll('#slide-content .slidev-page')].find(
            (slide) =>
              Number(slide.dataset.slidevNo) === pageNumber &&
              getComputedStyle(slide).display !== 'none',
          );
          return [...slide.querySelectorAll('.slidev-vclick-target')].filter(
            (element) =>
              getComputedStyle(element).visibility !== 'hidden' &&
              Number(getComputedStyle(element).opacity) > 0,
          ).length;
        }, pageNumber);
        check(
          `exact click rendering ${deck.id} ${pageNumber}:${clicks}`,
          report.page === pageNumber && report.clickIndex === clicks && visibleClicks === clicks,
          {
            visibleClicks,
            acknowledgementVisibleClicks: report.clickElements.filter((element) => element.visible)
              .length,
            token: report.documentToken,
          },
        );
      }
    }
    const persistent = await page.evaluate(() => ({
      token: window.poc.controller.active.token,
      stats: window.poc.controller.stats,
    }));
    check(
      'same-deck state updates retain document and avoid navigation',
      persistent.token === initial.token && navigations.length === sameDeckNavs,
      { navigationRequests: navigations.length - sameDeckNavs, stats: persistent.stats },
    );
    for (const current of metadata.decks) {
      const report = await setState(current);
      check(
        `cross-deck render ${current.id}`,
        report.deckId === current.id && !!report.text.trim(),
      );
      check(
        `at most two frames ${current.id}`,
        (await page.locator('#viewer iframe').count()) <= 2,
      );
      const keyFrame = page
        .frames()
        .find((frame) => frame.url().startsWith(`${remoteOrigin}/${current.id}/`));
      const keyRouteBefore = await keyFrame.evaluate(() => location.href);
      const before = await page.evaluate(() => ({
        count: window.poc.inputs.length,
        reports: window.poc.reports.length,
        token: window.poc.controller.active.token,
      }));
      await page.evaluate((remoteOrigin) => {
        const target = window.poc.controller.active.frame.contentWindow;
        target.postMessage({ nativeTestKey: 'Enter' }, remoteOrigin);
        target.postMessage({ nativeTestKeyUp: 'Enter' }, remoteOrigin);
      }, remoteOrigin);
      await page.waitForFunction((count) => window.poc.inputs.length > count, before.count);
      await page.waitForTimeout(100);
      const after = await page.evaluate(() => ({
        inputs: window.poc.inputs,
        reports: window.poc.reports.length,
        token: window.poc.controller.active.token,
      }));
      check(
        `keydown and keyup produce one host input ${current.id}`,
        after.inputs.length === before.count + 1 && after.inputs.at(-1) === 'next',
        { runtimeVersion: report.runtimeVersion, theme: report.theme },
      );
      const nativeTheme = await keyFrame.evaluate(() => ({
        route: location.href,
        hostileInitializations: window.__hostileThemeInitializations || [],
        hostileKeyEvents: window.__hostileKeyEvents || [],
      }));
      check(
        `keyboard waits for host state ${current.id}`,
        after.reports === before.reports &&
          after.token === before.token &&
          nativeTheme.route === keyRouteBefore &&
          nativeTheme.hostileKeyEvents.length === 0,
        nativeTheme,
      );
    }
    const guards = await page.evaluate((remoteOrigin) => {
      const p = window.poc,
        c = p.controller,
        s = c.active;
      const data = { nativeInput: 'next', documentToken: s.token };
      const before = p.inputs.length;
      const forged = c.message({
        source: s.frame.contentWindow,
        origin: 'https://forged.invalid',
        data,
      });
      const nullOrigin = c.message({ source: s.frame.contentWindow, origin: 'null', data });
      const wrongWindow = c.message({ source: window, origin: remoteOrigin, data });
      return { forged, nullOrigin, wrongWindow, unchanged: p.inputs.length === before };
    }, remoteOrigin);
    check(
      'controller rejects forged origin, opaque origin, wrong window',
      !guards.forged && !guards.nullOrigin && !guards.wrongWindow && guards.unchanged,
      { ...guards, method: 'synthetic controller message guard calls' },
    );
    const malformed = await page.evaluate((remoteOrigin) => {
      const p = window.poc;
      const c = p.controller;
      const s = c.active;
      const before = JSON.stringify({
        inputs: p.inputs,
        errors: p.errors,
        stats: c.stats,
        token: s.token,
      });
      for (const data of [
        { nativeInput: 'eraseDeck', documentToken: s.token },
        {
          nativeBridgeReady: {
            protocolVersion: 1,
            deckId: s.deckId,
            mount: s.mount,
            documentToken: 7,
          },
        },
        { nativeFailure: { documentToken: s.token, mount: s.mount, message: {} } },
        { nativeRendered: { ...c.latest, documentToken: s.token, loaded: true } },
      ])
        c.message({ source: s.frame.contentWindow, origin: remoteOrigin, data });
      return (
        before ===
        JSON.stringify({ inputs: p.inputs, errors: p.errors, stats: c.stats, token: s.token })
      );
    }, remoteOrigin);
    check('controller ignores malformed reports and unknown navigation', malformed);
    const activeFrame = page
      .frames()
      .find(
        (frame) =>
          new URL(frame.url()).origin === remoteOrigin && frame.url().includes(`/${state.deckId}/`),
      );
    const routeBefore = await activeFrame.evaluate(() => location.href);
    await activeFrame.evaluate(
      ({ state }) => {
        window.dispatchEvent(
          new MessageEvent('message', {
            source: parent,
            origin: 'https://forged.invalid',
            data: {
              nativeState: { ...state, page: 2, sessionRevision: state.sessionRevision + 1000 },
            },
          }),
        );
      },
      { state },
    );
    await page.waitForTimeout(100);
    check(
      'bridge rejects state with forged parent origin',
      (await activeFrame.evaluate(() => location.href)) === routeBefore,
      { method: 'synthetic bridge message guard call' },
    );
    await activeFrame.evaluate(
      ({ state }) => {
        const origin = new URL(location.href).searchParams.get('nativeParentOrigin');
        for (const patch of [
          { page: 0 },
          { clickIndex: -1 },
          { sessionRevision: -1 },
          { page: state.page === 1 ? 2 : 1, sessionRevision: state.sessionRevision },
        ]) {
          window.dispatchEvent(
            new MessageEvent('message', {
              source: parent,
              origin,
              data: {
                nativeState: { ...state, sessionRevision: state.sessionRevision + 1000, ...patch },
              },
            }),
          );
        }
      },
      { state },
    );
    await page.waitForTimeout(100);
    check(
      'bridge ignores malformed and stale state from the authorized parent',
      (await activeFrame.evaluate(() => location.href)) === routeBefore,
    );
    const errorBefore = await page.evaluate(() => window.poc.errors.length);
    const mismatch = await page.evaluate(() => {
      const s = window.poc.controller.active;
      return {
        nativeBridgeReady: {
          protocolVersion: 999,
          deckId: s.deckId,
          mount: s.mount,
          documentToken: s.token,
        },
      };
    });
    await activeFrame.evaluate(
      (mismatch) =>
        parent.postMessage(mismatch, new URL(location.href).searchParams.get('nativeParentOrigin')),
      mismatch,
    );
    await page.waitForFunction((count) => window.poc.errors.length > count, errorBefore);
    const failure = await page.evaluate(() => ({
      message: window.poc.errors.at(-1),
      text: document.getElementById('status').textContent,
    }));
    check(
      'protocol mismatch surfaces a readable host error',
      /プロトコル/.test(failure.message) && failure.message === failure.text,
      failure,
    );
    await page.screenshot({ path: resolve(output, `${protocol}-protocol-error.png`) });
    const ordinary = await context.newPage();
    await ordinary.goto(`${remoteOrigin}/${deck.id}/1`);
    await ordinary.waitForFunction(() =>
      [...document.querySelectorAll('#slide-content .slidev-page')].some(
        (slide) =>
          slide.dataset.slidevNo === '1' &&
          getComputedStyle(slide).display !== 'none' &&
          !!slide.textContent.trim(),
      ),
    );
    check(
      'ordinary top-level Web player has no Native bridge',
      await ordinary.evaluate(() => !window.__nativeSlidevBridge),
    );
    const hostile = await ordinary.evaluate(() => window.__hostileThemeInitializations || []);
    if (hostile.length) {
      // These regression fixtures intentionally hijack ordinary navigation.
      // Their native isolation is asserted above; preserve their Web setup here.
      await ordinary.keyboard.press('ArrowRight');
      await ordinary.keyboard.press('Enter');
      check(
        'ordinary Web retains intentionally hostile theme listeners',
        await ordinary.evaluate(() => window.__hostileKeyEvents?.length > 0),
        { themes: hostile, normalNavigation: 'intentionally not applicable to hostile fixture' },
      );
    } else {
      await ordinary.keyboard.press('ArrowRight');
      await ordinary.waitForURL((url) => url.pathname.endsWith('/2'));
      check(
        'ordinary ArrowRight navigation works',
        new URL(ordinary.url()).pathname.endsWith('/2'),
      );
      await ordinary.keyboard.press('ArrowRight');
      await ordinary.waitForURL((url) => url.searchParams.get('clicks') === '1');
      check(
        'ordinary ArrowRight advances one click',
        new URL(ordinary.url()).searchParams.get('clicks') === '1',
      );
    }
    await ordinary.screenshot({ path: resolve(output, `${protocol}-ordinary-web.png`) });
    run.stats = await page.evaluate(() => ({
      ...window.poc.controller.stats,
      frameCount: document.querySelectorAll('#viewer iframe').length,
      diagnostics: window.poc.diagnostics,
      navigationRequests: 0,
    }));
    run.stats.navigationRequests = navigations.length;
    run.pass = true;
  } catch (error) {
    run.pass = false;
    run.failure = error.stack;
    run.hostState = await page
      .evaluate(() => ({
        status: document.getElementById('status')?.textContent,
        reports: window.poc?.reports,
        errors: window.poc?.errors,
        diagnostics: window.poc?.diagnostics,
        frames: [...document.querySelectorAll('iframe')].map((frame) => frame.src),
      }))
      .catch(() => null);
    await page.screenshot({ path: resolve(output, `${protocol}-failure.png`) }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

try {
  await mkdir(output, { recursive: true });
  const plainServer = createServer(site);
  const plainOrigin = `http://127.0.0.1:${await listen(plainServer)}`;
  const metadata = await (await fetch(`${plainOrigin}/native-player.json`)).json();
  assert.equal(metadata.protocolVersion, 1);
  assert.ok(metadata.decks.length > 0);
  result.metadata = metadata;
  const host = createHttpServer((request, response) => {
    response.writeHead(200, {
      'content-type': request.url === '/frame-controller.js' ? 'text/javascript' : 'text/html',
      'cache-control': 'no-store',
    });
    response.end(request.url === '/frame-controller.js' ? controllerSource : hostHtml);
  });
  result.hostOrigin = `http://127.0.0.1:${await listen(host)}`;
  const keyPath = resolve(output, 'localhost.key');
  const certPath = resolve(output, 'localhost.crt');
  if (!existsSync(keyPath) || !existsSync(certPath))
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
  const tls = createHttpsServer(
    { key: await readFile(keyPath), cert: await readFile(certPath) },
    (request, response) => {
      const upstream = httpRequest(
        `${plainOrigin}${request.url}`,
        { method: request.method, headers: request.headers },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on('error', (error) => {
        response.writeHead(502);
        response.end(error.message);
      });
      request.pipe(upstream);
    },
  );
  const tlsOrigin = `https://127.0.0.1:${await listen(tls)}`;
  browser = await chromium.launch({
    channel: 'chromium',
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE,
  });
  result.environment = { node: process.version, chromium: await browser.version() };
  await verify(plainOrigin, 'http', metadata);
  await verify(tlsOrigin, 'https', metadata);
} catch (error) {
  result.failure = error.stack;
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  for (const server of servers.reverse())
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        output,
        pass: !process.exitCode,
        runs: Object.fromEntries(
          Object.entries(result.runs).map(([name, run]) => [
            name,
            { pass: run.pass, checks: run.checks.length, failure: run.failure },
          ]),
        ),
      },
      null,
      2,
    ),
  );
}
