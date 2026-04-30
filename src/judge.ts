import * as readline from 'readline';

/**
 * Rubric scores for a single translation output.
 * Each dimension is scored 1-5.
 */
export interface JudgeScore {
    accuracy: number;   // How well the original meaning is preserved
    fluency: number;    // How natural and readable the translation is
    tone: number;       // How well the formality/emotion is mirrored
    format: number;     // How well formatting requirements are followed
    total: number;      // Sum of all dimensions (4-20)
}

/**
 * Interactive Judge.
 * Prompts the console for a JSON input to score translations.
 */
export class InteractiveJudge {
    getModelName(): string {
        return 'Agent-in-the-Loop';
    }

    /**
     * Score a single translation output interactively via stdin.
     */
    private async promptForScore(
        source: string,
        sourceLang: string,
        targetLang: string,
        translation: string,
        translationPrompt: string
    ): Promise<JudgeScore> {
        console.log(`Source [${sourceLang}]: ${source}`);
        console.log(`Translation [${targetLang}]: ${translation}`);
        console.log(`System Prompt Used: \n${translationPrompt.substring(0, 500)}...[Truncated]`);
        console.log('-'.repeat(50));
        console.log('Please provide scores in JSON format.');
        console.log('Format: {"accuracy":1-5, "fluency":1-5, "tone":1-5, "format":1-5}');
        
        return new Promise((resolve) => {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            
            const ask = () => {
                rl.question('EVALUATE> ', (answer) => {
                    try {
                        const parsed = JSON.parse(answer.trim());
                        if (
                            typeof parsed.accuracy === 'number' && 
                            typeof parsed.fluency === 'number' &&
                            typeof parsed.tone === 'number' &&
                            typeof parsed.format === 'number'
                        ) {
                            rl.close();
                            const accuracy = Math.max(1, Math.min(5, parsed.accuracy));
                            const fluency = Math.max(1, Math.min(5, parsed.fluency));
                            const tone = Math.max(1, Math.min(5, parsed.tone));
                            const format = Math.max(1, Math.min(5, parsed.format));
                            resolve({
                                accuracy,
                                fluency,
                                tone,
                                format,
                                total: accuracy + fluency + tone + format,
                            });
                        } else {
                            console.log('❌ Invalid format. Please ensure accuracy, fluency, tone, and format are numbers.');
                            ask();
                        }
                    } catch (e) {
                        console.log('❌ Invalid JSON. Please enter a valid JSON format. (e.g. {"accuracy":5, "fluency":5, "tone":5, "format":5})');
                        ask();
                    }
                });
            };
            
            ask();
        });
    }

    /**
     * Score a group of translation candidates interactively via stdin.
     */
    private async promptForGroupScore(
        source: string,
        sourceLang: string,
        targetLang: string,
        candidates: { label: string; translation: string; translationPrompt: string }[]
    ): Promise<JudgeScore[]> {
        console.log(`Source [${sourceLang}]: ${source}`);
        console.log(`System Prompt Used: \n${candidates[0].translationPrompt.substring(0, 500)}...[Truncated]`);
        console.log('-'.repeat(50));
        
        for (let i = 0; i < candidates.length; i++) {
            console.log(`Candidate ${i+1} [${candidates[i].label} -> ${targetLang}]: ${candidates[i].translation}`);
        }
        
        console.log('-'.repeat(50));
        console.log(`Please provide scores as a JSON array of ${candidates.length} objects.`);
        console.log('Format: [{"accuracy":1-5, "fluency":1-5, "tone":1-5, "format":1-5}, {"accuracy":...}, ...]');
        
        return new Promise((resolve) => {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            
            const ask = () => {
                rl.question('EVALUATE> ', (answer) => {
                    try {
                        const parsed = JSON.parse(answer.trim());
                        if (Array.isArray(parsed) && parsed.length === candidates.length) {
                            const scores: JudgeScore[] = [];
                            for (let i = 0; i < parsed.length; i++) {
                                const p = parsed[i];
                                if (
                                    typeof p.accuracy === 'number' && typeof p.fluency === 'number' &&
                                    typeof p.tone === 'number' && typeof p.format === 'number'
                                ) {
                                    const accuracy = Math.max(1, Math.min(5, p.accuracy));
                                    const fluency = Math.max(1, Math.min(5, p.fluency));
                                    const tone = Math.max(1, Math.min(5, p.tone));
                                    const format = Math.max(1, Math.min(5, p.format));
                                    scores.push({
                                        accuracy, fluency, tone, format,
                                        total: accuracy + fluency + tone + format,
                                    });
                                } else {
                                    throw new Error(`Invalid format at index ${i}`);
                                }
                            }
                            rl.close();
                            resolve(scores);
                        } else {
                            console.log(`❌ Invalid format. Please ensure you provide exactly ${candidates.length} JSON objects in an array.`);
                            ask();
                        }
                    } catch (e) {
                        console.log('❌ Invalid JSON or format. Please enter a valid JSON array of objects.');
                        ask();
                    }
                });
            };
            ask();
        });
    }

    /**
     * Batch-score grouped translations interactively.
     */
    async batchScore(
        groups: {
            source: string;
            sourceLang: string;
            targetLang: string;
            candidates: {
                label: string;
                translation: string;
                translationPrompt: string;
            }[];
        }[]
    ): Promise<JudgeScore[]> {
        const results: JudgeScore[] = [];

        for (let i = 0; i < groups.length; i++) {
            const group = groups[i];
            console.log(`\n\n==================================================`);
            console.log(`[EVALUATION REQUEST ${i + 1}/${groups.length} - GROUP BATCH]`);
            console.log(`==================================================`);
            const scores = await this.promptForGroupScore(
                group.source,
                group.sourceLang,
                group.targetLang,
                group.candidates
            );
            results.push(...scores);
        }

        return results;
    }
}
