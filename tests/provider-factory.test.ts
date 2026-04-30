import test from 'node:test';
import assert from 'node:assert/strict';

import { createClient, getApiKeyForProvider } from '../src/provider-factory.js';

test('getApiKeyForProvider resolves provider API keys', () => {
    const env = {
        GEMINI_API_KEY: 'g-key',
        DASHSCOPE_API_KEY: 'q-key',
        OPENROUTER_API_KEY: 'o-key',
        DEEPSEEK_API_KEY: 'ds-key',
        DEEPL_API_KEY: 'd-key',
        GOOGLE_TRANSLATE_API_KEY: 'gt-key',
    };

    assert.equal(getApiKeyForProvider('gemini', env), 'g-key');
    assert.equal(getApiKeyForProvider('qwen', env), 'q-key');
    assert.equal(getApiKeyForProvider('openrouter', env), 'o-key');
    assert.equal(getApiKeyForProvider('deepseek', env), 'ds-key');
    assert.equal(getApiKeyForProvider('deepl' as any, env), 'd-key');
    assert.equal(getApiKeyForProvider('google-translate-basic' as any, env), 'gt-key');
});

test('getApiKeyForProvider does not require an API key for google-web', () => {
    assert.equal(getApiKeyForProvider('google-web' as any, {}), '');
});

test('createClient returns translation provider clients for deepl, google-translate-basic, and google-web', () => {
  const deeplClient = createClient('deepl' as any, 'deepl-api', {
        DEEPL_API_KEY: 'd-key',
    });
    const googleTranslateBasicClient = createClient('google-translate-basic' as any, 'google-translate-basic', {
        GOOGLE_TRANSLATE_API_KEY: 'gt-key',
    });
    const googleWebClient = createClient('google-web' as any, 'google-translate-web', {});

    assert.equal(deeplClient.getProviderName(), 'deepl');
    assert.equal(deeplClient.getModelName(), 'deepl-api');
    assert.equal(googleTranslateBasicClient.getProviderName(), 'google-translate-basic');
    assert.equal(googleTranslateBasicClient.getModelName(), 'google-translate-basic');
    assert.equal(googleWebClient.getProviderName(), 'google-web');
    assert.equal(googleWebClient.getModelName(), 'google-translate-web');
});

test('createClient returns a DeepSeek official API client', () => {
    const client = createClient('deepseek', 'deepseek-v4-flash', {
        DEEPSEEK_API_KEY: 'ds-key',
    });

    assert.equal(client.getProviderName(), 'deepseek');
    assert.equal(client.getModelName(), 'deepseek-v4-flash');
});

test('createClient auto-selects the Free DeepL endpoint for :fx auth keys', () => {
    const client = createClient('deepl' as any, 'deepl-api', {
        DEEPL_API_KEY: 'd-key:fx',
    }) as any;

    assert.equal(client.endpoint, 'https://api-free.deepl.com/v2/translate');
});

test('createClient honors an explicit DeepL endpoint override', () => {
    const client = createClient('deepl' as any, 'deepl-api', {
        DEEPL_API_KEY: 'd-key:fx',
        DEEPL_API_ENDPOINT: 'https://example.test/v2/translate',
    }) as any;

    assert.equal(client.endpoint, 'https://example.test/v2/translate');
});

test('createClient keeps Gemini on the Gemini API by default', () => {
    const client = createClient('gemini', 'gemini-3-flash-preview', {
        GEMINI_API_KEY: 'g-key',
        GOOGLE_CLOUD_PROJECT: 'demo-project',
        GOOGLE_CLOUD_LOCATION: 'us-central1',
    }) as any;

    assert.equal(client.getProviderName(), 'gemini');
    assert.equal(client.ai.vertexai, false);
    assert.equal(client.ai.apiClient.isVertexAI(), false);
});

test('createClient auto-selects Vertex for Gemini translation when API key is absent', () => {
    const client = createClient('gemini', 'gemini-3-flash-preview', {
        GOOGLE_CLOUD_PROJECT: 'demo-project',
        GOOGLE_CLOUD_LOCATION: 'us-central1',
    }) as any;

    assert.equal(client.getProviderName(), 'gemini');
    assert.equal(client.ai.vertexai, true);
    assert.equal(client.ai.apiClient.isVertexAI(), true);
});

test('createClient honors explicit Vertex Gemini translation backend even when GEMINI_API_KEY exists', () => {
    const client = createClient('gemini', 'gemini-3-flash-preview', {
        GEMINI_API_KEY: 'g-key',
        GEMINI_TRANSLATION_BACKEND: 'vertex',
        GOOGLE_CLOUD_PROJECT: 'demo-project',
        GOOGLE_CLOUD_LOCATION: 'us-central1',
    }) as any;

    assert.equal(client.ai.vertexai, true);
    assert.equal(client.ai.apiClient.isVertexAI(), true);
});

test('createClient uses GEMINI_TRANSLATION_VERTEX_LOCATION for explicit Vertex Gemini translation backend', () => {
    const client = createClient('gemini', 'gemini-3-flash-preview', {
        GEMINI_TRANSLATION_BACKEND: 'vertex',
        GOOGLE_CLOUD_PROJECT: 'demo-project',
        GOOGLE_CLOUD_LOCATION: 'us-central1',
        GEMINI_TRANSLATION_VERTEX_LOCATION: 'global',
    }) as any;

    assert.equal(client.ai.vertexai, true);
    assert.equal(client.ai.location, 'global');
});

test('createClient uses GEMINI_TRANSLATION_VERTEX_LOCATION when auto-selecting Vertex Gemini translation', () => {
    const client = createClient('gemini', 'gemini-3-flash-preview', {
        GOOGLE_CLOUD_PROJECT: 'demo-project',
        GOOGLE_CLOUD_LOCATION: 'us-central1',
        GEMINI_TRANSLATION_VERTEX_LOCATION: 'global',
    }) as any;

    assert.equal(client.ai.vertexai, true);
    assert.equal(client.ai.location, 'global');
});

test('createClient rejects explicit Vertex Gemini translation backend when Vertex env is incomplete', () => {
    assert.throws(
        () => createClient('gemini', 'gemini-3-flash-preview', {
            GEMINI_TRANSLATION_BACKEND: 'vertex',
            GOOGLE_CLOUD_PROJECT: 'demo-project',
        }),
        /GOOGLE_CLOUD_LOCATION/i,
    );
});

test('createClient requires DEEPL_API_KEY for deepl', () => {
    assert.throws(
        () => createClient('deepl' as any, 'deepl-api', {}),
        /DEEPL_API_KEY not found/i,
    );
});

test('createClient requires DEEPSEEK_API_KEY for deepseek', () => {
    assert.throws(
        () => createClient('deepseek', 'deepseek-v4-flash', {}),
        /DEEPSEEK_API_KEY not found/i,
    );
});

test('createClient requires GOOGLE_TRANSLATE_API_KEY for google-translate-basic', () => {
    assert.throws(
        () => createClient('google-translate-basic' as any, 'google-translate-basic', {}),
        /GOOGLE_TRANSLATE_API_KEY not found/i,
    );
});
