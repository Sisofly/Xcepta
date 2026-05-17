import { Outlet, NavLink } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import colors from '../../theme/colors.js'

// ── XCEPTA icon mark — light version (inline SVG, no file dependency) ──
function XceptaIcon({ size = 24 }) {
  const s = size
  const cx = s / 2, cy = s / 2, r = s * 0.43
  const scale = s / 70
  // Original icon coords scaled from 70×70 viewBox
  return (
    <svg width={s} height={s} viewBox="0 0 70 70" style={{ flexShrink: 0 }}>
      <circle cx="35" cy="35" r="30" fill="none" stroke={colors.textSecondary} strokeWidth="1.8"/>
      <line x1="21" y1="21" x2="49" y2="49" stroke={colors.textPrimary} strokeWidth="6" strokeLinecap="round"/>
      <line x1="21" y1="49" x2="35" y2="35" stroke={colors.textPrimary} strokeWidth="6" strokeLinecap="round"/>
      <line x1="35" y1="35" x2="49" y2="21" stroke={colors.success} strokeWidth="6" strokeLinecap="round"/>
    </svg>
  )
}

export default function AppLayout() {
  return (
    <div style={{ display: 'flex', height: '100vh', background: colors.bg, color: colors.textPrimary }}>
      <aside style={{ width: '240px', background: colors.surface, borderRight: `1px solid ${colors.surfaceElevated}`, display: 'flex', flexDirection: 'column', padding: '1.5rem 0' }}>

        {/* Logo — desktop: icon + wordmark | mobile: icon only */}
        <div style={{ padding: '0 1.5rem 2rem', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <XceptaIcon size={30} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontWeight: '700', fontSize: '1.3rem', letterSpacing: '0.05em', lineHeight: 1 }}>XCEPTA</span>
            <span style={{ fontSize: '0.65rem', background: colors.accent, color: 'white', padding: '2px 6px', borderRadius: '4px', lineHeight: 1 }}>BETA</span>
          </div>
        </div>

        <nav style={{ flex: 1 }}>
          {[
            { to: '/', label: 'Dashboard', icon: '▦' },
            { to: '/feasibility', label: 'Feasibility', icon: '◈' },
            { to: '/fpa', label: 'FP&A', icon: '◎' },
          ].map(({ to, label, icon }) => (
            <NavLink key={to} to={to} end={to === '/'}
              style={({ isActive }) => ({
                display: 'flex', alignItems: 'center', gap: '0.75rem',
                padding: '0.6rem 1.5rem', textDecoration: 'none',
                color: isActive ? colors.accent : colors.textSecondary,
                background: isActive ? colors.surface : 'transparent',
                borderLeft: isActive ? `2px solid ${colors.accent}` : '2px solid transparent',
                fontSize: '0.9rem'
              })}>
              <span>{icon}</span>{label}
            </NavLink>
          ))}
        </nav>

        <div style={{ padding: '0 1.5rem' }}>
          <button onClick={() => supabase.auth.signOut()}
            style={{ width: '100%', padding: '0.5rem', background: 'transparent', border: `1px solid ${colors.surfaceElevated}`, color: colors.textSecondary, borderRadius: '6px', cursor: 'pointer', fontSize: '0.8rem' }}>
            Sign Out
          </button>
        </div>
      </aside>

      <main style={{ flex: 1, overflowY: 'auto', padding: '2.5rem' }}>
        <Outlet />
      </main>
    </div>
  )
}
