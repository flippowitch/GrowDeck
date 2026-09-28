import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import { fmt, LOCALE } from '../format.js'
import { t } from '../i18n.js'

const PALETTE = ['--leaf', '--amber', '--frost', '--alert', '--ink', '--muted']

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'
}

function timeLabels(u, splits) {
  const range = (u.scales.x.max ?? 0) - (u.scales.x.min ?? 0)
  return splits.map((ts) => {
    const d = new Date(ts * 1000)
    if (range > 2 * 86400) return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' })
    return d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
  })
}

// series: [{ label, t: number[], v: number[] }]
export default function HistoryChart({ series, unit = '', digits = 1, height = 250 }) {
  const box = useRef(null)
  useEffect(() => {
    const el = box.current
    if (!el || !series.length) return undefined
    const colors = PALETTE.map(css)
    const data = series.length === 1 ? [series[0].t, series[0].v] : uPlot.join(series.map((s) => [s.t, s.v]))
    const plot = new uPlot(
      {
        width: Math.max(280, el.clientWidth),
        height,
        scales: { x: { time: true } },
        cursor: { drag: { x: true, y: false } },
        legend: { live: true },
        series: [
          {
            label: t('Zeit'),
            value: (u, v) => (v == null ? '–' : new Date(v * 1000).toLocaleString(LOCALE, {
              day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
            })),
          },
          ...series.map((s, i) => ({
            label: s.label,
            stroke: colors[i % colors.length],
            width: 2,
            spanGaps: true,
            points: { show: false },
            value: (u, v) => (v == null ? '–' : `${fmt(v, digits)} ${unit}`),
          })),
        ],
        axes: [
          { stroke: css('--muted'), grid: { stroke: css('--line'), width: 1 }, ticks: { stroke: css('--line') }, values: timeLabels },
          {
            stroke: css('--muted'),
            grid: { stroke: css('--line'), width: 1 },
            ticks: { stroke: css('--line') },
            size: 58,
            values: (u, vals) => vals.map((v) => fmt(v, digits)),
          },
        ],
      },
      data,
      el,
    )
    const observer = new ResizeObserver(() => plot.setSize({ width: Math.max(280, el.clientWidth), height }))
    observer.observe(el)
    return () => {
      observer.disconnect()
      plot.destroy()
    }
  }, [series, unit, digits, height])
  return <div ref={box} />
}
