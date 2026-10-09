# Stage tools

Stage の prepare / connect / doctor と設定・認証ファイルの管理を担当する Node API。CLI の引数や環境変数の解釈は呼び出し元に置きます。

ルートで `pnpm build:packages`、検証は `pnpm test:stage-tools`。公開 API とファイル更新の契約は [Stage ツールガイド](../../docs/guides/stage-tools.md) を参照してください。
