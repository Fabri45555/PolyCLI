export interface ParsedArb {
  locale: string | undefined;
  translatableKeys: Record<string, string>;
  metadata: Record<string, unknown>;
  keyOrder: string[];
}

export function parseArb(content: string): ParsedArb {
  const raw = JSON.parse(content) as Record<string, unknown>;
  const locale = typeof raw['@@locale'] === 'string' ? raw['@@locale'] : undefined;
  const translatableKeys: Record<string, string> = {};
  const metadata: Record<string, unknown> = {};
  const keyOrder: string[] = [];

  for (const key of Object.keys(raw)) {
    if (!key.startsWith('@')) {
      if (typeof raw[key] === 'string') {
        translatableKeys[key] = raw[key] as string;
        keyOrder.push(key);
      }
    } else if (key !== '@@locale') {
      const baseName = key.slice(1);
      metadata[baseName] = raw[key];
    }
  }

  return { locale, translatableKeys, metadata, keyOrder };
}

export function extractDescriptions(metadata: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const desc = (value as Record<string, unknown>)['description'];
      if (typeof desc === 'string' && desc.length > 0) {
        result[key] = desc;
      }
    }
  }
  return result;
}

export function buildArbDelta(
  current: Record<string, string>,
  lock: Record<string, string>
): Record<string, string> {
  const delta: Record<string, string> = {};
  for (const [key, value] of Object.entries(current)) {
    if (!(key in lock) || lock[key] !== value) {
      delta[key] = value;
    }
  }
  return delta;
}

export function reconstructArb(
  existingTranslated: Record<string, string>,
  newTranslations: Record<string, string>,
  metadata: Record<string, unknown>,
  targetLocale: string,
  keyOrder: string[],
  translatedDescriptions: Record<string, string> | null
): string {
  const result: Record<string, unknown> = {};
  result['@@locale'] = targetLocale;

  for (const key of keyOrder) {
    const translatedValue =
      key in newTranslations
        ? newTranslations[key]
        : key in existingTranslated
        ? existingTranslated[key]
        : '';

    result[key] = translatedValue;

    if (key in metadata) {
      const meta = metadata[key];
      if (
        translatedDescriptions &&
        key in translatedDescriptions &&
        meta &&
        typeof meta === 'object' &&
        !Array.isArray(meta)
      ) {
        result[`@${key}`] = {
          ...(meta as Record<string, unknown>),
          description: translatedDescriptions[key],
        };
      } else {
        result[`@${key}`] = meta;
      }
    }
  }

  return JSON.stringify(result, null, 2);
}
