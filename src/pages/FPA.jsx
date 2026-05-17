import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import colors from '../theme/colors.js'

export default function FPA() {
  const navigate = useNavigate()
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      // ── Get current user's tenant ──
      const { data: { user } } = await supabase.auth.getUser()
      const { data: userData } = await supabase
        .from('users')
        .select('tenant_id')
        .eq('user_id', user.id)
        .single()

      if (!userData) { setLoading(false); return }
      const tenant_id = userData.tenant_id

      // ── Fetch approved versions ──
      const { data: versions } = await supabase
        .from('versions')
        .select('version_id, label, approved_at, scenarios(project_id)')
        .eq('status', 'approved')

      if (!versions || versions.length === 0) {
        setLoading(false)
        return
      }

      const projectIds = [...new Set(
        versions.map(v => v.scenarios && v.scenarios.project_id).filter(Boolean)
      )]

      // ── Fetch projects filtered by tenant ──
      const { data: projectData } = await supabase
        .from('projects')
        .select('*')
        .in('project_id', projectIds)
        .eq('tenant_id', tenant_id)

      const enriched = (projectData || []).map(p => {
        const v = versions.find(v => v.scenarios && v.scenarios.project_id === p.project_id)
        return { ...p, approved_version: v }
      })

      setProjects(enriched)
      setLoading(false)
    }
    load()
  }, [])

  if (loading) return <p style={{ color: colors.textSecondary, padding: '2rem' }}>Loading...</p>

  return (
    <div>
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: '600', marginBottom: '0.25rem' }}>FP&A</h1>
        <p style={{ color: colors.textSecondary, fontSize: '0.85rem' }}>
          Variance tracking against approved feasibility baselines
        </p>
      </div>

      {projects.length === 0 ? (
        <div style={{
          background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: '8px',
          padding: '2rem', color: colors.textSecondary, fontSize: '0.875rem'
        }}>
          No approved projects yet. Approve a feasibility version first to enable FP&A tracking.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {projects.map(p => (
            <div
              key={p.project_id}
              onClick={() => navigate('/fpa/' + p.project_id)}
              style={{
                background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: '8px',
                padding: '1.25rem 1.5rem', cursor: 'pointer',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center'
              }}
            >
              <div>
                <p style={{ fontWeight: '500', marginBottom: '0.25rem', color: colors.textPrimary }}>
                  {p.name}
                </p>
                <p style={{ color: colors.textSecondary, fontSize: '0.8rem' }}>
                  {p.project_type} · {p.country} · {p.currency}
                </p>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span style={{
                  fontSize: '0.75rem', padding: '3px 10px', borderRadius: '20px',
                  background: colors.successSoft, color: colors.success, border: `1px solid ${colors.success}`
                }}>
                  approved
                </span>
                {p.approved_version && p.approved_version.approved_at && (
                  <p style={{ fontSize: '0.75rem', color: colors.textMuted, marginTop: '0.3rem' }}>
                    {p.approved_version.label} · {new Date(p.approved_version.approved_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
