// Small stroke icon set drawn for GrowDeck (24px grid, currentColor).
const P = {
  overview: <><path d="M4 20V10l8-6 8 6v10" /><path d="M9 20v-5h6v5" /><path d="M12 13c0-2.2 1.2-3.4 3-3.6-.2 1.8-1.2 3.4-3 3.6z" /></>,
  devices: <><rect x="3" y="4" width="7" height="7" rx="1.5" /><rect x="14" y="4" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="6" rx="1.5" /><rect x="14" y="14" width="7" height="6" rx="1.5" /></>,
  history: <><path d="M4 19h16" /><path d="M5 15l4-5 4 3 6-7" /></>,
  automation: <><circle cx="6" cy="7" r="2.5" /><circle cx="18" cy="17" r="2.5" /><path d="M8.5 7H14a3 3 0 013 3v4.5" /><path d="M15 12.5l2 2 2-2" /></>,
  alarms: <><path d="M6 17h12l-1.5-2V11a4.5 4.5 0 00-9 0v4z" /><path d="M10.5 20h3" /></>,
  settings: <><path d="M5 6h9M18 6h1M5 12h3M12 12h7M5 18h11M20 18h-1" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>,
  light: <><path d="M9 17h6M10 20h4" /><path d="M12 3a5.5 5.5 0 00-3.2 10c.5.4.7 1 .7 1.6V15h5v-.4c0-.6.3-1.2.8-1.6A5.5 5.5 0 0012 3z" /></>,
  exhaust_fan: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="1.5" /><path d="M12 10.5c-.5-2.5.3-4.3 2.4-5M13.4 12.6c2.4.9 3.5 2.6 3.3 4.8M10.6 12.7c-1.9 1.7-3.8 1.9-5.6 1" /></>,
  circulation_fan: <><path d="M12 12c-1-3 0-6 3-7 1 3-.5 6-3 7z" /><path d="M12 12c3 1 5 3.5 4 6.5-3-.5-4.6-3.5-4-6.5z" /><path d="M12 12c-2 2.3-5 3-7.3.8 2-2.3 5-2.6 7.3-.8z" /><path d="M12 12v8" /></>,
  outlet: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M9.5 9v2.5M14.5 9v2.5" /><path d="M10 15.5h4" /></>,
  heater: <><path d="M12 3c1.5 3 4.5 4.8 4.5 9a4.5 4.5 0 01-9 0c0-1.9.8-3.2 2-4.4.2 1.6.9 2.5 1.8 2.9C11 8.3 11 5.5 12 3z" /></>,
  humidifier: <><path d="M12 3.5s-5.5 6.1-5.5 10a5.5 5.5 0 0011 0c0-3.9-5.5-10-5.5-10z" /><path d="M9.5 14a2.5 2.5 0 002.5 2.5" /></>,
  dehumidifier: <><path d="M12 3.5s-5.5 6.1-5.5 10a5.5 5.5 0 0011 0c0-3.9-5.5-10-5.5-10z" /><path d="M5 5l14 14" /></>,
  air_conditioner: <><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" /><path d="M9.5 4.5L12 6l2.5-1.5M9.5 19.5L12 18l2.5 1.5" /></>,
  switch: <><rect x="3" y="8" width="18" height="8" rx="4" /><circle cx="16" cy="12" r="2" /></>,
  select: <><path d="M5 7h14M5 12h14M5 17h9" /></>,
  camera: <><rect x="3" y="7" width="13" height="10" rx="2" /><path d="M16 11l5-3v8l-5-3" /></>,
  sensor: <><path d="M12 4v10" /><circle cx="12" cy="17" r="3" /><path d="M9.5 6h2M9.5 9h2" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  edit: <><path d="M5 19h4L19 9l-4-4L5 15z" /></>,
  trash: <><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" /></>,
  up: <><path d="M7 14l5-5 5 5" /></>,
  down: <><path d="M7 10l5 5 5-5" /></>,
  close: <><path d="M6 6l12 12M18 6L6 18" /></>,
  refresh: <><path d="M19 12a7 7 0 11-2.1-5" /><path d="M19 4v4h-4" /></>,
  back: <><path d="M14 6l-6 6 6 6" /></>,
  logout: <><path d="M14 5h4v14h-4" /><path d="M10 8l-4 4 4 4M6 12h9" /></>,
  growplan: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 9.5h16" /><path d="M12 18v-3" /><path d="M12 15c-2.2 0-3.4-1.2-3.5-3.4 2.2 0 3.4 1.2 3.5 3.4zM12 15c0-1.9 1.1-3 3-3.1 0 1.9-1.1 3-3 3.1z" /></>,
  // tabs of the Growplan page (drawn after the Growplan app)
  gp_today: <><path d="M4 20V9l8-5 8 5v11" /><path d="M9 20v-6h6v6" /></>,
  gp_feed: <><path d="M9 3h6v4l3 8a4 4 0 01-3.7 5.5H9.7A4 4 0 016 15l3-8z" /><path d="M6.7 14h10.6" /></>,
  gp_log: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1M8.5 10h7M8.5 14h7M8.5 18h4" /></>,
  gp_climate: <><path d="M12 3c3 4.2 5 6.9 5 9.4a5 5 0 01-10 0C7 9.9 9 7.2 12 3z" /></>,
  gp_light: <><path d="M4 6h16v5H4z" /><path d="M7 11v3M12 11v5M17 11v3" /><path d="M12 3v3" /></>,
  prev: <><path d="M15 5l-7 7 7 7" /></>,
  next: <><path d="M9 5l7 7-7 7" /></>,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8.5 11V8a3.5 3.5 0 017 0v3" /></>,
  send: <><path d="M4 12l16-8-6 16-3-7z" /><path d="M11 13l9-9" /></>,
}

export default function Icon({ name, size = 22, stroke = 1.7, title }) {
  const shape = P[name] || P.sensor
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      {shape}
    </svg>
  )
}

export function Logo({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="var(--ink)" />
      <path d="M16 25c0-6 0-9 0-13" stroke="var(--paper)" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M16 15c-5 0-8-3-8-8 5 0 8 3 8 8zM16 18c4 0 7-2.6 7-7-4.4 0-7 2.6-7 7z" fill="var(--leaf)" />
      <circle cx="24" cy="7" r="3" fill="var(--amber)" />
    </svg>
  )
}
