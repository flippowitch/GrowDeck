import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import { fmt } from '../format.js'
import { dec, t } from '../i18n.js'

export function Toggle({ checked, onChange, disabled, label, tone, busy }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle ${tone || ''} ${busy ? 'busy' : ''}`}
      onClick={() => onChange(!checked)}
    />
  )
}

// Range slider that commits once the user lets go (or pauses while dragging),
// so a drag does not send dozens of commands to the device.
export function LevelSlider({ value, min, max, step = 1, unit, values, disabled, tone, onCommit, label, format }) {
  const clampValue = (v) => Math.min(max, Math.max(min, v ?? min))
  const [local, setLocal] = useState(clampValue(value))
  const dragging = useRef(false)
  const timer = useRef(null)

  useEffect(() => {
    if (!dragging.current) setLocal(clampValue(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, min, max])

  useEffect(() => () => clearTimeout(timer.current), [])

  const snap = (v) => {
    if (values && values.length) {
      return values.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), values[0])
    }
    return v
  }

  const commit = (v) => {
    clearTimeout(timer.current)
    dragging.current = false
    const snapped = snap(v)
    if (snapped !== value) onCommit(snapped)
  }

  const fill = max > min ? ((local - min) / (max - min)) * 100 : 0
  const digits = step < 1 ? 1 : 0
  return (
    <div className="level">
      <input
        type="range"
        className={tone || ''}
        min={min}
        max={max}
        step={step}
        value={local}
        disabled={disabled}
        aria-label={label}
        style={{ '--fill': `${fill}%` }}
        onChange={(e) => {
          const v = Number(e.target.value)
          dragging.current = true
          setLocal(v)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => commit(v), 700)
        }}
        onPointerUp={(e) => commit(Number(e.currentTarget.value))}
        onKeyUp={(e) => {
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
            commit(Number(e.currentTarget.value))
          }
        }}
      />
      <output>
        {format ? format(local) : fmt(local, digits)}
        {unit ? <small>{unit}</small> : null}
      </output>
    </div>
  )
}

export function Modal({ title, onClose, children, actions, wide }) {
  const ref = useRef(null)
  // Live updates re-render the parent several times per second; keep the
  // latest callback in a ref so focus is set only once when the dialog opens.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && closeRef.current()
    window.addEventListener('keydown', onKey)
    const previous = document.activeElement
    ref.current?.querySelector('input, select, textarea')?.focus()
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
      previous?.focus?.()
    }
  }, [])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && closeRef.current()}>
      <div className={`sheet ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="spread" style={{ marginBottom: 4 }}>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('Schließen')}>
            <Icon name="close" />
          </button>
        </div>
        {children}
        {actions ? <div className="sheet-actions">{actions}</div> : null}
      </div>
    </div>
  )
}

export function Segmented({ value, options, onChange, label }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.key} type="button" aria-pressed={value === o.key} onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

const DAY_LABELS = [t('Mo'), t('Di'), t('Mi'), t('Do'), t('Fr'), t('Sa'), t('So')]

// days: array of weekday numbers 0=Mo..6=So (null = every day)
export function DaysPicker({ value, onChange }) {
  const active = value ?? [0, 1, 2, 3, 4, 5, 6]
  return (
    <div className="days" role="group" aria-label={t('Wochentage')}>
      {DAY_LABELS.map((d, i) => (
        <button
          key={d}
          type="button"
          aria-pressed={active.includes(i)}
          onClick={() => {
            const next = active.includes(i) ? active.filter((x) => x !== i) : [...active, i].sort()
            onChange(next.length === 7 ? null : next)
          }}
        >
          {d}
        </button>
      ))}
    </div>
  )
}

// weekmask (bit0 = Monday .. bit6 = Sunday) <-> days array
export function WeekmaskPicker({ value = 127, onChange }) {
  const days = [0, 1, 2, 3, 4, 5, 6].filter((i) => (value >> i) & 1)
  return (
    <DaysPicker
      value={days.length === 7 ? null : days}
      onChange={(next) => onChange((next ?? [0, 1, 2, 3, 4, 5, 6]).reduce((m, i) => m | (1 << i), 0))}
    />
  )
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  )
}

export function Empty({ title, children, action }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  )
}

// Number field in the language of the page: shows 2,5 in German and 2.5 in English and
// accepts both separators. While it has focus it keeps the typed text; the arrow keys step
// within min/max like a native number field.
function parseNumber(text) {
  const clean = String(text).replace(/\s/g, '').replace(',', '.')
  if (clean === '') return null
  const n = Number(clean)
  return Number.isFinite(n) ? n : undefined
}

export function NumberInput({ value, onChange, step = 1, min, max, className = 'input', onBlur, onKeyDown, ...rest }) {
  const [text, setText] = useState(null) // null = show the value
  const shown = text ?? (value == null || value === '' || Number.isNaN(Number(value)) ? '' : dec(value))
  const stepBy = (dir) => {
    const size = Number(step) > 0 ? Number(step) : 1
    const current = text != null ? parseNumber(text) : value == null || value === '' ? null : Number(value)
    let next = current == null || Number.isNaN(current) ? Number(min ?? 0) : current + dir * size
    next = Number(next.toFixed((String(size).split('.')[1] || '').length))
    if (min != null && next < Number(min)) next = Number(min)
    if (max != null && next > Number(max)) next = Number(max)
    setText(dec(next))
    onChange(next)
  }
  return (
    <input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      className={className}
      value={shown}
      onChange={(e) => {
        setText(e.target.value)
        const n = parseNumber(e.target.value)
        if (n !== undefined) onChange(n)
      }}
      onBlur={(e) => {
        setText(null)
        onBlur?.(e)
      }}
      onKeyDown={(e) => {
        if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !rest.disabled && !rest.readOnly) {
          e.preventDefault()
          stepBy(e.key === 'ArrowUp' ? 1 : -1)
        }
        onKeyDown?.(e)
      }}
      {...rest}
    />
  )
}
