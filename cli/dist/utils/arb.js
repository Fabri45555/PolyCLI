"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseArb = parseArb;
exports.extractDescriptions = extractDescriptions;
exports.buildArbDelta = buildArbDelta;
exports.reconstructArb = reconstructArb;
function parseArb(content) {
    const raw = JSON.parse(content);
    const locale = typeof raw['@@locale'] === 'string' ? raw['@@locale'] : undefined;
    const translatableKeys = {};
    const metadata = {};
    const keyOrder = [];
    for (const key of Object.keys(raw)) {
        if (!key.startsWith('@')) {
            if (typeof raw[key] === 'string') {
                translatableKeys[key] = raw[key];
                keyOrder.push(key);
            }
        }
        else if (key !== '@@locale') {
            const baseName = key.slice(1);
            metadata[baseName] = raw[key];
        }
    }
    return { locale, translatableKeys, metadata, keyOrder };
}
function extractDescriptions(metadata) {
    const result = {};
    for (const [key, value] of Object.entries(metadata)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const desc = value['description'];
            if (typeof desc === 'string' && desc.length > 0) {
                result[key] = desc;
            }
        }
    }
    return result;
}
function buildArbDelta(current, lock) {
    const delta = {};
    for (const [key, value] of Object.entries(current)) {
        if (!(key in lock) || lock[key] !== value) {
            delta[key] = value;
        }
    }
    return delta;
}
function reconstructArb(existingTranslated, newTranslations, metadata, targetLocale, keyOrder, translatedDescriptions) {
    const result = {};
    result['@@locale'] = targetLocale;
    for (const key of keyOrder) {
        const translatedValue = key in newTranslations
            ? newTranslations[key]
            : key in existingTranslated
                ? existingTranslated[key]
                : '';
        result[key] = translatedValue;
        if (key in metadata) {
            const meta = metadata[key];
            if (translatedDescriptions &&
                key in translatedDescriptions &&
                meta &&
                typeof meta === 'object' &&
                !Array.isArray(meta)) {
                result[`@${key}`] = {
                    ...meta,
                    description: translatedDescriptions[key],
                };
            }
            else {
                result[`@${key}`] = meta;
            }
        }
    }
    return JSON.stringify(result, null, 2);
}
