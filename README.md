# @polycli/cli

> AI-powered, build-time i18n for JSON, Markdown, and Flutter ARB files.

PolyCLI translates only new and changed strings on every run — so you never pay to re-translate what hasn't changed. No runtime library, no hydration cost, no SEO penalty.

---

## How it works

PolyCLI keeps a **lockfile** next to your source translation file. On each run it computes the **delta** — keys that are new or whose values changed — and sends only those strings to the API. Translated files are merged, so unchanged strings are left untouched.

```
First run  → sends 100 strings, writes 4 language files
Second run → adds 3 new strings, sends 3 strings only
Third run  → nothing changed, skips instantly
```

---

## Supported file types

| Format | Use case |
|--------|----------|
| **JSON** | React, Vue, Angular (ngx-translate), Next.js, Nuxt, Laravel (PHP), Svelte, and any app using flat or nested JSON locale files |
| **Markdown** | Documentation sites, blog posts, content translated per language folder |
| **Flutter ARB** | Flutter / Dart apps using the standard `intl` package |

---

## Install

```bash
npm install -g @polycli/cli
```

Or run without installing via `npx`:

```bash
npx @polycli/cli init
```

---

## Quick start

**1. Get an API key**

Create a free account at [polycli.dev](https://www.polycli.dev) — you get 500 free credits on signup.

**2. Initialise your project**

```bash
polycli init
```

The interactive wizard creates `buildtranslator.json` in your project root. You'll be prompted for:

- Source language (e.g. `en`)
- Target languages (e.g. `es,fr,de,it,ja`)
- Path to your JSON locales folder (e.g. `./locales`)
- Optionally: Markdown path, Flutter ARB path, translation tone, glossary

**3. Run translations**

```bash
polycli run --key YOUR_API_KEY
```

Or store the key in an environment variable and omit the flag:

```bash
export POLYCLI_API_KEY=bt_live_xxxxxxxx
polycli run
```

---

## Commands

### `polycli init`

Interactive setup wizard. Creates or updates `buildtranslator.json`. Safe to re-run — existing values are shown as defaults so you can change only what you need.

---

### `polycli run [options]`

Calculates the delta and translates all new or changed strings.

| Option | Description |
|--------|-------------|
| `-k, --key <key>` | API key (or set `POLYCLI_API_KEY` env var) |
| `--review` | Run AI Reviewer after translation (costs 3× credits per reviewed string) |

What happens on each run:

1. Loads `buildtranslator.json`
2. Analyses source content to build a translation context
3. Computes the delta against the lockfile
4. Sends only changed strings to the API (chunked to respect serverless timeouts)
5. Merges results into existing target files
6. Updates the lockfile
7. If `--review` or `aiReviewer: true`: runs the AI Reviewer on translated strings

---

### `polycli review [options]`

Runs the AI Reviewer on your existing translated files without re-translating. Useful after manual edits or when you want a quality pass on a specific language.

Only strings longer than 15 words are sent for review (shorter strings don't benefit enough to justify the cost).

| Option | Description |
|--------|-------------|
| `-k, --key <key>` | API key (or set `POLYCLI_API_KEY` env var) |

---

### `polycli languages`

Lists all supported languages with their ISO 639-1 codes.

---

## Configuration (`buildtranslator.json`)

```json
{
  "sourceLanguage": "en",
  "targetLanguages": ["es", "fr", "de", "it", "ja", "zh"],
  "localesPath": "./locales",
  "markdownPath": "./docs",
  "arbPath": "./lib/l10n",
  "arbPrefix": "app",
  "translateArbDescriptions": false,
  "tone": "friendly and concise",
  "aiReviewer": false,
  "aiReviewerExclude": ["zh", "ja"],
  "glossary": {
    "doNotTranslate": ["PolyCLI", "API", "dashboard"],
    "preferredTranslations": {
      "credits": "créditos",
      "Early Bird": { "es": "Madrugador", "fr": "Lève-tôt" }
    }
  }
}
```

### Fields reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sourceLanguage` | `string` | Yes | ISO 639-1 code of the source language |
| `targetLanguages` | `string[]` | Yes | ISO 639-1 codes of target languages |
| `localesPath` | `string` | Yes* | Folder containing `<lang>.json` files |
| `markdownPath` | `string` | No | Folder with `<lang>/*.md` structure |
| `arbPath` | `string` | No | Folder containing Flutter `.arb` files |
| `arbPrefix` | `string` | No | ARB filename prefix (default: `app`) |
| `translateArbDescriptions` | `boolean` | No | Translate `@key` descriptions (costs extra credits) |
| `tone` | `string` | No | Style/tone hint for the AI, max 200 chars (e.g. `"formal"`, `"playful and short"`) |
| `aiReviewer` | `boolean` | No | Automatically run the AI Reviewer after every `polycli run` |
| `aiReviewerExclude` | `string[]` | No | Languages to skip during AI review |
| `phpVariables` | `boolean` | No | Protect Laravel/PHP `:variable` syntax (`:name`, `:count`, etc.) — tokenised client-side before the API call, never seen by the AI |
| `glossary.doNotTranslate` | `string[]` | No | Terms that must never be translated |
| `glossary.preferredTranslations` | `object` | No | Force specific translations — per term or per language |

*At least one of `localesPath`, `markdownPath`, or `arbPath` is required.

---

## Variable and tag protection

PolyCLI automatically detects and protects interpolation tokens and HTML/JSX tags — they are never sent to the AI and are restored verbatim in the output. Protected patterns:

| Pattern | Examples |
|---------|---------|
| `{{double_curlies}}` | Handlebars, React i18next, Vue |
| `{single_curly}` | Generic i18n, ICU format |
| `{count, plural, one {item} other {items}}` | ICU plural forms |
| `<Tag />`, `<br>`, `</p>` | HTML, JSX, XML tags |
| `%%variable%%` | Double-percent delimiters |

These tokens are also **not billed** — you only pay for the actual words being translated.

---

## File structure

### JSON

```
locales/
├── en.json                  ← source file
├── es.json                  ← generated / updated by polycli
├── fr.json
└── .translator-lock.json    ← delta tracking — commit this file
```

### Markdown

Markdown files are split into paragraph-level blocks. Each block is hashed; only blocks whose content changed are sent. A cache file stores translations by hash.

```
docs/
├── en/
│   └── guide.md             ← source file
├── es/
│   └── guide.md             ← generated by polycli
└── .polycli-md-cache.json   ← cache — commit this file
```

### Flutter ARB

```
lib/l10n/
├── app_en.arb               ← source file
├── app_es.arb               ← generated / updated by polycli
└── .polycli-arb-lock.json   ← lock file — commit this file
```

---

## CI/CD integration

Run PolyCLI before your build step. Set `POLYCLI_API_KEY` as a secret in your CI environment.

```yaml
# GitHub Actions
- name: Translate
  run: npx @polycli/cli run
  env:
    POLYCLI_API_KEY: ${{ secrets.POLYCLI_API_KEY }}
```

Commit the generated files into your repository, or consume them as build artifacts — either approach works.

---

## Credits

Each credit = 1 translated word.

- Protected tokens (variables, tags, glossary terms) are never billed.
- The AI Reviewer costs 3× the word count of the reviewed string.
- Unchanged strings on subsequent runs cost 0 credits.

New accounts receive 500 free credits. Top up at [polycli.dev/dashboard](https://www.polycli.dev/dashboard).

---

## License

MIT
