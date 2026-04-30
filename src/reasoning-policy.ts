type GeminiThinkingConfig =
    | { thinkingLevel: 'minimal' | 'high' }
    | { thinkingBudget: 0 | -1 };

function isGemini3Model(model: string): boolean {
    const normalizedModel = model.trim();
    const segments = normalizedModel.split('/').filter(Boolean);
    const modelId = segments.at(-1) ?? normalizedModel;

    return modelId.startsWith('gemini-3');
}

export function getGeminiTranslationThinkingConfig(model: string): GeminiThinkingConfig {
    if (isGemini3Model(model)) {
        return { thinkingLevel: 'minimal' };
    }

    return { thinkingBudget: 0 };
}

export function getVertexJudgeThinkingConfig(model: string): GeminiThinkingConfig {
    if (isGemini3Model(model)) {
        return { thinkingLevel: 'high' };
    }

    return { thinkingBudget: -1 };
}

export function getQwenTranslationRequestFields() {
    return { enable_thinking: false as const };
}

export function getOpenRouterTranslationRequestFields(_model: string) {
    return {
        reasoning: {
            enabled: false as const,
        },
    };
}

export function getDeepSeekTranslationRequestFields() {
    return {
        thinking: {
            type: 'disabled' as const,
        },
    };
}
