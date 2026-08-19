/** Expo's Kotlin bridge rejects nullable values inside dynamic maps on some releases. */
export function compactNativeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactNativeValue).filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        const compacted = compactNativeValue(item);
        return compacted === undefined || compacted === null ? [] : [[key, compacted]];
      }),
    );
  }
  return value === null || value === undefined ? undefined : value;
}
