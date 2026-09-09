# Amazonize Rakuten

楽天市場をAmazon風のシンプルなUIにするChrome拡張（Manifest V3）。
「シンプル楽天」にインスパイアされたプロジェクトです。

## 機能

| 機能 | 対象ページ | 既定 |
|---|---|---|
| 商品ページをAmazon風の3カラムに再構成 | `item.rakuten.co.jp` | ON |
| 検索結果の広告枠を目立たなくする | `search.rakuten.co.jp` | ON |
| かごの合計金額パネル（ショップ別内訳つき） | `basket.step.rakuten.co.jp` | ON |
| クーポン一覧 / 未取得クーポンの一括取得 | `coupon.rakuten.co.jp` | 一覧ON・自動取得OFF |
| 購入手続きで最良クーポンを自動適用 | `step.item` / `order.step` | ON（適用前に確認） |
| ポイントアップキャンペーンの一括エントリー | `event.rakuten.co.jp` | パネルON・自動エントリーOFF |

自動で「注文を確定」する操作は一切行いません。クーポン適用も、既定では確認ボタンを押したときだけ実行します。

## インストール（Brave / Chrome）

1. `brave://extensions`（Chromeは `chrome://extensions`）を開く
2. 右上の「デベロッパーモード」をON
3. 「パッケージ化されていない拡張機能を読み込む」→ このリポジトリのルートを選択
4. コードを変更したら、拡張機能カードの再読み込みボタンを押してからページを再読み込み

## 設定

ツールバーのアイコンからポップアップを開いて各機能をON/OFFできます。設定は `chrome.storage.sync` に保存され、ページ再読み込みで反映されます。

キャンペーンの一括エントリーは、ポップアップのテキストエリアにURLを1行ずつ書いて「一括エントリーを実行」を押すと、各URLをバックグラウンドタブで開き、エントリーボタンを順にクリックしてタブを閉じます。

## 構成

```
manifest.json
src/lib/settings.js        設定の読み込みと既定値
src/lib/dom.js             セレクタ候補・待機・要素生成などの共通処理
src/lib/coupon-model.js    クーポン文言の解析と最良クーポン選択
src/content/boot.js        ページ種別の判定とモジュールのディスパッチ
src/content/item.js        商品ページの再構成
src/content/search.js      検索結果の整理
src/content/cart.js        かご合計の集計と表示
src/content/coupon.js      クーポン一覧・一括取得
src/content/checkout.js    最良クーポンの自動適用
src/content/campaign.js    キャンペーン自動エントリー
src/background/            service worker（タブ操作・session storage）
src/popup/                 設定UI
```

### 設計方針

- **元のDOMは複製せず移設する。** 商品ページのカートフォームは `appendChild` で新レイアウトへ移動させ、楽天側のイベントハンドラとトークンをそのまま活かします。
- **セレクタは候補リストで持つ。** 各モジュールの `SEL` にセレクタ候補を並べ、最初に見つかったものを使います。楽天のDOM変更時はここだけ直せば追従できます。
- **取得に失敗したら元のページに戻す。** 商品名や価格が取れないときは再構成せず、そのまま楽天のページを表示します。

## 既知の制約 / TODO

- セレクタは実ページのDOMに合わせた**要調整**です。特に商品ページ（`SEL.price` / `SEL.cartForm`）、購入手続きのクーポンUI、かごの小計行は、実際の画面で確認して詰める必要があります。
- 拡張機能アイコン（`icons/*.png`）は未作成。現状はChromeの既定アイコンです。
- クーポンの解析は表示テキストのパターンマッチです。「対象商品のみ」「特定カテゴリのみ」といった条件は判定できません。
- キャンペーンURLの既定値は1件のみ。開催中のキャンペーンURLは手動で追加してください。

## ライセンス

MIT
