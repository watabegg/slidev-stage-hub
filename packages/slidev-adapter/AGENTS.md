# Slidev adapter の実装規約

- Node専用の資料解析・ノート位置計算・Slidev内部APIを扱う。ブラウザーやWorker runtimeへimportしない。
- protocolの公開契約へ依存し、protocolからadapterへの逆依存を作らない。
- 対応するCLI/clientの組み合わせは52.15.2と53.0.0。対応拡張では実際のソースとパッチの一致を検証する。
- ノート位置は元のUTF-8バイト列に対する範囲。日本語・CRLFと、ノート以外のバイトを保つテストを維持する。
- 内部APIや文字パッチの不一致を黙って無視しない。公開manifestへ非公開ソースやノートを出さない。
- ルートの `pnpm test:contracts` で共有契約・adapter・Rustフィクスチャを確認する。
