# Shared protocol

HubとStageの共有コード。`src/native-player.mjs` は公開discovery manifest、`src/inspect-deck.mjs` は資料・クリック・ノート位置の解析、`src/deck-bridge.ts` はNative専用bridge。`src/globals.d.ts` はIPC・表示状態・bridgeの型を保持する。

`pnpm --filter @slidev-stage-hub/protocol build` でbridgeを `dist/deck-bridge.js` に生成する。Hub/Stageのビルドからも呼ばれる。Rustは不要。まだprivate packageで、公開API・型の粒度は今後整理する。
