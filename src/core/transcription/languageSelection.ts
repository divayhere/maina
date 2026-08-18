export function selectRecognitionLanguage(installed: string[]): string | null {
  const normalized = new Set(installed.map((locale) => locale.toLowerCase()));
  for (const preferred of ['en-IN', 'hi-IN', 'en-US']) {
    if (normalized.has(preferred.toLowerCase())) return preferred;
  }
  return null;
}
