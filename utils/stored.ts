// Small choices remembered per browser in localStorage. Every read and write is wrapped: a
// blocked or full store (private windows, cleared site data) falls back to the default, and a
// choice that cannot be saved lasts until the page is reloaded.
export const readStored = <T>(
  key: string,
  isValid: (value: unknown) => value is T,
  fallback: T
): T => {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const value: unknown = JSON.parse(raw);
    return isValid(value) ? value : fallback;
  } catch {
    return fallback;
  }
};

export const writeStored = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not saved; the choice still holds for this page.
  }
};
