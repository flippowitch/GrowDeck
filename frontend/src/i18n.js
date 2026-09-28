// Languages: German is the source language, English comes from i18n/en.json.
//
// The German text itself is the key: t('Zeitraffer') gives "Time-lapse" in English and
// "Zeitraffer" in German. Placeholders use {name}: t('{n} Fotos', { n: 3 }).
// Values may be React elements; t() then returns an array of nodes.
//
// Texts from the server (labels, events, error messages) are German. t() translates them
// too: first by exact match, then by the keys with placeholders used as patterns
// ("{name} ist offline." matches "GGS Controller ist offline."). The captured parts are
// translated in turn, numbers get the English decimal point.
//
// The language is fixed while the page is open; switching stores the choice and reloads.
import { Fragment, createElement, isValidElement } from 'react'

const STORAGE_KEY = 'gd-lang'
export const LANG_CHOICES = ['auto', 'de', 'en']

let dict = null
export let lang = 'de'
export let LOCALE = 'de-DE'

export function langSetting() {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'de' || value === 'en') return value
  } catch {
    /* storage unavailable */
  }
  return 'auto'
}

export function setLangSetting(value) {
  try {
    if (value === 'de' || value === 'en') localStorage.setItem(STORAGE_KEY, value)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* storage unavailable: the choice lasts until the page reloads */
  }
  window.location.reload()
}

export function browserLang() {
  const list = navigator.languages?.length ? navigator.languages : [navigator.language || 'de']
  for (const item of list) {
    const code = String(item || '').toLowerCase().slice(0, 2)
    if (code === 'de' || code === 'en') return code
  }
  return 'en'
}

function pickLocale(language) {
  const wanted = language === 'en' ? 'en-GB' : 'de-DE'
  try {
    new Intl.NumberFormat(wanted).format(1.5)
    new Date().toLocaleTimeString(wanted)
    return wanted
  } catch {
    return undefined
  }
}

// Before the app renders: decide the language and load the dictionary.
export async function initI18n() {
  const setting = langSetting()
  lang = setting === 'auto' ? browserLang() : setting
  if (lang === 'en') {
    try {
      dict = (await import('./i18n/en.json')).default
    } catch {
      dict = null
      lang = 'de'
    }
  }
  LOCALE = pickLocale(lang)
  try {
    document.documentElement.lang = lang
  } catch {
    /* no document (tests) */
  }
}

// For tests and tools: use a dictionary directly.
export function setDictionary(language, dictionary) {
  lang = language
  dict = language === 'en' ? dictionary : null
  LOCALE = pickLocale(language)
  patterns = null
  cache.clear()
}

const PLACEHOLDER = /\{(\w+)\}/g

function interpolate(text, vars) {
  if (!vars) return text
  const hasNodes = Object.values(vars).some((v) => v !== null && typeof v === 'object')
  if (!hasNodes) {
    return text.replace(PLACEHOLDER, (all, name) => (name in vars ? String(vars[name] ?? '') : all))
  }
  const out = []
  let last = 0
  let index = 0
  text.replace(PLACEHOLDER, (all, name, offset) => {
    if (offset > last) out.push(text.slice(last, offset))
    const value = name in vars ? vars[name] : all
    out.push(isValidElement(value) ? createElement(Fragment, { key: `v${index++}` }, value) : value)
    last = offset + all.length
    return all
  })
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function t(key, vars) {
  if (typeof key !== 'string' || key === '') return key
  if (!dict) return vars ? interpolate(key, vars) : key
  const hit = dict[key]
  if (hit !== undefined) return vars ? interpolate(hit, vars) : hit
  if (vars) return interpolate(key, vars)
  return translateDynamic(key, 0)
}

// ------------------------------------------------------------- server texts
let patterns = null
const cache = new Map()
const NUMERIC = /^[\d\s.,–+\-/:%]+$/

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildPatterns() {
  patterns = []
  for (const [key, en] of Object.entries(dict)) {
    if (!key.includes('{')) continue
    const names = []
    const literals = []
    let source = '^'
    let last = 0
    key.replace(PLACEHOLDER, (all, name, offset) => {
      const literal = key.slice(last, offset)
      literals.push(literal)
      source += escapeRe(literal) + '(.*?)'
      names.push(name)
      last = offset + all.length
      return all
    })
    literals.push(key.slice(last))
    source += escapeRe(key.slice(last)) + '$'
    const words = literals.join('')
    if (!names.length || !/[A-Za-zÄÖÜäöüß]/.test(words)) continue
    const longest = literals.reduce((a, b) => (b.length > a.length ? b : a), '')
    patterns.push({ re: new RegExp(source, 's'), names, en, longest, weight: words.length })
  }
  patterns.sort((a, b) => b.weight - a.weight)
}

function englishNumbers(text) {
  return text.replace(/(\d),(\d)/g, '$1.$2')
}

function translatePart(part, depth) {
  if (NUMERIC.test(part)) return englishNumbers(part)
  if (depth >= 3) return part
  const hit = dict[part]
  if (hit !== undefined) return hit
  return translateDynamic(part, depth + 1)
}

function translateDynamic(text, depth) {
  if (depth === 0 && cache.has(text)) return cache.get(text)
  let result = text
  if (!patterns) buildPatterns()
  let matched = false
  for (const p of patterns) {
    if (p.longest && !text.includes(p.longest)) continue
    const m = p.re.exec(text)
    if (!m) continue
    const vars = {}
    p.names.forEach((name, i) => {
      vars[name] = translatePart(m[i + 1], depth)
    })
    result = interpolate(p.en, vars)
    matched = true
    break
  }
  if (!matched) {
    for (const sep of ['\n', ' · ']) {
      if (text.includes(sep)) {
        result = text.split(sep).map((part) => translatePart(part, depth)).join(sep)
        break
      }
    }
  }
  if (depth === 0) {
    if (cache.size > 5000) cache.clear()
    cache.set(text, result)
  }
  return result
}

// Decimal separator: dec('2.5') gives "2,5" in German and "2.5" in English.
export function dec(text) {
  const s = String(text)
  return lang === 'de' ? s.replace('.', ',') : s
}
