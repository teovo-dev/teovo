import type { LanguageModelV4 } from '@ai-sdk/provider';
/**
 * One model built from an ordered list: if a model fails before saying anything, the next one is tried.
 * `canSwitch` is asked first; it returns false once a tool has changed something, so a run never continues
 * on a different model after a write.
 */
export declare function fallbackModel(models: readonly LanguageModelV4[], canSwitch: () => boolean, onSwitch?: (from: string, error: unknown) => void): LanguageModelV4;
