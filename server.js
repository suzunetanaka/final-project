const express = require('express');
const fs = require('fs');
// API Key などの環境変数は .env.local から読み込む
require('dotenv').config({ path: '.env.local' });

const app = express();
const PORT = process.env.PORT || 8080;
const BOARDGAME_DB_PATH = 'data/boardgames.json';

app.use(express.json());
app.use(express.static('public'));

// ===== 設定 =====
// 利用するLLMプロバイダを選択します（'openai' または 'gemini'）
const PROVIDER = 'openai';

// プロバイダごとに利用するモデル
const MODELS = {
    openai: 'gpt-5.5',        // OpenAI（デフォルト）
    gemini: 'gemini-3.5-flash', // Google Gemini
};
const MODEL = MODELS[PROVIDER];

const OPENAI_API_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';

// public/ 内の .html 一覧を返す（index.html がこの一覧を使ってリンクを表示する）
app.get('/api/pages', (req, res) => {
    const files = fs.readdirSync('public')
        .filter(name => name.endsWith('.html') && name !== 'index.html');
    res.json(files);
});

app.get('/api/boardgames', (req, res) => {
    res.json(loadBoardGames());
});

app.post('/api/boardgames/recommend', (req, res) => {
    try {
        const { players, playTime, difficulty, description = '', count = 5 } = req.body;
        const playerCount = Number(players);
        const maxResults = clampInteger(Number(count), 1, 10, 5);

        if (!Number.isInteger(playerCount) || playerCount < 1) {
            return res.status(400).json({ error: 'players must be a positive integer' });
        }

        const recommendations = recommendBoardGames({
            games: loadBoardGames(),
            players: playerCount,
            playTime,
            difficulty,
            description,
            count: maxResults,
        });

        res.json({
            title: 'ボードゲーム推薦',
            data: recommendations,
        });
    } catch (error) {
        console.error('Board game recommendation error:', error);
        res.status(500).json({ error: 'Failed to recommend board games. Please try again.' });
    }
});

// 問題数の上限（過剰なリクエストでトークンを浪費しないようにする）
const MAX_COUNT = 20;

app.post('/api/', async (req, res) => {
    try {
        // title と、変数置換に使うその他のキーを受け取る
        // （prompt.md がプロンプトを定義するので、リクエストでの上書きは許可しない）
        const { title = 'Generated Content', ...variables } = req.body;

        // count が指定されている場合は 1〜MAX_COUNT の範囲に収める
        if (variables.count !== undefined) {
            const count = Number(variables.count);
            if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
                return res.status(400).json({
                    error: `count must be an integer between 1 and ${MAX_COUNT}`,
                });
            }
        }

        // prompt.md のテンプレート変数 ${key} をリクエストの値で置換する
        const promptTemplate = fs.readFileSync('prompt.md', 'utf8');
        const finalPrompt = fillTemplate(promptTemplate, variables);

        let result;
        if (PROVIDER === 'openai') {
            result = await callOpenAI(finalPrompt);
        } else if (PROVIDER === 'gemini') {
            result = await callGemini(finalPrompt);
        } else {
            return res.status(400).json({ error: 'Invalid provider configuration' });
        }

        res.json({
            title: title,
            data: result,
        });

    } catch (error) {
        // 詳細はサーバーログにのみ出力し、クライアントには汎用メッセージを返す
        console.error('API Error:', error);
        res.status(500).json({ error: 'Failed to generate content. Please try again.' });
    }
});

// prompt.md 内の ${key} を variables の値で安全に置換する
function fillTemplate(template, variables) {
    return template.replace(/\$\{(\w+)\}/g, (match, key) => {
        return Object.prototype.hasOwnProperty.call(variables, key)
            ? String(variables[key])
            : match; // 対応する値がなければそのまま残す
    });
}

function loadBoardGames() {
    const raw = fs.readFileSync(BOARDGAME_DB_PATH, 'utf8');
    return JSON.parse(raw);
}

function clampInteger(value, min, max, fallback) {
    if (!Number.isInteger(value)) {
        return fallback;
    }
    return Math.min(Math.max(value, min), max);
}

function recommendBoardGames({ games, players, playTime, difficulty, description, count }) {
    const timeRange = parsePlayTimeRange(playTime);
    const targetDifficulty = parseDifficultyLevel(difficulty);
    const requestedTags = extractRequestedTags(description);

    const strictMatches = games.filter((game) => players >= game.minPlayers && players <= game.maxPlayers);
    const candidates = strictMatches.length > 0 ? strictMatches : games;

    return candidates
        .map((game) => ({
            ...game,
            score: scoreBoardGame(game, {
                players,
                timeRange,
                targetDifficulty,
                requestedTags,
                strictPlayerMatch: strictMatches.length > 0,
            }),
        }))
        .sort((a, b) => b.score - a.score || a.maxMinutes - b.maxMinutes || a.title.localeCompare(b.title, 'ja'))
        .filter((game, index, sortedGames) => sortedGames.findIndex((item) => item.title === game.title) === index)
        .slice(0, count)
        .map(({ minPlayers, maxPlayers, minMinutes, maxMinutes, difficultyLevel, tags, score, ...game }) => game);
}

function parsePlayTimeRange(playTime) {
    const ranges = {
        '15〜30分': [15, 30],
        '30〜60分': [30, 60],
        '60〜120分': [60, 120],
        '2時間以上': [120, 240],
    };
    return ranges[playTime] || [0, 240];
}

function parseDifficultyLevel(difficulty) {
    const levels = {
        '初心者向け': 1,
        '中級者向け': 2,
        '上級者向け': 3,
    };
    return levels[difficulty] || null;
}

function extractRequestedTags(description) {
    const text = String(description || '').toLowerCase();
    const tagRules = [
        ['cooperative', ['協力', 'みんなで', '全員', 'チーム']],
        ['conversation', ['会話', '話', '盛り上', '雑談', 'コミュニケーション']],
        ['party', ['パーティ', '大人数', '飲み', '軽い', 'わいわい']],
        ['strategy', ['戦略', '考える', 'じっくり', '頭を使う']],
        ['low-luck', ['運要素が少ない', '運少なめ', '実力', '読み合い']],
        ['deduction', ['推理', '正体', 'ミステリー', '犯人']],
        ['bluff', ['ブラフ', '嘘', 'だます', '心理戦']],
        ['two-player', ['2人', '二人', '夫婦', 'カップル', '対戦']],
        ['kids', ['子供', 'こども', '家族', '小学生']],
        ['short', ['短時間', 'すぐ', '軽め', '簡単']],
        ['long', ['長時間', '重め', '本格']],
        ['solo', ['1人', '一人', 'ソロ']],
    ];

    return tagRules
        .filter(([, keywords]) => keywords.some((keyword) => text.includes(keyword)))
        .map(([tag]) => tag);
}

function scoreBoardGame(game, { players, timeRange, targetDifficulty, requestedTags, strictPlayerMatch }) {
    let score = 0;

    if (players >= game.minPlayers && players <= game.maxPlayers) {
        score += 100;
        if (players === game.minPlayers || players === game.maxPlayers) {
            score += 4;
        }
    } else if (!strictPlayerMatch) {
        score -= Math.min(Math.abs(players - game.minPlayers), Math.abs(players - game.maxPlayers)) * 12;
    }

    const overlap = Math.min(game.maxMinutes, timeRange[1]) - Math.max(game.minMinutes, timeRange[0]);
    if (overlap >= 0) {
        score += 35 + overlap;
    } else {
        const distance = Math.min(
            Math.abs(game.minMinutes - timeRange[1]),
            Math.abs(timeRange[0] - game.maxMinutes)
        );
        score -= distance;
    }

    if (targetDifficulty) {
        const difficultyDistance = Math.abs(game.difficultyLevel - targetDifficulty);
        score += difficultyDistance === 0 ? 30 : -difficultyDistance * 14;
    } else {
        score += game.difficultyLevel === 1 ? 8 : 0;
    }

    requestedTags.forEach((tag) => {
        if (game.tags.includes(tag)) {
            score += 18;
        }
    });

    if (requestedTags.includes('short') && game.maxMinutes <= 30) {
        score += 14;
    }
    if (requestedTags.includes('long') && game.minMinutes >= 60) {
        score += 14;
    }

    return score;
}

async function callOpenAI(prompt) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    const response = await fetch(OPENAI_API_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: MODEL,
            messages: [
                { role: 'system', content: prompt }
            ],
            max_completion_tokens: 2000,
            response_format: { type: "json_object" }
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'OpenAI API error');
    }

    const data = await response.json();
    const responseText = data.choices[0].message.content;
    return extractArray(responseText);
}

async function callGemini(prompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY environment variable is not set');
    }

    const response = await fetch(`${GEMINI_API_BASE_URL}${MODEL}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            contents: [{
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                maxOutputTokens: 3000,
                response_mime_type: "application/json"
            }
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Gemini API error');
    }

    const data = await response.json();
    const responseText = data.candidates[0].content.parts[0].text;
    return extractArray(responseText);
}

// LLM が返した JSON 文字列をパースし、最初に見つかった配列を取り出す
function extractArray(responseText) {
    let parsedData;
    try {
        parsedData = JSON.parse(responseText);
    } catch (parseError) {
        throw new Error('Failed to parse LLM response: ' + parseError.message);
    }

    const arrayData = Object.values(parsedData).find(Array.isArray);
    if (!arrayData) {
        throw new Error('No array found in the LLM response object.');
    }
    return arrayData;
}

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Config: ${PROVIDER} - ${MODEL}`);
});
