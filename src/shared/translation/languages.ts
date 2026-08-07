import type {
  CaptionTranslationLanguage,
  CaptionTranslationSourceLanguage,
} from "@/shared/types/live";

export type TranslationLanguageOption = {
  value: CaptionTranslationLanguage;
  label: string;
};

export const TRANSLATION_LANGUAGE_OPTIONS: readonly TranslationLanguageOption[] = [
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁体中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本语" },
  { value: "ko", label: "한국어" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "ru", label: "Русский" },
  { value: "pt", label: "Português" },
  { value: "it", label: "Italiano" },
  { value: "nl", label: "Nederlands" },
  { value: "pl", label: "Polski" },
  { value: "uk", label: "Українська" },
  { value: "tr", label: "Türkçe" },
  { value: "ar", label: "العربية" },
  { value: "hi", label: "हिन्दी" },
  { value: "th", label: "ไทย" },
  { value: "vi", label: "Tiếng Việt" },
  { value: "id", label: "Bahasa Indonesia" },
  { value: "ms", label: "Bahasa Melayu" },
] as const;

export const TRANSLATION_SOURCE_LANGUAGE_OPTIONS = [
  { value: "auto" as const, label: "自动检测" },
  ...TRANSLATION_LANGUAGE_OPTIONS,
] as const;

const LANGUAGE_CODES = new Set<string>(
  TRANSLATION_LANGUAGE_OPTIONS.map((language) => language.value),
);

export function isCaptionTranslationLanguage(value: unknown): value is CaptionTranslationLanguage {
  return typeof value === "string" && LANGUAGE_CODES.has(value);
}

export function normalizeCaptionTranslationFrom(value: unknown): CaptionTranslationSourceLanguage {
  return value === "auto" || isCaptionTranslationLanguage(value) ? value : "auto";
}

export function normalizeCaptionTranslationTo(value: unknown): CaptionTranslationLanguage {
  return isCaptionTranslationLanguage(value) ? value : "zh-CN";
}
