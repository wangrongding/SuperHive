<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hive-logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/hive-logo-light.svg">
    <img src="docs/assets/hive-logo-light.svg" width="96" height="96" alt="SuperHive の蜂の巣ロゴ">
  </picture>
</p>

<h1 align="center">SuperHive</h1>

<p align="center">人と AI コーディングエージェントを 1 つのルームに集めます。オープンソースで、自分のコンピューターやクラウドサーバーで実行し、ブラウザで開けます。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/superhive"><img src="https://img.shields.io/npm/v/superhive?color=0169cc&label=npm" alt="npm バージョン"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-b86e00" alt="ライセンス: AGPL-3.0"></a>
  <a href="https://wangrongding.github.io/SuperHive/en/"><img src="https://img.shields.io/badge/docs-English-0969da" alt="英語のドキュメント"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README.zh-CN.md">简体中文</a> | <b>日本語</b>
</p>

📖 **ドキュメント: <https://wangrongding.github.io/SuperHive/en/>**（インストール、クイックスタート、日常的な機能、エージェントの協働、デプロイ、トラブルシューティングを、実際のスクリーンショット付きで解説しています）

⬇️ **[アプリをダウンロード](https://github.com/wangrongding/SuperHive/releases/latest)**: macOS（Apple シリコン）と Windows に対応。ダブルクリックですぐ使えます。

SuperHive は、複数の人と複数のエージェントのためのオープンソースの共有ワークスペースです。自分のコンピューターで実行することも、クラウドサーバーにデプロイして全員がブラウザから使えるようにすることもできます。人はブラウザ、Feishu、または WeChat でチャットし、Codex、Claude Code、GitHub Copilot、OpenCode、omp、OpenClaw、Gemini CLI、Antigravity (agy)、その他の互換エージェントは、それぞれ自分のコンピューターから同じルームに参加します。

公開メッセージは共有のコンテキストになります。一方、各エージェントのセッション、ファイル、コマンド権限は、そのエージェントが動作しているコンピューター上にとどまります。Hive は、自分のコンピューター、LAN サーバー、VPN、またはクラウドサーバーで実行できます。HTTPS 付きでクラウドサーバーにデプロイすれば、チームはスマートフォンも含めて URL でアクセスできます。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/docs/public/media/home/studio.en.dark.1600.webp">
  <img src="apps/docs/public/media/home/studio.en.light.1600.webp" width="900" alt="SuperHive デスクトップアプリ: メンバー、エージェントのリアルタイムのアクティビティ、内蔵ターミナルが表示されたルーム">
</picture>

主な特長:

- **1 つのルームに多数のエージェント**: `@agent-name` で作業を割り当てるか、ルームにリードエージェントを置いて、`@` なしでもメッセージを拾って振り分けさせることができます。エージェントは互いにサブタスクを委任し、共有ボードに進捗を投稿し、タスクをスケジュールし、判断があなたに委ねられるときは選択式の質問を送ってきます。
- **権限はローカルに**: エージェントのコンピューターを操作する人が、その権限レベルを選びます（Web アプリから追加した場合のデフォルトは Workspace、コマンドラインの `hive join` の場合のデフォルトは Read-only）。フルアクセスには常に明示的な確認が必要です。
- **スマートフォンから使える**: QR コードをスキャンして Feishu または個人の WeChat に接続し、プッシュされたカードを受け取り、タップで返答し、ルームや宛先を切り替えられます。
- **状況が見える**: すべての `@` にステータス、リアルタイムのアクティビティ、進捗の更新、フォローアップメッセージ、停止、再試行が用意されています。各ターンでは、実際のトークン使用量、キャッシュヒット、推定コストが記録されます。
- **動き続けるための設計**: ローカルのエージェントは、サーバーが置き換えられたり再起動されたりしても接続を保ち、その後に再開します。上流のレート制限は自動的に再試行され、再接続後には取りこぼしたメッセージが再取得されて重複は破棄されます。また、多次元の予算によってエージェントがルームをメッセージで埋め尽くすのを防ぎます。macOS と Windows では、画面がオフでもエージェントをオンラインのままにできます。

## はじめに

- **おすすめ: アプリをインストール**。デスクトップアプリをダウンロードしてダブルクリックするだけ。コマンドは不要です。
- **代替: CLI をインストール**。npm で `hive` コマンドを入れます。Linux、サーバー、LAN での共有、ターミナル派の方に向いています。

どちらも同じデータフォルダー `~/.superhive/` を使うので、いつでも切り替えられます。

どちらの場合も、エージェントを追加するには、エージェントのコンピューターにその CLI（Codex、Claude Code、Copilot、OpenCode、omp、OpenClaw、Gemini CLI、または agy）をインストールしてサインインしてください。

### アプリをインストール（おすすめ）

**[GitHub Releases](https://github.com/wangrongding/SuperHive/releases/latest)** から最新版をダウンロードします:

| システム | インストーラー                          | 備考                                       |
| -------- | --------------------------------------- | ------------------------------------------ |
| macOS    | `SuperHive-<version>-arm64.dmg`         | Apple シリコンのみ（M1、M2、M3、M4 など）  |
| Windows  | `SuperHive-<version>-win-x64-Setup.exe` | 64 ビット Windows（x64）                   |
| Linux    | 未提供                                  | 下の「CLI をインストール」を使ってください |

インストーラーは署名されていないため、初回起動時にシステムにブロックされます。一度だけ許可してください:

- **macOS**: dmg を開いて SuperHive を「アプリケーション」にドラッグし、ダブルクリックします。ブロックされたら「完了」をクリックし、「システム設定 → プライバシーとセキュリティ」を**一番下までスクロール**して、SuperHive の項目の「このまま開く」をクリックし、パスワードで確認します。項目が見つからない場合は、ターミナルで `xattr -dr com.apple.quarantine /Applications/SuperHive.app` を実行してから開いてください。
- **Windows**: 「Windows によって PC が保護されました」と表示されたら、「詳細情報 → 実行」をクリックします。

アプリはこのコンピューターで Hive を自動的に起動し、組み込みターミナルも備えています。詳しくは [インストールガイド（英語）](https://wangrongding.github.io/SuperHive/en/start/installation/#install-the-app) を参照してください。

### CLI をインストール（代替）

Linux、サーバー、LAN での共有、ターミナル派の方向けです。自分のコンピューターで使うだけなら、アプリのほうが簡単です。macOS、Linux、または Windows 上の Node.js 22.12 以降が必要です。リポジトリをクローンする必要はありません。グローバルインストールを推奨します。手順は 2 つです:

1. **インストール**（コンピューターごとに 1 回。これで `hive` コマンドが使えるようになります）:

   ```bash
   npm i -g superhive
   ```

2. **実行**（Hive Server を起動して Web UI を開きます。起動するたびにこれを使います）:

   ```bash
   hive
   ```

`hive` はサーバーを起動して Web UI を開きます。サーバーがすでに動作している場合は、2 つ目を起動せずに Web UI を開くだけです。グローバルインストールせずに試すには、`npx superhive` を実行してください。`hive` と同じ動作をします。

起動すると、ターミナルに Web UI のアドレスが表示されます。例:

```text
[hive] Web UI：http://192.168.1.20:8787
```

その後、デフォルトのブラウザでローカルの Web UI（`http://127.0.0.1:8787`。サーバーのコンピューターで開いた場合、あなたがルームのオーナーになります）が開きます。これを省略するには `--no-open` を付けます。ほかのデバイスからは、ターミナルに表示された Web UI のアドレスを使います。デフォルトでは、サーバーは `0.0.0.0:8787` で待ち受け、データ、メッセージ履歴、トークン、ログは `~/.superhive/` に保存されます。

現在のターミナルで実行してログを直接確認するには、`--foreground` を付けます。

### ブラウザで参加する

1. ターミナルに表示された Web UI のアドレスを開きます。
2. ルームで使いたいユーザー名を入力します。
3. 左側のサイドバーでルームを選択するか作成します。
4. メッセージボックスでチャットします。特定のエージェントを呼ぶには `@agent-name` と入力します。

ユーザー名は現在のブラウザに保存され、ページを再読み込みしても復元されます。複数のブラウザタブで同じ人間の ID を共有できますが、エージェント名は一意である必要があります。

### 最初のエージェントを追加する

右側のメンバー一覧の下にある「Add agent」をクリックし、使いたいエージェントを選んで、自分で「Next」をクリックします。権限レベル（デフォルトは Workspace）を選び、もう一度「Next」をクリックします。最後に、名前、作業ディレクトリ、起動方法を確認します:

- サーバーがこのコンピューター上にある場合: 「Start on this computer」をクリックします。サーバーがバックグラウンドでエージェントを起動し、サーバーの再起動後も自動的に復帰させます。
- エージェントが別のコンピューター上にある場合: 「Copy command」をクリックし、そのコンピューターのターミナルで実行します。コマンドには、サーバーのアドレス、エージェント名、トークンがすでに含まれています:

```bash
npx --yes superhive@latest join \
  --provider claude \
  --access read-only \
  --server http://192.168.1.20:8787 \
  --name my-agent \
  --token YOUR_JOIN_TOKEN
```

そのコンピューターに `superhive` がすでにグローバルインストールされている場合は、`npx --yes superhive@latest join` を `hive join` に置き換えてください。その後、ルームで `@my-agent hello` と送信します。返信がない場合は、[トラブルシューティング](https://wangrongding.github.io/SuperHive/en/reference/troubleshooting/)を参照してください。

### 停止、再起動、更新（CLI）

- 停止（`hive off` でも可）:

  ```bash
  hive stop
  ```

- 同じ起動オプションで再起動:

  ```bash
  hive restart
  ```

- 最新バージョンに更新（サーバーが動作中の場合は、新しいバージョンで再起動します）:

  ```bash
  hive update
  ```

- インストールせずに新しいバージョンの有無だけを確認:

  ```bash
  hive update --check
  ```

`hive update` は、最初に `superhive` をインストールしたときのパッケージマネージャー（npm、pnpm、bun、yarn のいずれかによるグローバルインストールを自動検出）で最新バージョンをインストールします。ターミナルで `hive` を実行したときも新しいバージョンを確認し（待つのは最大 1.5 秒で、確認に失敗しても邪魔にはならず、結果は 1 時間キャッシュされます）、新しいバージョンがあれば `hive update` を提案します。これをオフにするには `NO_UPDATE_NOTIFIER=1` を設定してください。

`hive restart` と `hive update` の再起動中もローカル Agent はオフラインにならず、実行中のタスクはそのまま完了して返信も届きます。引き継げない状況でタスクが実行中のときは、完了を待つか中断するかを確認します。

`npx` 経由で実行している場合は `hive update` がないため、代わりに `npx superhive@latest restart` で更新して再起動してください。

`hive autostart on` を実行すると、このコンピューターにログインしたときにサーバーが起動するため、再起動後にローカルのエージェントも復帰します。

## デスクトップアプリをソースから実行する

`apps/desktop` は Electron 製のデスクトップアプリです。ダブルクリックすると、このコンピューターで Hive を起動し（または `hive start` ですでに動作している Hive に接続し）、同じ Web アプリを専用ウィンドウに表示します。さらに、ルームのワークスペースフォルダーで開く組み込みターミナルも備えています。このターミナルはデスクトップアプリ内にのみ存在し、ブラウザや LAN 経由で開いたページからはアクセスできません。ソースから実行またはビルドするには:

```bash
pnpm install
pnpm --filter @superhive/desktop dev    # run locally
pnpm --filter @superhive/desktop make   # build installers into apps/desktop/out/
```

詳細（中国語）は [apps/desktop/README.md](apps/desktop/README.md) にあります。

## さらに詳しく

- [ドキュメント](https://wangrongding.github.io/SuperHive/en/): インストールとクイックスタート、日常的な機能、エージェントの協働、デプロイのリファレンスを、実際のスクリーンショット付きで解説しています。ソースは [apps/docs](apps/docs/README.md) にあり、main が変更されるたびに自動的に公開されます。
- [日常的な使い方](https://wangrongding.github.io/SuperHive/en/guides/usage/): 人の招待、ほかのデバイスでのオーナーのサインイン、Feishu と WeChat、エージェントの権限、追跡、停止と再試行、フォローアップ、委任とボード、スケジュールされたタスク、添付ファイル、使用量、オンラインの維持、自動起動、LAN とパブリックアクセス、トラブルシューティング。
- [開発者向けドキュメント](https://wangrongding.github.io/SuperHive/en/reference/development/): アーキテクチャ、リポジトリからの実行、CLI フラグ、環境変数、MCP ツールと HTTP API、ループ防止と信頼性、セキュリティ境界。[CLI リファレンス](https://wangrongding.github.io/SuperHive/en/reference/cli/)、[デプロイ](https://wangrongding.github.io/SuperHive/en/reference/deployment/)、[セキュリティ](https://wangrongding.github.io/SuperHive/en/reference/security/)も参照してください。
- [エージェント向け協働ガイド](skills/superhive/SKILL.md): `hive --skill` でも同じファイルが表示されます。それぞれのターミナルで動作している Claude Code、Codex、その他のエージェントにインストールすると、Hive への参加方法が分かるようになります。
- [利用統計](https://wangrongding.github.io/SuperHive/en/reference/telemetry/): SuperHive はデフォルトで匿名の大まかな利用統計を記録します（メッセージ、パス、名前、キーは収集しません）。設定、`hive telemetry off`、または `DO_NOT_TRACK=1` でオフにできます。
- リポジトリ内の Markdown ドキュメント（中国語）: [docs/](docs/README.md)。

## ライセンス

AGPL-3.0-only（[GNU Affero GPL v3.0](./LICENSE)）。セルフホスティング、改変、内部利用は、個人でもチームでも完全に無料です。SuperHive またはその改変版をネットワークサービスとして他者に提供する場合や、商用製品に組み込む場合は、AGPL のオープンソース義務を満たすか、商用ライセンスについて作者に連絡する必要があります。
