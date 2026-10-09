# 実行環境（2026-10-08）

- 仮説: 計画時の環境でローカルPoCを開始できる。
- 再現: `node scripts/environment.mjs artifacts/environment-before.json`
- 実測: Ubuntu 26.04.1 / Linux 7.0.0-31、Node 24.15.0、pnpm 12.3.4、Rust/Cargo 1.96.1。Wayland。
- テーマ: `fb035f1ebd01f368e937e98f028e1a53d93b4801`、dirty。計画に加え `README.ja.md` も変更済み。全通常ファイルのSHA-256をJSONへ記録。
- 制約: `gtk+-3.0` と `webkit2gtk-4.1` のpkg-configメタデータ不足。ランタイムの有無と区別してnative側で調査。
- 採否: JS基準測定を開始。Tauriの成立性は保留。
- 次: 基準生成物とWebView実測、作業終了時のテーマハッシュ比較。
