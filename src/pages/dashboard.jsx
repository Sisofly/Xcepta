import { useNavigate } from 'react-router-dom'

const modules = [
  { label: 'Feasibility',    sub: 'Real Estate · Jordan',    tag: 'MVP', status: 'In Build',  path: '/feasibility', active: true  },
  { label: 'FP&A',           sub: 'Variance & Actuals',      tag: 'MVP', status: 'In Build',  path: '/fpa',         active: true  },
  { label: 'Valuation',      sub: 'DCF · Comps · NAV',       tag: null,  status: 'Phase 2',   path: null,           active: false },
  { label: 'Budget Builder', sub: 'Driver-based planning',   tag: null,  status: 'Phase 2',   path: null,           active: false },
  { label: 'Board Pack',     sub: 'Automated assembly',      tag: null,  status: 'Phase 2',   path: null,           active: false },
]

export default function Dashboard() {
  const navigate = useNavigate()
  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '2rem' }}>

      {/* Page header */}
      <div style={{ marginBottom: '0.5rem' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: '600', color: '#e6edf3', marginBottom: '0.25rem' }}>
          Dashboard
        </h1>
        <p style={{ color: '#8b949e', fontSize: '0.9rem' }}>Welcome back — Jordan · JOD</p>
      </div>

      {/* Modules section */}
      <div style={{ marginTop: '2.5rem' }}>
        <div style={{ marginBottom: '1.25rem' }}>
          <h2 style={{ fontSize: '0.75rem', color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: '600', marginBottom: '0.3rem' }}>
            Modules
          </h2>
          <p style={{ fontSize: '0.85rem', color: '#484f58' }}>
            Select a module to begin analysis
          </p>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '20px',
        }}>
          {modules.map((m) => (
            <div
              key={m.label}
              onClick={() => m.path && navigate(m.path)}
              style={{
                padding: '1.75rem',
                background: m.active ? '#161b22' : '#0d1117',
                border: m.active ? '1px solid #30363d' : '1px solid #21262d',
                borderRadius: '10px',
                cursor: m.path ? 'pointer' : 'default',
                opacity: m.active ? 1 : 0.5,
                transition: 'border-color 0.15s',
              }}
            >
              {m.tag && (
                <div style={{ fontSize: '0.65rem', color: '#58a6ff', letterSpacing: '0.08em', marginBottom: '0.6rem' }}>
                  {m.tag}
                </div>
              )}
              <div style={{ fontWeight: '600', fontSize: '1.05rem', color: '#e6edf3', marginBottom: '0.3rem' }}>
                {m.label}
              </div>
              <div style={{ fontSize: '0.82rem', color: '#8b949e', marginBottom: '1.25rem' }}>
                {m.sub}
              </div>
              <span style={{
                fontSize: '0.75rem', padding: '3px 10px', borderRadius: '20px',
                background: m.active ? '#1f6feb22' : 'transparent',
                color:      m.active ? '#58a6ff'   : '#484f58',
                border:     m.active ? '1px solid #1f6feb' : '1px solid #30363d',
              }}>
                {m.status}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
