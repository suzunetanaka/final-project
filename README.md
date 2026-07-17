# レシピ記録アプリ

条件に合うレシピを提案し、作った記録とレシピ帳を保存できるNode.jsアプリです。
提案はAIが入力条件から直接レシピを生成します。
提案時に保存済みデータを候補として使わず、生成したレシピも自動保存しません。
提案ボタンでは検索や追加候補取得を挟まず、1回のLLM呼び出しで3件を生成します。

## Features

- レシピ提案: 材料、食べたいもの、時間、難易度、人数をもとに推薦
- レシピ帳: 気に入ったレシピを保存
- 調理記録: 満足度、メモをブラウザのローカルストレージに保存
- AI調整: 提案または保存したレシピを好みに合わせて調整
- Markdownプロンプト: `prompt.md` でレシピ提案のAI方針を管理

## Quick Start

### 1. Installation

```bash
npm install
```

### 2. Environment Setup

Copy `.env.example` to `.env.local` and set your API key:

```bash
cp .env.example .env.local
```

Edit `.env.local`:
```env
# For OpenAI (default)
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-5.6-luna
OPENAI_REASONING_EFFORT=low

# For Gemini (if switching)
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-3.5-flash

LLM_PROVIDER=openai
LLM_TIMEOUT_MS=60000
PORT=8080
```

> `.env.local` holds your real keys and is git-ignored. Do not commit it.

### 3. Configure LLM Provider

Set `LLM_PROVIDER` in `.env.local`:

```env
# For OpenAI (default)
LLM_PROVIDER=openai

# For Gemini
LLM_PROVIDER=gemini
```

The model is selected from `OPENAI_MODEL` or `GEMINI_MODEL`.

### 4. Start Server

```bash
npm start
```

Visit `http://localhost:8080`

## How It Works

### Architecture

```
Client → POST /api/recipes/recommend → server.js → prompt.md → LLM
```

### Main Files

- `public/index.html` - Recipe recommendation and cooking record interface
- `public/recipe.css` - Recipe-specific styles
- `data/recipes.json` - 互換用のレシピ保存ファイル（提案処理では使用しません）
- ブラウザの `localStorage.recipeRecords` - Saved cooking records
- `data/recipe-favorites.json` - Saved favorite recipes
- `prompt.md` - Recipe recommendation prompt used by the recommendation API

## File Structure

```
final-project/
├── server.js          # API server
├── prompt.md          # Application-specific prompt template
├── data/
│   ├── recipes.json   # Hidden recipe recommendation database
│   ├── recipe-records.json # Legacy server-side cooking records file
│   └── recipe-favorites.json # Saved favorite recipes
├── package.json       # Dependencies
├── .env.example       # Environment variables template
├── public/            # Static files
│   ├── index.html    # Recipe journal application
│   ├── style.css     # Base styles
│   └── recipe.css    # Recipe-specific styles
└── README.md         # This file
```

## Prompt Usage

`/api/recipes/recommend` は `prompt.md` に以下の変数を渡します。

- `${ingredients}`: 使いたい材料
- `${craving}`: 食べたいもの・気分
- `${time}`: 希望調理時間
- `${difficulty}`: 希望難易度
- `${servings}`: 人数
- `${count}`: 提案件数

AIは入力条件から新規レシピを直接生成します。提案時に保存済みデータを候補として使わず、生成レシピも自動保存しません。プロンプトは速度を優先して短く保ちます。

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GEMINI_API_KEY` | Google Gemini API key | Yes (if using Gemini) |
| `GEMINI_MODEL` | Gemini model name | No (default: gemini-3.5-flash) |
| `OPENAI_API_KEY` | OpenAI API key | Yes (if using OpenAI) |
| `OPENAI_MODEL` | OpenAI model name | No (default: gpt-5.6-luna) |
| `OPENAI_REASONING_EFFORT` | OpenAI reasoning effort | No (default: low) |
| `LLM_PROVIDER` | AI provider (`openai` or `gemini`) | No (default: openai) |
| `PORT` | Server port | No (default: 8080) |
| `LLM_TIMEOUT_MS` | AI recommendation timeout in milliseconds | No (default: 60000) |

## LLM Provider Configuration

### Switch to OpenAI (default)

Set OpenAI provider and API key in `.env.local`:
```env
LLM_PROVIDER=openai
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-5.6-luna
```

### Switch to Gemini

Set Gemini provider and API key in `.env.local`:
```env
LLM_PROVIDER=gemini
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-3.5-flash
```

## Development

### Run with auto-restart:
```bash
npm run dev
```

### Supported Models

**OpenAI:**
- `gpt-5.6-luna` (default)
- `gpt-5.6`
- `gpt-5.6-terra`

**Gemini:**
- `gemini-3.5-flash`

## License

MIT

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request
