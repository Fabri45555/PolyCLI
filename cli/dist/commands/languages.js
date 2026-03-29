"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.languagesCommand = languagesCommand;
const chalk_1 = __importDefault(require("chalk"));
const ALL_LANGUAGES = [
    { code: 'af', name: 'Afrikaans', flag: '🇿🇦' },
    { code: 'sq', name: 'Albanian', flag: '🇦🇱' },
    { code: 'ar', name: 'Arabic', flag: '🇸🇦' },
    { code: 'bn', name: 'Bengali', flag: '🇧🇩' },
    { code: 'bg', name: 'Bulgarian', flag: '🇧🇬' },
    { code: 'ca', name: 'Catalan', flag: '🏴󠁥󠁳󠁣󠁴󠁿' },
    { code: 'zh', name: 'Chinese (Simplified)', flag: '🇨🇳' },
    { code: 'zh-TW', name: 'Chinese (Traditional)', flag: '🇹🇼' },
    { code: 'hr', name: 'Croatian', flag: '🇭🇷' },
    { code: 'cs', name: 'Czech', flag: '🇨🇿' },
    { code: 'da', name: 'Danish', flag: '🇩🇰' },
    { code: 'nl', name: 'Dutch', flag: '🇳🇱' },
    { code: 'en', name: 'English', flag: '🇬🇧' },
    { code: 'et', name: 'Estonian', flag: '🇪🇪' },
    { code: 'fi', name: 'Finnish', flag: '🇫🇮' },
    { code: 'fil', name: 'Filipino', flag: '🇵🇭' },
    { code: 'fr', name: 'French', flag: '🇫🇷' },
    { code: 'de', name: 'German', flag: '🇩🇪' },
    { code: 'el', name: 'Greek', flag: '🇬🇷' },
    { code: 'he', name: 'Hebrew', flag: '🇮🇱' },
    { code: 'hi', name: 'Hindi', flag: '🇮🇳' },
    { code: 'hu', name: 'Hungarian', flag: '🇭🇺' },
    { code: 'id', name: 'Indonesian', flag: '🇮🇩' },
    { code: 'it', name: 'Italian', flag: '🇮🇹' },
    { code: 'ja', name: 'Japanese', flag: '🇯🇵' },
    { code: 'kk', name: 'Kazakh', flag: '🇰🇿' },
    { code: 'ko', name: 'Korean', flag: '🇰🇷' },
    { code: 'lv', name: 'Latvian', flag: '🇱🇻' },
    { code: 'lt', name: 'Lithuanian', flag: '🇱🇹' },
    { code: 'mk', name: 'Macedonian', flag: '🇲🇰' },
    { code: 'ms', name: 'Malay', flag: '🇲🇾' },
    { code: 'ary', name: 'Moroccan (Darija)', flag: '🇲🇦' },
    { code: 'no', name: 'Norwegian', flag: '🇳🇴' },
    { code: 'fa', name: 'Persian', flag: '🇮🇷' },
    { code: 'pl', name: 'Polish', flag: '🇵🇱' },
    { code: 'pt', name: 'Portuguese (BR)', flag: '🇧🇷' },
    { code: 'pt-PT', name: 'Portuguese (PT)', flag: '🇵🇹' },
    { code: 'ro', name: 'Romanian', flag: '🇷🇴' },
    { code: 'ru', name: 'Russian', flag: '🇷🇺' },
    { code: 'sr', name: 'Serbian', flag: '🇷🇸' },
    { code: 'sk', name: 'Slovak', flag: '🇸🇰' },
    { code: 'sl', name: 'Slovenian', flag: '🇸🇮' },
    { code: 'es', name: 'Spanish', flag: '🇪🇸' },
    { code: 'sw', name: 'Swahili', flag: '🇰🇪' },
    { code: 'sv', name: 'Swedish', flag: '🇸🇪' },
    { code: 'ta', name: 'Tamil', flag: '🇮🇳' },
    { code: 'th', name: 'Thai', flag: '🇹🇭' },
    { code: 'tr', name: 'Turkish', flag: '🇹🇷' },
    { code: 'uk', name: 'Ukrainian', flag: '🇺🇦' },
    { code: 'ur', name: 'Urdu', flag: '🇵🇰' },
    { code: 'vi', name: 'Vietnamese', flag: '🇻🇳' },
];
function languagesCommand() {
    console.log(chalk_1.default.bold('\nSupported languages:\n'));
    console.log(chalk_1.default.gray('  ' + 'CODE'.padEnd(8) + 'LANGUAGE'));
    console.log(chalk_1.default.gray('  ' + '─'.repeat(36)));
    for (const { code, name, flag } of ALL_LANGUAGES) {
        console.log('  ' +
            chalk_1.default.cyan(code.padEnd(8)) +
            flag + '  ' +
            name);
    }
    console.log('\n' +
        chalk_1.default.gray('Use codes in your buildtranslator.json:') +
        '\n' +
        chalk_1.default.gray('  "targetLanguages": ["es", "fr", "hu", "ca"]') +
        '\n');
}
