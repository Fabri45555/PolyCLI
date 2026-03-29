import fs from 'fs'
import path from 'path'
import chalk from 'chalk'
import ora from 'ora'
import { parseArb, reconstructArb } from '../utils/arb'

const POLYCLI_API_URL = process.env.POLYCLI_API_URL || 'https://www.polycli.dev'
const REVIEW_WORD_THRESHOLD = 15

// ── Types ─────────────────────────────────────────────────────────────────────

interface BuildTranslatorConfig {
  sourceLanguage: string
  targetLanguages: string[]
  localesPath?: string
  markdownPath?: string
  arbPath?: string
  arbPrefix?: string
  aiReviewer?: boolean
  aiReviewerExclude?: string[]
  context?: string
  tone?: string
}

interface ReviewApiResponse {
  qualityScore: number
  scoreAfter?: number
  issues: Array<{ originalSegment: string; issueType: string; explanation: string; suggestedFix: string }>
  polishedText: string
  wordsConsumed: number
}

type JsonObject = Record<string, unknown>

// ── Helpers ───────────────────────────────────────────────────────────────────

function countWords(text: string): number {
  // CJK characters don't use spaces — count each as one word unit
  const cjkCount = (text.match(/[\u3040-\u9FFF\uAC00-\uD7AF]/g) ?? []).length
  const nonCjkCount = text.replace(/[\u3040-\u9FFF\uAC00-\uD7AF]/g, ' ').split(/\s+/).filter(Boolean).length
  return cjkCount + nonCjkCount
}

function collectReviewCandidates(
  obj: JsonObject,
  threshold: number,
  prefix = ''
): Array<{ keyPath: string; value: string }> {
  const results: Array<{ keyPath: string; value: string }> = []
  for (const [key, val] of Object.entries(obj)) {
    const keyPath = prefix ? `${prefix}.${key}` : key
    if (typeof val === 'string') {
      if (countWords(val) > threshold) results.push({ keyPath, value: val })
    } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      results.push(...collectReviewCandidates(val as JsonObject, threshold, keyPath))
    }
  }
  return results
}

function setNestedValue(obj: JsonObject, keyPath: string, value: string): void {
  const keys = keyPath.split('.')
  let current: JsonObject = obj
  for (let i = 0; i < keys.length - 1; i++) {
    current = current[keys[i]] as JsonObject
  }
  current[keys[keys.length - 1]] = value
}

async function callReviewApi(
  apiKey: string,
  originalText: string,
  translatedText: string,
  sourceLang: string,
  targetLang: string,
  sourceType: 'json' | 'markdown' | 'arb',
  extras: { context?: string; tone?: string } = {}
): Promise<ReviewApiResponse> {
  const res = await fetch(`${POLYCLI_API_URL}/api/translate/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      originalText, translatedText, sourceLang, targetLang, sourceType, ...extras
    }),
  })

  if (!res.ok) {
    let errorMsg = `Review API error: ${res.status}`
    try {
      const data = JSON.parse(await res.text()) as { error?: string }
      if (data.error) errorMsg = data.error
    } catch { /* not JSON */ }
    if (res.status === 402) {
      throw new Error(`${errorMsg}\n  Buy more credits at ${POLYCLI_API_URL}/dashboard`)
    }
    throw new Error(errorMsg)
  }

  return res.json() as Promise<ReviewApiResponse>
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function reviewCommand(options: {
  key?: string
  /** When provided, only strings whose keys appear in this delta are reviewed (JSON phase). */
  jsonDelta?: JsonObject
  /** When provided, only keys present in this delta are reviewed (ARB phase). */
  arbDelta?: Record<string, string>
}): Promise<void> {
  const apiKey = options.key ?? process.env.POLYCLI_API_KEY
  if (!apiKey) {
    console.error(
      chalk.red('Error: API key required.\n') +
      chalk.dim('  Pass --key <key> or set POLYCLI_API_KEY.')
    )
    process.exit(1)
  }

  const spinner = ora('Loading configuration...').start()
  const configPath = path.resolve(process.cwd(), 'buildtranslator.json')
  if (!fs.existsSync(configPath)) {
    spinner.fail('"buildtranslator.json" not found. Run "polycli init" first.')
    process.exit(1)
  }

  let config: BuildTranslatorConfig
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as BuildTranslatorConfig
  } catch {
    spinner.fail('Failed to parse "buildtranslator.json".')
    process.exit(1)
  }
  spinner.succeed('Configuration loaded.')

  const excluded = new Set((config.aiReviewerExclude ?? []).map(l => l.toLowerCase()))
  const langsToReview = config.targetLanguages.filter(l => !excluded.has(l.toLowerCase()))
  const skippedLangs = config.targetLanguages.filter(l => excluded.has(l.toLowerCase()))

  if (langsToReview.length === 0) {
    console.log(chalk.yellow('All target languages are excluded from review. Nothing to do.'))
    return
  }

  if (skippedLangs.length > 0) {
    console.log(chalk.dim(`Review skipped for: ${skippedLangs.join(', ')}`))
  }

  // ── JSON phase ───────────────────────────────────────────────────────────────
  if (config.localesPath) {
    const localesPath = path.resolve(process.cwd(), config.localesPath)
    const sourceFile = path.join(localesPath, `${config.sourceLanguage}.json`)

    if (!fs.existsSync(sourceFile)) {
      console.log(chalk.yellow(`JSON source not found at ${sourceFile} — skipping JSON review.`))
    } else {
      const sourceJson: JsonObject = JSON.parse(fs.readFileSync(sourceFile, 'utf8')) as JsonObject

      for (const lang of langsToReview) {
        const targetFile = path.join(localesPath, `${lang}.json`)
        if (!fs.existsSync(targetFile)) {
          console.log(chalk.dim(`  ${lang}.json not found — skipping.`))
          continue
        }

        const targetJson: JsonObject = JSON.parse(fs.readFileSync(targetFile, 'utf8')) as JsonObject
        // When a delta is available (called from `run --review`), only review strings
        // that were just translated. Standalone `polycli review` reviews all strings.
        const reviewScope = options.jsonDelta ?? sourceJson
        const sourceCandidates = collectReviewCandidates(reviewScope, REVIEW_WORD_THRESHOLD)

        if (sourceCandidates.length === 0) {
          console.log(chalk.dim(`  JSON → ${lang}: no strings exceed ${REVIEW_WORD_THRESHOLD} words — skipping.`))
          continue
        }

        let totalDeducted = 0
        for (const { keyPath, value: sourceVal } of sourceCandidates) {
          const keys = keyPath.split('.')
          let cur: unknown = targetJson
          for (const k of keys) cur = (cur as JsonObject)?.[k]
          const translatedVal = typeof cur === 'string' ? cur : ''

          if (!translatedVal) {
            console.log(chalk.dim(`  → "${keyPath}" skipped (no translation found)`))
            continue
          }

          spinner.start(`  Reviewing "${keyPath}" → ${lang}...`)
          try {
            const result = await callReviewApi(
              apiKey, sourceVal, translatedVal,
              config.sourceLanguage, lang, 'json',
              { context: config.context, tone: config.tone }
            )
            setNestedValue(targetJson, keyPath, result.polishedText)
            totalDeducted += result.wordsConsumed
            const afterScore = result.scoreAfter ?? result.qualityScore
            spinner.succeed(
              `  "${keyPath}" score ${result.qualityScore} → ${afterScore} (${result.issues.length} issue(s), ${result.wordsConsumed} credits)`
            )
          } catch (err: unknown) {
            spinner.fail(`  "${keyPath}" failed: ${err instanceof Error ? err.message : String(err)}`)
            process.exit(1)
          }
        }

        fs.writeFileSync(targetFile, JSON.stringify(targetJson, null, 2), 'utf8')
        console.log(chalk.green(`  ${lang}.json updated. Total credits deducted: ${totalDeducted}`))
      }
    }
  }

  // ── Markdown phase ────────────────────────────────────────────────────────────
  if (config.markdownPath) {
    const mdPath = path.resolve(process.cwd(), config.markdownPath)
    const sourceLangDir = path.join(mdPath, config.sourceLanguage)
    if (!fs.existsSync(sourceLangDir)) {
      console.log(chalk.yellow(`Markdown source dir not found: ${sourceLangDir} — skipping markdown review.`))
    } else {
      const mdFiles = fs.readdirSync(sourceLangDir).filter(f => f.endsWith('.md'))
      for (const lang of langsToReview) {
        for (const filename of mdFiles) {
          const sourcePath = path.join(sourceLangDir, filename)
          const targetPath = path.join(mdPath, lang, filename)
          if (!fs.existsSync(targetPath)) {
            console.log(chalk.dim(`  ${lang}/${filename} not found — skipping.`))
            continue
          }
          const sourceContent = fs.readFileSync(sourcePath, 'utf8')
          const translatedContent = fs.readFileSync(targetPath, 'utf8')
          spinner.start(`  Reviewing ${lang}/${filename}...`)
          try {
            const result = await callReviewApi(
              apiKey, sourceContent, translatedContent,
              config.sourceLanguage, lang, 'markdown',
              { context: config.context, tone: config.tone }
            )
            fs.writeFileSync(targetPath, result.polishedText, 'utf8')
            const afterScore = result.scoreAfter ?? result.qualityScore
            spinner.succeed(
              `  ${lang}/${filename} score ${result.qualityScore} → ${afterScore} (${result.issues.length} issue(s), ${result.wordsConsumed} credits)`
            )
          } catch (err: unknown) {
            spinner.fail(`  ${lang}/${filename} failed: ${err instanceof Error ? err.message : String(err)}`)
            process.exit(1)
          }
        }
      }
    }
  }

  // ── ARB phase ─────────────────────────────────────────────────────────────────
  // parseArb returns: { locale, translatableKeys, metadata, keyOrder }
  // reconstructArb(existingTranslated, newTranslations, metadata, targetLocale, keyOrder, translatedDescriptions|null)
  if (config.arbPath) {
    const prefix = config.arbPrefix ?? 'app'
    const arbPath = path.resolve(process.cwd(), config.arbPath)
    const sourceFile = path.join(arbPath, `${prefix}_${config.sourceLanguage}.arb`)

    if (!fs.existsSync(sourceFile)) {
      console.log(chalk.yellow(`ARB source not found at ${sourceFile} — skipping ARB review.`))
    } else {
      const source = parseArb(fs.readFileSync(sourceFile, 'utf8'))

      for (const lang of langsToReview) {
        const targetFile = path.join(arbPath, `${prefix}_${lang}.arb`)
        if (!fs.existsSync(targetFile)) {
          console.log(chalk.dim(`  ${prefix}_${lang}.arb not found — skipping.`))
          continue
        }

        const targetArb = parseArb(fs.readFileSync(targetFile, 'utf8'))
        // When a delta is available, restrict review to keys that were just translated.
        const arbDeltaKeys = options.arbDelta ? new Set(Object.keys(options.arbDelta)) : null
        const candidates = Object.entries(source.translatableKeys).filter(
          ([k, v]) =>
            countWords(v) > REVIEW_WORD_THRESHOLD &&
            (arbDeltaKeys === null || arbDeltaKeys.has(k))
        )

        if (candidates.length === 0) {
          console.log(chalk.dim(`  ARB → ${lang}: no strings exceed ${REVIEW_WORD_THRESHOLD} words — skipping.`))
          continue
        }

        let totalDeducted = 0
        for (const [key, sourceVal] of candidates) {
          const translatedVal = targetArb.translatableKeys[key] ?? ''
          if (!translatedVal) {
            console.log(chalk.dim(`  → "${key}" skipped (no translation)`))
            continue
          }

          spinner.start(`  ARB reviewing "${key}" → ${lang}...`)
          try {
            const result = await callReviewApi(
              apiKey, sourceVal, translatedVal,
              config.sourceLanguage, lang, 'arb',
              { context: config.context, tone: config.tone }
            )
            targetArb.translatableKeys[key] = result.polishedText
            totalDeducted += result.wordsConsumed
            const afterScore = result.scoreAfter ?? result.qualityScore
            spinner.succeed(
              `  "${key}" score ${result.qualityScore} → ${afterScore} (${result.issues.length} issue(s), ${result.wordsConsumed} credits)`
            )
          } catch (err: unknown) {
            spinner.fail(`  ARB "${key}" failed: ${err instanceof Error ? err.message : String(err)}`)
            process.exit(1)
          }
        }

        // Pass empty existingTranslated so all keys come from the updated targetArb.translatableKeys
        const output = reconstructArb(
          {},
          targetArb.translatableKeys,
          targetArb.metadata,
          lang,
          targetArb.keyOrder,
          null
        )
        fs.writeFileSync(targetFile, output, 'utf8')
        console.log(chalk.green(`  ${prefix}_${lang}.arb updated. Total credits deducted: ${totalDeducted}`))
      }
    }
  }

  console.log(chalk.bold.green('\nReview complete.'))
}
