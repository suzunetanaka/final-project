const express = require('express');
const fs = require('fs');
// API Key などの環境変数は .env.local から読み込む
require('dotenv').config({ path: '.env.local' });

const app = express();
const PORT = process.env.PORT || 8080;
const RECIPE_DB_PATH = 'data/recipes.json';
const RECIPE_RECORDS_PATH = 'data/recipe-records.json';
const RECIPE_FAVORITES_PATH = 'data/recipe-favorites.json';

app.use(express.json());
app.use(express.static('public'));

// ===== 設定 =====
// 利用するLLMプロバイダを選択します（'openai' または 'gemini'）
const PROVIDER = String(process.env.LLM_PROVIDER || 'openai').trim().toLowerCase();

// プロバイダごとに利用するモデル
const MODELS = {
    openai: process.env.OPENAI_MODEL || 'gpt-5.6-luna', // OpenAI（デフォルト）
    gemini: process.env.GEMINI_MODEL || 'gemini-3.5-flash', // Google Gemini
};
const MODEL = MODELS[PROVIDER];
if (!MODEL) {
    throw new Error(`Invalid LLM_PROVIDER: ${PROVIDER}. Use "openai" or "gemini".`);
}

const OPENAI_API_ENDPOINT = 'https://api.openai.com/v1/responses';
const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const LLM_TIMEOUT_MS = parsePositiveInteger(process.env.LLM_TIMEOUT_MS, 60000);
const OPENAI_REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || 'low';

// public/ 内の .html 一覧を返す
app.get('/api/pages', (req, res) => {
    const files = fs.readdirSync('public')
        .filter(name => name.endsWith('.html') && name !== 'index.html');
    res.json(files);
});

app.get('/api/recipes', (req, res) => {
    res.json(loadRecipes());
});

app.get('/api/recipe-records', (req, res) => {
    res.json(loadRecipeRecords());
});

app.get('/api/recipe-favorites', (req, res) => {
    const favorites = loadRecipeFavorites();
    const recipes = loadRecipes();
    const favoriteRecipes = favorites
        .map((favorite) => {
            const recipe = recipes.find((item) => item.id === favorite.recipeId);
            return recipe ? { ...recipe, favoritedAt: favorite.createdAt } : null;
        })
        .filter(Boolean);

    res.json(favoriteRecipes);
});

app.post('/api/recipes/recommend', async (req, res) => {
    try {
        const {
            ingredients = '',
            craving = '',
            time = '～30分',
            difficulty = 'おまかせ',
            servings = 2,
            count = 3,
        } = req.body;
        const maxResults = clampInteger(Number(count), 1, 6, 3);
        const targetServings = clampInteger(Number(servings), 1, 8, 2);

        let recommendations;
        try {
            recommendations = await recommendRecipesWithPrompt({
                ingredients,
                craving,
                time,
                difficulty,
                servings: targetServings,
                count: maxResults,
            });
        } catch (promptError) {
            console.warn('Prompt-based recommendation failed:', promptError.message);
            return res.status(502).json({
                error: `レシピ提案AIの呼び出しに失敗しました: ${promptError.message}`,
            });
        }

        res.json({
            title: 'レシピ提案',
            data: recommendations,
        });
    } catch (error) {
        console.error('Recipe recommendation error:', error);
        res.status(500).json({ error: 'Failed to recommend recipes. Please try again.' });
    }
});

app.post('/api/recipes/adjust', async (req, res) => {
    try {
        const recipeId = String(req.body.recipeId || '').trim();
        const adjustment = String(req.body.adjustment || '').trim();
        const recipeFromRequest = normalizeRecipe(req.body.recipe || {});
        const recipe = loadRecipes().find((item) => item.id === recipeId)
            || (recipeFromRequest.title ? recipeFromRequest : null);

        if (!recipe) {
            return res.status(404).json({ error: 'Recipe not found' });
        }

        if (!adjustment) {
            return res.status(400).json({ error: 'adjustment is required' });
        }

        const adjustedRecipe = await adjustRecipeWithAI(recipe, adjustment);
        res.json({
            title: '調整後レシピ',
            data: adjustedRecipe,
        });
    } catch (error) {
        console.error('Recipe adjustment error:', error);
        res.status(500).json({ error: 'Failed to adjust recipe. Please try again.' });
    }
});

app.post('/api/recipe-favorites', (req, res) => {
    try {
        const recipeId = String(req.body.recipeId || '').trim();
        const recipe = loadRecipes().find((item) => item.id === recipeId);

        if (!recipe) {
            return res.status(404).json({ error: 'Recipe not found' });
        }

        const wasCreated = saveRecipeFavorite(recipeId);

        res.status(wasCreated ? 201 : 200).json(recipe);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.delete('/api/recipe-favorites/:recipeId', (req, res) => {
    const favorites = loadRecipeFavorites();
    const nextFavorites = favorites.filter((item) => item.recipeId !== req.params.recipeId);
    saveJson(RECIPE_FAVORITES_PATH, nextFavorites);
    res.status(204).end();
});

app.post('/api/recipe-records', (req, res) => {
    try {
        const record = createRecipeRecord(req.body);
        const records = loadRecipeRecords();
        records.unshift(record);
        saveJson(RECIPE_RECORDS_PATH, records);
        res.status(201).json(record);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.delete('/api/recipe-records/:id', (req, res) => {
    try {
        const records = loadRecipeRecords();
        const recordId = decodeURIComponent(String(req.params.id || ''));
        const nextRecords = records.filter((item) => item.id !== recordId);

        saveJson(RECIPE_RECORDS_PATH, nextRecords);
        res.json({ ok: true, id: recordId, deleted: nextRecords.length !== records.length });
    } catch (error) {
        console.error('Recipe record delete error:', error);
        res.status(500).json({ error: 'Failed to delete recipe record. Please try again.' });
    }
});

// 生成件数の上限（過剰なリクエストでトークンを浪費しないようにする）
const MAX_COUNT = 10;

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

function parsePositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function loadRecipes() {
    return loadJsonArray(RECIPE_DB_PATH).map(normalizeRecipe);
}

function loadRecipeRecords() {
    return loadJsonArray(RECIPE_RECORDS_PATH);
}

function loadRecipeFavorites() {
    return loadJsonArray(RECIPE_FAVORITES_PATH);
}

function saveRecipeFavorite(recipeId) {
    const favorites = loadRecipeFavorites();
    const existing = favorites.find((item) => item.recipeId === recipeId);

    if (existing) {
        return false;
    }

    favorites.unshift({
        recipeId,
        createdAt: new Date().toISOString(),
    });
    saveJson(RECIPE_FAVORITES_PATH, favorites);
    return true;
}

function loadJson(filePath, fallback) {
    if (!fs.existsSync(filePath)) {
        return fallback;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
        return fallback;
    }

    return JSON.parse(raw);
}

function loadJsonArray(filePath) {
    const data = loadJson(filePath, []);
    return Array.isArray(data) ? data : [];
}

function normalizeRecipe(recipe) {
    recipe = recipe || {};

    return {
        ...recipe,
        id: String(recipe.id || ''),
        title: String(recipe.title || ''),
        category: String(recipe.category || ''),
        time: String(recipe.time || ''),
        minutes: Number(recipe.minutes || 0),
        difficulty: String(recipe.difficulty || ''),
        difficultyLevel: Number(recipe.difficultyLevel || 0),
        servings: String(recipe.servings || ''),
        summary: String(recipe.summary || ''),
        ingredients: normalizeStringArray(recipe.ingredients),
        tags: normalizeStringArray(recipe.tags),
        steps: normalizeStringArray(recipe.steps),
        adjustmentTips: String(recipe.adjustmentTips || ''),
    };
}

function normalizeStringArray(value) {
    if (Array.isArray(value)) {
        return value.map((item) => String(item)).filter((item) => item.trim());
    }

    if (typeof value === 'string') {
        return value
            .split(/\n|。|;|；/)
            .map((item) => item.replace(/^\s*[\d０-９]+[.)．、]\s*/, '').trim())
            .filter(Boolean);
    }

    return [];
}

function saveJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function clampInteger(value, min, max, fallback) {
    if (!Number.isInteger(value)) {
        return fallback;
    }
    return Math.min(Math.max(value, min), max);
}

function hasRecommendationInput(ingredients, craving) {
    return splitWords(ingredients).length > 0 || splitWords(craving).length > 0;
}

function recommendRecipes({ recipes, records, favorites, ingredients, craving, time, difficulty, servings, count }) {
    const availableWords = splitWords(ingredients);
    const cravingWords = splitWords(craving);
    const maxMinutes = parseRecipeTimeLimit(time);
    const targetDifficulty = parseRecipeDifficulty(difficulty);
    const requestedTags = extractRecipeTags(`${ingredients} ${craving}`);
    const profile = buildRecipeProfile(records, recipes, favorites);
    const candidateRecipes = filterRecipeCandidates(recipes, {
        availableWords,
        cravingWords,
        requestedTags,
    });

    return candidateRecipes
        .map((recipe) => {
            const ingredientMatchCount = countRecipeIngredientMatches(recipe, availableWords);
            const score = scoreRecipe(recipe, {
                availableWords,
                cravingWords,
                maxMinutes,
                targetDifficulty,
                requestedTags,
                profile,
            });

            return {
                ...recipe,
                ingredientMatchCount,
                matchScore: score,
                reason: buildRecipeReason(recipe, {
                    availableWords,
                    cravingWords,
                    requestedTags,
                    profile,
                }),
                personalizedAdjustment: buildPersonalizedAdjustment(recipe, profile),
            };
        })
        .sort((a, b) =>
            b.ingredientMatchCount - a.ingredientMatchCount
            || b.matchScore - a.matchScore
            || a.minutes - b.minutes
            || a.title.localeCompare(b.title, 'ja')
        )
        .slice(0, count)
        .map(({ ingredientMatchCount, matchScore, ...recipe }) => scaleRecipeServings(recipe, servings));
}

function filterRecipeCandidates(recipes, { availableWords, cravingWords, requestedTags }) {
    if (availableWords.length > 0) {
        const materialMatchedRecipes = recipes.filter((recipe) =>
            recipeMatchesMinimumIngredients(recipe, availableWords)
        );

        if (materialMatchedRecipes.length > 0) {
            return materialMatchedRecipes;
        }

        return [];
    }

    const hasUserSignal = availableWords.length > 0 || cravingWords.length > 0 || requestedTags.length > 0;

    if (!hasUserSignal) {
        return recipes;
    }

    const matchedRecipes = recipes.filter((recipe) => recipeMatchesUserSignal(recipe, {
        availableWords,
        cravingWords,
        requestedTags,
    }));

    return matchedRecipes;
}

function recipeMatchesMinimumIngredients(recipe, availableWords) {
    return availableWords.length === 0 || countRecipeIngredientMatches(recipe, availableWords) > 0;
}

function recipeMatchesRequest(recipe, { availableWords, cravingWords, requestedTags }) {
    if (availableWords.length > 0) {
        return recipeMatchesMinimumIngredients(recipe, availableWords);
    }

    return true;
}

function recipeFitsRequestedLimits(recipe, { maxMinutes, targetDifficulty }) {
    if (Number.isFinite(maxMinutes) && recipe.minutes > maxMinutes + 5) {
        return false;
    }

    if (targetDifficulty && recipe.difficultyLevel > targetDifficulty + 1) {
        return false;
    }

    return true;
}

function countRecipeIngredientMatches(recipe, availableWords) {
    if (availableWords.length === 0) {
        return 0;
    }

    const ingredientText = recipe.ingredients.join(' ').toLowerCase();
    const matchedWords = availableWords.filter((word) =>
        expandIngredientWordAliases(word).some((alias) => ingredientText.includes(alias))
    );
    return new Set(matchedWords).size;
}

function expandIngredientWordAliases(word) {
    const normalizedWord = String(word || '').toLowerCase();
    const aliases = {
        'たまご': ['たまご', '卵'],
        '玉葱': ['玉葱', '玉ねぎ', 'たまねぎ'],
        'たまねぎ': ['たまねぎ', '玉ねぎ', '玉葱'],
        '豚肉': ['豚肉', '豚こま', '豚バラ', '豚'],
        '鶏肉': ['鶏肉', '鶏もも', '鶏むね', '鶏ひき'],
        '牛肉': ['牛肉', '牛'],
        'きのこ': ['きのこ', 'しめじ', 'えのき', 'しいたけ', '舞茸', 'まいたけ'],
        'ネギ': ['ネギ', 'ねぎ', '長ねぎ', '青ねぎ'],
        '葱': ['葱', 'ねぎ', '長ねぎ', '青ねぎ'],
    };

    return aliases[normalizedWord] || [normalizedWord];
}

function recipeMatchesUserSignal(recipe, { availableWords, cravingWords, requestedTags }) {
    const searchableText = [
        recipe.title,
        recipe.category,
        recipe.summary,
        recipe.ingredients.join(' '),
        recipe.tags.join(' '),
    ].join(' ').toLowerCase();
    const words = [...availableWords, ...cravingWords];

    return words.some((word) => searchableText.includes(word))
        || requestedTags.some((tag) => recipe.tags.includes(tag));
}

function splitWords(text) {
    const normalizedText = String(text || '')
        .toLowerCase()
        .replace(/[・/／&＆＋+]/g, '、')
        .replace(/(?:を)?使(?:った|う|って|いたい|い切る)/g, '、')
        .replace(/(?:を)?入(?:れた|れる)/g, '、')
        .replace(/(?:が)?ある/g, '、')
        .replace(/([ァ-ヶー一-龠々])(?:と|や)(?=[ァ-ヶー一-龠々])/g, '$1、');

    return normalizedText
        .split(/[、,\s]+/)
        .map((word) => word.trim())
        .map((word) => word.replace(/^(材料|食材|具材|あと|それと|それから|できれば|なるべく|できるだけ|余り|残り|冷蔵庫の)/, ''))
        .map((word) => word.replace(/(入り|使用|あり|で|から|だけ|など|くらい|ぐらい)$/g, ''))
        .flatMap(splitKnownIngredientWords)
        .filter(Boolean);
}

function splitKnownIngredientWords(word) {
    const normalizedWord = String(word || '').trim();
    if (!normalizedWord) {
        return [];
    }

    const knownIngredients = [
        'トマト', 'チーズ', '卵', 'たまご', '玉ねぎ', 'たまねぎ', '玉葱',
        'じゃがいも', 'にんじん', 'キャベツ', 'レタス', 'きゅうり', 'なす',
        'ピーマン', 'ほうれん草', '小松菜', 'ねぎ', 'ネギ', '長ねぎ',
        '豆腐', 'とうふ', '納豆', '鶏肉', '鶏もも', '鶏むね', '豚肉',
        '豚こま', '豚バラ', '牛肉', 'ひき肉', '鮭', 'サバ', 'ツナ',
        'えび', 'いか', 'ご飯', 'ごはん', '米', 'パスタ', 'うどん',
        'そば', 'パン', 'きのこ', 'しめじ', 'えのき', 'しいたけ',
    ];
    const matchedIngredients = knownIngredients.filter((ingredient) =>
        normalizedWord.includes(ingredient.toLowerCase())
    );

    if (matchedIngredients.length >= 2) {
        return Array.from(new Set(matchedIngredients));
    }

    return [normalizedWord];
}

function parseRecipeTimeLimit(time) {
    const text = String(time || '');
    if (text.includes('60') && (text.includes('～') || text.includes('以上'))) return 180;
    if (text.includes('15')) return 15;
    if (text.includes('30')) return 30;
    if (text.includes('45')) return 45;
    if (text.includes('60')) return 60;
    return 180;
}

function parseRecipeMinutes(time, fallback = 30) {
    const match = String(time || '').match(/(\d+)/);
    return match ? Number(match[1]) : fallback;
}

function parseRecipeDifficulty(difficulty) {
    const levels = {
        'かんたん': 1,
        'ふつう': 2,
        'こだわり': 3,
    };
    return levels[difficulty] || null;
}

function scaleRecipeServings(recipe, targetServings) {
    const baseServings = parseServings(recipe.servings);
    if (!baseServings || !targetServings || baseServings === targetServings) {
        return recipe;
    }

    const ratio = targetServings / baseServings;
    return {
        ...recipe,
        servings: `${targetServings}人分`,
        ingredients: recipe.ingredients.map((ingredient) => scaleIngredientText(ingredient, ratio)),
    };
}

function parseServings(servings) {
    const match = String(servings || '').match(/(\d+)/);
    return match ? Number(match[1]) : null;
}

function scaleIngredientText(text, ratio) {
    return String(text).replace(/(\d+)と(\d+)\/(\d+)|(\d+)\/(\d+)|(\d+(?:\.\d+)?)/g, (match, whole, numerator, denominator, fractionNumerator, fractionDenominator, number) => {
        let value;
        if (whole && numerator && denominator) {
            value = Number(whole) + Number(numerator) / Number(denominator);
        } else if (fractionNumerator && fractionDenominator) {
            value = Number(fractionNumerator) / Number(fractionDenominator);
        } else {
            value = Number(number);
        }

        return formatScaledNumber(value * ratio);
    });
}

function formatScaledNumber(value) {
    if (Number.isInteger(value)) {
        return String(value);
    }

    const rounded = Math.round(value * 10) / 10;
    if (Number.isInteger(rounded)) {
        return String(rounded);
    }

    return String(rounded);
}

function extractRecipeTags(text) {
    const source = String(text || '').toLowerCase();
    const tagRules = [
        ['meat', ['肉', '豚', '鶏', '牛', 'ひき肉', 'がっつり']],
        ['fish', ['魚', '鮭', 'ツナ', 'さば', '海鮮']],
        ['egg', ['卵', 'たまご', 'オムレツ']],
        ['rice', ['ごはん', '米', '丼', '定食']],
        ['pasta', ['パスタ', '麺']],
        ['vegetable', ['野菜', 'キャベツ', '白菜', 'ほうれん草', 'ヘルシー']],
        ['soup', ['スープ', '汁物', '温かい']],
        ['quick', ['早い', 'すぐ', '時短', '簡単', '短時間']],
        ['mild', ['やさしい', '薄味', 'あっさり']],
        ['savory', ['濃い', 'しっかり', 'ご飯が進む']],
        ['spicy', ['辛い', 'スパイス', 'カレー']],
        ['creamy', ['クリーム', 'チーズ', 'まろやか']],
    ];

    return tagRules
        .filter(([, keywords]) => keywords.some((keyword) => source.includes(keyword)))
        .map(([tag]) => tag);
}

function buildRecipeProfile(records, recipes, favorites = []) {
    const profile = {
        favoriteTags: new Set(),
        avoidTags: new Set(),
        favoriteRecipeIds: new Set(),
        seasoning: 'ふつう',
    };

    const seasoningCounts = { mild: 0, strong: 0 };
    favorites.forEach((favorite) => {
        const recipe = recipes.find((item) => item.id === favorite.recipeId);
        if (recipe) {
            profile.favoriteRecipeIds.add(recipe.id);
            recipe.tags.forEach((tag) => profile.favoriteTags.add(tag));
        }
    });

    records.forEach((record) => {
        const recipe = recipes.find((item) => item.id === record.recipeId);
        const tags = recipe ? recipe.tags : extractRecipeTags(`${record.title} ${record.notes}`);
        const satisfaction = Number(record.satisfaction || 0);

        if (record.favorite) {
            profile.favoriteRecipeIds.add(record.recipeId);
        }

        if (record.favorite || satisfaction >= 4) {
            tags.forEach((tag) => profile.favoriteTags.add(tag));
        }

        if (satisfaction > 0 && satisfaction <= 2) {
            tags.forEach((tag) => profile.avoidTags.add(tag));
        }

        if (record.seasoning === '濃かった') {
            seasoningCounts.mild += 1;
        } else if (record.seasoning === '薄かった') {
            seasoningCounts.strong += 1;
        }
    });

    if (seasoningCounts.mild > seasoningCounts.strong) {
        profile.seasoning = 'やさしめ';
    } else if (seasoningCounts.strong > seasoningCounts.mild) {
        profile.seasoning = 'しっかりめ';
    }

    return profile;
}

function scoreRecipe(recipe, { availableWords, cravingWords, maxMinutes, targetDifficulty, requestedTags, profile }) {
    let score = 0;
    const searchableText = [
        recipe.title,
        recipe.category,
        recipe.summary,
        recipe.ingredients.join(' '),
        recipe.tags.join(' '),
    ].join(' ').toLowerCase();

    availableWords.forEach((word) => {
        if (searchableText.includes(word)) {
            score += recipe.ingredients.some((ingredient) => ingredient.toLowerCase().includes(word)) ? 24 : 10;
        }
    });

    cravingWords.forEach((word) => {
        if (searchableText.includes(word)) {
            score += 18;
        }
    });

    if (recipe.minutes <= maxMinutes) {
        score += 32 + Math.max(0, maxMinutes - recipe.minutes) / 3;
    } else {
        score -= (recipe.minutes - maxMinutes) * 2;
    }

    if (targetDifficulty) {
        const distance = Math.abs(recipe.difficultyLevel - targetDifficulty);
        score += distance === 0 ? 28 : -distance * 12;
    } else {
        score += recipe.difficultyLevel === 1 ? 8 : 0;
    }

    requestedTags.forEach((tag) => {
        if (recipe.tags.includes(tag)) {
            score += 18;
        }
    });

    recipe.tags.forEach((tag) => {
        if (profile.favoriteTags.has(tag)) {
            score += 9;
        }
        if (profile.avoidTags.has(tag)) {
            score -= 12;
        }
    });

    if (profile.favoriteRecipeIds.has(recipe.id)) {
        score += 6;
    }

    return score;
}

function buildRecipeReason(recipe, { availableWords, cravingWords, requestedTags, profile }) {
    const reasons = [];
    const matchedIngredients = recipe.ingredients.filter((ingredient) =>
        availableWords.some((word) => ingredient.toLowerCase().includes(word))
    );

    if (matchedIngredients.length > 0) {
        reasons.push(`使いたい材料の${matchedIngredients.slice(0, 3).join('、')}を使えます`);
    }

    if (cravingWords.some((word) => `${recipe.title} ${recipe.category} ${recipe.summary}`.toLowerCase().includes(word))) {
        reasons.push('食べたいものの条件に近いです');
    }

    if (requestedTags.some((tag) => recipe.tags.includes(tag))) {
        reasons.push('入力された好みに合う特徴があります');
    }

    if (recipe.tags.some((tag) => profile.favoriteTags.has(tag))) {
        reasons.push('好みに近い傾向です');
    }

    if (reasons.length === 0) {
        reasons.push('時間と難易度の条件に合わせて選びました');
    }

    return reasons.join('。') + '。';
}

function buildPersonalizedAdjustment(recipe, profile) {
    if (profile.seasoning === 'やさしめ') {
        return `${recipe.adjustmentTips} 味付けは少し控えめに始めるのがおすすめです。`;
    }

    if (profile.seasoning === 'しっかりめ') {
        return `${recipe.adjustmentTips} 仕上げに少し味を足せる余地を残すと調整しやすいです。`;
    }

    return recipe.adjustmentTips;
}

async function recommendRecipesWithPrompt({ ingredients, craving, time, difficulty, servings, count }) {
    const promptTemplate = fs.readFileSync('prompt.md', 'utf8');
    const finalPrompt = fillTemplate(promptTemplate, {
        ingredients: ingredients || '未指定',
        craving: craving || '未指定',
        time: time || '指定なし',
        difficulty: difficulty || 'おまかせ',
        servings,
        count,
    });

    let promptResult;
    if (PROVIDER === 'openai') {
        promptResult = await callOpenAI(finalPrompt);
    } else if (PROVIDER === 'gemini') {
        promptResult = await callGemini(finalPrompt);
    } else {
        throw new Error('Invalid provider configuration');
    }

    const normalized = normalizePromptRecommendations(promptResult, {
        recipes: [],
        servings,
        count,
        ingredients,
        craving,
        time,
        difficulty,
    });

    return normalized.recommendations;
}

function toPromptRecipeRecord(record) {
    return {
        recipeId: record.recipeId,
        title: record.title,
        satisfaction: record.satisfaction,
        actualDifficulty: record.actualDifficulty,
        seasoning: record.seasoning,
        notes: record.notes,
        adjustments: record.adjustments,
        favorite: record.favorite,
        cookedAt: record.cookedAt,
    };
}

function normalizePromptRecommendations(promptResult, { recipes, servings, count, ingredients, craving, time, difficulty }) {
    if (!Array.isArray(promptResult)) {
        return { recommendations: [], generatedRecipes: [] };
    }

    const availableWords = splitWords(ingredients);
    const selectedIds = new Set();
    const normalized = [];
    const generatedRecipes = [];

    promptResult.forEach((item) => {
        if (normalized.length >= count) {
            return;
        }

        const recipe = createGeneratedRecipe(item, {
            recipes: [...recipes, ...generatedRecipes],
            ingredients,
            craving,
            servings,
        });

        if (!recipe || selectedIds.has(recipe.id)) {
            return;
        }

        selectedIds.add(recipe.id);
        generatedRecipes.push(recipe);
        normalized.push(scaleRecipeServings(recipe, servings));
    });

    if (availableWords.length > 0) {
        normalized.sort((a, b) =>
            countRecipeIngredientMatches(b, availableWords) - countRecipeIngredientMatches(a, availableWords)
            || a.minutes - b.minutes
            || a.title.localeCompare(b.title, 'ja')
        );
    }

    return {
        recommendations: normalized,
        generatedRecipes,
    };
}

function createGeneratedRecipe(item, { recipes, ingredients, craving, servings }) {
    const title = String(item?.title || item?.name || item?.recipeName || '').trim();
    const ingredientItems = normalizeStringArray(item?.ingredients || item?.materials || item?.items);
    const stepItems = normalizeStringArray(item?.steps || item?.instructions || item?.method || item?.directions);

    if (!title) {
        return null;
    }

    const minutes = clampInteger(Number(item?.minutes), 1, 240, parseRecipeMinutes(item?.time, 30));
    const difficultyLevel = clampInteger(Number(item?.difficultyLevel), 1, 3, parseRecipeDifficulty(item?.difficulty) || 2);
    const difficultyLabels = {
        1: 'かんたん',
        2: 'ふつう',
        3: 'こだわり',
    };

    const generatedRecipe = normalizeRecipe({
        id: generateRecipeId(title, recipes),
        title,
        category: String(item?.category || '家庭料理').trim(),
        time: String(item?.time || `${minutes}分`).trim(),
        minutes,
        difficulty: String(item?.difficulty || difficultyLabels[difficultyLevel]).trim(),
        difficultyLevel,
        servings: String(item?.servings || `${servings}人分`).trim(),
        ingredients: ingredientItems.length > 0 ? ingredientItems : ['材料は入力条件に合わせて適量'],
        tags: normalizeStringArray(item?.tags),
        summary: String(item?.summary || `${title}のレシピです。`).trim(),
        steps: stepItems.length > 0 ? stepItems : ['材料を食べやすく準備する', '火が通るまで調理し、味を調える'],
        adjustmentTips: String(item?.adjustmentTips || '味を見ながら調味料の量を調整してください。').trim(),
        generatedByAI: true,
        createdAt: new Date().toISOString(),
    });

    return generatedRecipe;
}

function generateRecipeId(title, recipes) {
    const base = slugifyRecipeTitle(title) || `generated-recipe-${Date.now()}`;
    const existingIds = new Set(recipes.map((recipe) => recipe.id));
    let id = base;
    let suffix = 2;

    while (existingIds.has(id)) {
        id = `${base}-${suffix}`;
        suffix += 1;
    }

    return id;
}

function slugifyRecipeTitle(title) {
    return String(title || '')
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
}

function normalizeTitle(title) {
    return String(title || '').trim().replace(/\s+/g, '').toLowerCase();
}

async function adjustRecipeWithAI(recipe, adjustment) {
    const prompt = [
        'あなたは家庭料理のレシピ調整アシスタントです。',
        '元の料理名と料理の種類は変えず、ユーザーの要望に合わせて味付け、調味料の量、補足手順だけを調整してください。',
        '主材料を別料理になるほど変更しないでください。',
        '返答はJSONオブジェクトのみとし、キーは title, servings, ingredients, steps, adjustmentSummary にしてください。',
        'ingredients と steps は日本語の文字列配列にしてください。',
        '',
        `元レシピ: ${JSON.stringify({
            title: recipe.title,
            category: recipe.category,
            servings: recipe.servings,
            ingredients: recipe.ingredients,
            steps: recipe.steps,
        })}`,
        `調整要望: ${adjustment}`,
    ].join('\n');

    let adjustedRecipe;
    if (PROVIDER === 'openai') {
        adjustedRecipe = await callOpenAIObject(prompt);
    } else if (PROVIDER === 'gemini') {
        adjustedRecipe = await callGeminiObject(prompt);
    } else {
        throw new Error('Invalid provider configuration');
    }

    return normalizeAdjustedRecipe(recipe, adjustedRecipe);
}

function normalizeAdjustedRecipe(originalRecipe, adjustedRecipe) {
    adjustedRecipe = adjustedRecipe || {};
    const ingredients = normalizeStringArray(adjustedRecipe.ingredients);
    const steps = normalizeStringArray(adjustedRecipe.steps);

    return {
        title: originalRecipe.title,
        servings: String(adjustedRecipe.servings || originalRecipe.servings || ''),
        ingredients: ingredients.length > 0 ? ingredients : originalRecipe.ingredients,
        steps: steps.length > 0 ? steps : originalRecipe.steps,
        adjustmentSummary: String(adjustedRecipe.adjustmentSummary || '要望に合わせて味付けを調整しました。'),
    };
}

function createRecipeRecord(body) {
    const title = String(body.title || '').trim();
    if (!title) {
        throw new Error('title is required');
    }

    return {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        recipeId: String(body.recipeId || ''),
        title,
        category: String(body.category || ''),
        cookedAt: String(body.cookedAt || new Date().toISOString().slice(0, 10)),
        satisfaction: clampInteger(Number(body.satisfaction), 1, 5, 3),
        actualDifficulty: String(body.actualDifficulty || 'ふつう'),
        seasoning: String(body.seasoning || 'ちょうどよい'),
        notes: String(body.notes || ''),
        adjustments: String(body.adjustments || ''),
        favorite: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal,
        });
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`AI response timed out after ${Math.round(LLM_TIMEOUT_MS / 1000)} seconds`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function callOpenAI(prompt) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    const response = await fetchWithTimeout(OPENAI_API_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: MODEL,
            reasoning: { effort: OPENAI_REASONING_EFFORT },
            input: prompt,
            max_output_tokens: 1800,
            text: {
                format: { type: 'json_object' },
                verbosity: 'low',
            },
        })
    });

    if (!response.ok) {
        throw new Error(await readLlmError(response, 'OpenAI API error'));
    }

    const data = await response.json();
    return extractArray(getOpenAIResponseText(data));
}

async function callOpenAIObject(prompt) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    const response = await fetchWithTimeout(OPENAI_API_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: MODEL,
            reasoning: { effort: OPENAI_REASONING_EFFORT },
            input: prompt,
            max_output_tokens: 2200,
            text: {
                format: { type: 'json_object' },
                verbosity: 'low',
            },
        })
    });

    if (!response.ok) {
        throw new Error(await readLlmError(response, 'OpenAI API error'));
    }

    const data = await response.json();
    return extractObject(getOpenAIResponseText(data));
}

async function callGemini(prompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY environment variable is not set');
    }

    const response = await fetchWithTimeout(`${GEMINI_API_BASE_URL}${MODEL}:generateContent?key=${apiKey}`, {
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
        throw new Error(await readLlmError(response, 'Gemini API error'));
    }

    const data = await response.json();
    const responseText = data.candidates[0].content.parts[0].text;
    return extractArray(responseText);
}

async function callGeminiObject(prompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY environment variable is not set');
    }

    const response = await fetchWithTimeout(`${GEMINI_API_BASE_URL}${MODEL}:generateContent?key=${apiKey}`, {
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
        throw new Error(await readLlmError(response, 'Gemini API error'));
    }

    const data = await response.json();
    return extractObject(data.candidates[0].content.parts[0].text);
}

async function readLlmError(response, fallbackMessage) {
    const text = await response.text();
    if (!text) {
        return fallbackMessage;
    }

    try {
        const errorData = JSON.parse(text);
        return errorData.error?.message || errorData.message || fallbackMessage;
    } catch (error) {
        return text;
    }
}

function getOpenAIResponseText(data) {
    if (typeof data?.output_text === 'string') {
        return data.output_text;
    }

    const output = Array.isArray(data?.output) ? data.output : [];
    const textParts = [];

    output.forEach((item) => {
        const content = Array.isArray(item?.content) ? item.content : [];
        content.forEach((part) => {
            if (typeof part?.text === 'string') {
                textParts.push(part.text);
            } else if (typeof part?.content === 'string') {
                textParts.push(part.content);
            }
        });
    });

    return textParts.join('\n').trim();
}

function parseJsonResponse(responseText) {
    const rawText = String(responseText || '').trim();
    if (!rawText) {
        throw new Error('LLM response was empty.');
    }

    const withoutFence = rawText
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

    try {
        return JSON.parse(withoutFence);
    } catch (initialError) {
        const objectStart = withoutFence.indexOf('{');
        const objectEnd = withoutFence.lastIndexOf('}');
        if (objectStart >= 0 && objectEnd > objectStart) {
            try {
                return JSON.parse(withoutFence.slice(objectStart, objectEnd + 1));
            } catch (objectError) {
                throw new Error('Failed to parse LLM response: ' + objectError.message);
            }
        }

        throw new Error('Failed to parse LLM response: ' + initialError.message);
    }
}

// LLM が返した JSON 文字列をパースし、最初に見つかった配列を取り出す
function extractArray(responseText) {
    const parsedData = parseJsonResponse(responseText);

    if (Array.isArray(parsedData)) {
        return parsedData;
    }

    const arrayData = Object.values(parsedData).find(Array.isArray);
    if (!arrayData) {
        throw new Error('No array found in the LLM response object.');
    }
    return arrayData;
}

function extractObject(responseText) {
    return parseJsonResponse(responseText);
}

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Config: ${PROVIDER} - ${MODEL}`);
});
