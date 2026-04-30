import { DeepLClient } from './deepl.js';
import { DeepSeekClient, getDeepSeekApiKey } from './deepseek.js';
import { GeminiClient } from './gemini.js';
import { GoogleTranslateBasicClient } from './google-translate-basic.js';
import { GoogleWebClient } from './google-web.js';
import type { LLMClient, Provider, TranslationMessageLayout } from './llm-client.js';
import { OpenRouterClient, getOpenRouterApiKey } from './openrouter.js';
import { QwenClient } from './qwen.js';

type Environment = Record<string, string | undefined>;
type GeminiTranslationBackendPreference = 'api' | 'vertex' | 'auto';

export type CreateClientOptions = {
    messageLayout?: TranslationMessageLayout;
};

function resolveGeminiTranslationVertexLocation(env: Environment): string | undefined {
    return env.GEMINI_TRANSLATION_VERTEX_LOCATION ?? env.GOOGLE_CLOUD_LOCATION;
}

function requireApiKey(name: string, env: Environment): string {
    const apiKey = env[name];
    if (!apiKey) {
        throw new Error(`${name} not found in environment variables`);
    }

    return apiKey;
}

export function getApiKeyForProvider(provider: Provider, env: Environment): string {
    switch (provider) {
        case 'gemini':
            return requireApiKey('GEMINI_API_KEY', env);
        case 'qwen':
            return requireApiKey('DASHSCOPE_API_KEY', env);
        case 'openrouter':
            return getOpenRouterApiKey(env);
        case 'deepseek':
            return getDeepSeekApiKey(env);
        case 'deepl':
            return requireApiKey('DEEPL_API_KEY', env);
        case 'google-translate-basic':
            return requireApiKey('GOOGLE_TRANSLATE_API_KEY', env);
        case 'google-web':
            return '';
    }
}

function resolveGeminiTranslationClientConfig(env: Environment): ConstructorParameters<typeof GeminiClient>[3] & { apiKey: string } {
    const backendPreference = (env.GEMINI_TRANSLATION_BACKEND ?? 'auto') as GeminiTranslationBackendPreference;

    if (backendPreference !== 'api' && backendPreference !== 'vertex' && backendPreference !== 'auto') {
        throw new Error('GEMINI_TRANSLATION_BACKEND must be one of api, vertex, or auto');
    }

    if (backendPreference === 'api') {
        return {
            apiKey: requireApiKey('GEMINI_API_KEY', env),
            backend: 'api',
        };
    }

    const project = env.GOOGLE_CLOUD_PROJECT;
    const location = resolveGeminiTranslationVertexLocation(env);

    if (backendPreference === 'vertex') {
        if (!project) {
            throw new Error('GOOGLE_CLOUD_PROJECT not found in environment variables');
        }

        if (!location) {
            throw new Error('GEMINI_TRANSLATION_VERTEX_LOCATION or GOOGLE_CLOUD_LOCATION not found in environment variables');
        }

        return {
            apiKey: env.GEMINI_API_KEY ?? '',
            backend: 'vertex',
            project,
            location,
        };
    }

    if (env.GEMINI_API_KEY) {
        return {
            apiKey: env.GEMINI_API_KEY,
            backend: 'api',
        };
    }

    if (project && location) {
        return {
            apiKey: '',
            backend: 'vertex',
            project,
            location,
        };
    }

    throw new Error('Gemini translation requires GEMINI_API_KEY or GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION');
}

export function createClient(provider: Provider, model: string, env: Environment, options: CreateClientOptions = {}): LLMClient {
    switch (provider) {
        case 'gemini':
            {
                const config = resolveGeminiTranslationClientConfig(env);
                return new GeminiClient(config.apiKey, model, undefined, config);
            }
        case 'qwen':
            return new QwenClient(getApiKeyForProvider(provider, env), model);
        case 'openrouter':
            return new OpenRouterClient(getApiKeyForProvider(provider, env), model, undefined, undefined, options.messageLayout);
        case 'deepseek':
            return new DeepSeekClient(getApiKeyForProvider(provider, env), model);
        case 'deepl':
            return new DeepLClient(getApiKeyForProvider(provider, env), model, env.DEEPL_API_ENDPOINT);
        case 'google-translate-basic':
            return new GoogleTranslateBasicClient(getApiKeyForProvider(provider, env), model);
        case 'google-web':
            return new GoogleWebClient(model);
    }
}
