import assert from 'node:assert/strict';
import test from 'node:test';

async function loadReasoningPolicyModule() {
    try {
        const modulePath = '../src/reasoning-policy.js';
        return await import(modulePath);
    } catch (error) {
        assert.fail(`reasoning-policy module could not be loaded: ${String(error)}`);
    }
}

test('Gemini translation uses minimal thinking for gemini-3 models', async () => {
    const policy = await loadReasoningPolicyModule();

    assert.deepEqual(
        policy.getGeminiTranslationThinkingConfig('gemini-3-flash-preview'),
        { thinkingLevel: 'minimal' },
    );
});

test('Gemini translation uses minimal thinking for prefixed gemini-3 model names', async () => {
    const policy = await loadReasoningPolicyModule();

    for (const model of [
        'models/gemini-3-flash-preview',
        'google/gemini-3-flash-preview',
        'publishers/google/models/gemini-3-flash-preview',
        'projects/demo/locations/us-central1/publishers/google/models/gemini-3-flash-preview',
    ]) {
        assert.deepEqual(policy.getGeminiTranslationThinkingConfig(model), { thinkingLevel: 'minimal' });
    }
});

test('Gemini translation disables thinking budget for non-gemini-3 models', async () => {
    const policy = await loadReasoningPolicyModule();

    assert.deepEqual(
        policy.getGeminiTranslationThinkingConfig('gemini-2.5-flash'),
        { thinkingBudget: 0 },
    );
});

test('Vertex judge uses high thinking for gemini-3 models', async () => {
    const policy = await loadReasoningPolicyModule();

    assert.deepEqual(
        policy.getVertexJudgeThinkingConfig('gemini-3-flash-preview'),
        { thinkingLevel: 'high' },
    );
});

test('Vertex judge uses high thinking for prefixed gemini-3 model names', async () => {
    const policy = await loadReasoningPolicyModule();

    for (const model of [
        'models/gemini-3-flash-preview',
        'google/gemini-3-flash-preview',
        'publishers/google/models/gemini-3-flash-preview',
        'projects/demo/locations/us-central1/publishers/google/models/gemini-3-flash-preview',
    ]) {
        assert.deepEqual(policy.getVertexJudgeThinkingConfig(model), { thinkingLevel: 'high' });
    }
});

test('Vertex judge uses fixed thinking budget for non-gemini-3 models', async () => {
    const policy = await loadReasoningPolicyModule();

    assert.deepEqual(
        policy.getVertexJudgeThinkingConfig('gemini-2.5-flash'),
        { thinkingBudget: -1 },
    );
});

test('Qwen translation disables thinking', async () => {
    const policy = await loadReasoningPolicyModule();

    assert.deepEqual(policy.getQwenTranslationRequestFields(), { enable_thinking: false });
});

test('OpenRouter translation disables reasoning', async () => {
    const policy = await loadReasoningPolicyModule();

    assert.deepEqual(
        policy.getOpenRouterTranslationRequestFields('google/gemma-4-26b-a4b-it'),
        { reasoning: { enabled: false } },
    );
});
