import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import NewProjectModal from '../modules/feasibility/NewProjectModal'
import colors from '../theme/colors.js'

export default function Feasibility() {
  const [showModal, setShowModal] = useState(false)
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState('active')
  const [archivingId, setArchivingId] = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const navigate = useNavigate()

  async function fetchProjects(mode) {
    const { data: { user } } = await supabase.auth.getUser()
    const { data: userData } = await supabase
      .from('users')
      .select('tenant_id')
      .eq('user_id', user.id)
      .single()

    if (!userData) { setLoading(false); return }

    const { data, error } = await supabase
      .from('projects')
      .select('project_id, name, country, currency, project_type, sector, revenue_model, delivery_model, created_at, archived')
      .eq('tenant_id', userData.tenant_id)
      .eq('archived', mode === 'archived')
      .order('created_at', { ascending: false })

    if (!error) setProjects(data || [])
    setLoading(false)
  }

  useEffect(() => {
    setLoading(true)
    fetchProjects(viewMode)
  }, [viewMode])

  function handleModalClose(result) {
    setShowModal(false)
    if (result?.projectId) fetchProjects(viewMode)
  }

  async function handleArchive(e, projectId) {
    e.stopPropagation()
    const confirmed = window.confirm(
      'This project will be archived and hidden from the active list. You can restore it at any time.'
    )
    if (!confirmed) return
    setArchivingId(projectId)
    const { error } = await supabase.from('projects').update({ archived: true }).eq('project_id', projectId)
    if (error) alert('Archive failed: ' + error.message)
    else fetchProjects(viewMode)
    setArchivingId(null)
  }

  async function handleRestore(e, projectId) {
    e.stopPropagation()
    setArchivingId(projectId)
    const { error } = await supabase.from('projects').update({ archived: false }).eq('project_id', projectId)
    if (error) alert('Restore failed: ' + error.message)
    else fetchProjects(viewMode)
    setArchivingId(null)
  }

  async function handleDelete(e, projectId, projectName) {
    e.stopPropagation()
    const confirmed = window.confirm(
      'Permanently delete "' + projectName + '"?\n\nThis will delete the project and all associated data including assumptions, versions, model outputs, actuals, and variances.\n\nThis cannot be undone.'
    )
    if (!confirmed) return
    setDeletingId(projectId)
    try {
      await supabase.from('model_outputs').delete().eq('project_id', projectId)
      await supabase.from('variances').delete().eq('project_id', projectId)
      await supabase.from('actuals').delete().eq('project_id', projectId)
      await supabase.from('assumptions').delete().eq('project_id', projectId)
      const { data: scenarios } = await supabase.from('scenarios').select('scenario_id').eq('project_id', projectId)
      if (scenarios && scenarios.length) {
        const scenarioIds = scenarios.map(s => s.scenario_id)
        await supabase.from('versions').delete().in('scenario_id', scenarioIds)
      }
      await supabase.from('scenarios').delete().eq('project_id', projectId)
      const { error } = await supabase.from('projects').delete().eq('project_id', projectId)
      if (error) throw error
      fetchProjects(viewMode)
    } catch (err) {
      alert('Delete failed: ' + err.message)
    } finally {
      setDeletingId(null)
    }
  }

  // Display label: new taxonomy if available, fallback to legacy project_type
  function projectTypeLabel(p) {
    if (p.sector) return `${p.sector} · ${p.revenue_model}`
    return p.project_type
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: '600', marginBottom: '0.25rem' }}>Feasibility</h1>
          <p style={{ color: colors.textSecondary, fontSize: '0.9rem' }}>Jordan · All Sectors</p>
        </div>
        {viewMode === 'active' && (
          <button
            onClick={() => setShowModal(true)}
            style={{
              padding: '0.5rem 1.25rem', background: colors.accent, color: 'white',
              border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '0.9rem'
            }}>
            + New Project
          </button>
        )}
      </div>

      <div style={{ display: 'flex', borderBottom: `1px solid ${colors.surfaceElevated}`, marginBottom: '1.5rem' }}>
        {[
          { key: 'active', label: 'Active' },
          { key: 'archived', label: 'Archived' },
        ].map(m => (
          <button key={m.key} onClick={() => setViewMode(m.key)}
            style={{
              padding: '0.5rem 1.1rem', background: 'none', border: 'none',
              borderBottom: viewMode === m.key ? `2px solid ${colors.accent}` : '2px solid transparent',
              color: viewMode === m.key ? colors.accent : colors.textSecondary,
              cursor: 'pointer', fontSize: '0.85rem',
            }}>
            {m.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p style={{ color: colors.textSecondary, fontSize: '0.9rem' }}>Loading...</p>
      ) : projects.length === 0 ? (
        <div style={{ border: `1px solid ${colors.surfaceElevated}`, borderRadius: '8px', padding: '3rem', textAlign: 'center', color: colors.textMuted }}>
          {viewMode === 'active' ? (
            <>
              <p style={{ fontSize: '0.95rem' }}>No active projects.</p>
              <p style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
                Click <strong style={{ color: colors.textSecondary }}>+ New Project</strong> to start your first feasibility study.
              </p>
            </>
          ) : (
            <p style={{ fontSize: '0.95rem' }}>No archived projects.</p>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {projects.map(p => (
            <div key={p.project_id}
              onClick={() => navigate(`/feasibility/${p.project_id}`)}
              style={{
                background: colors.surfaceElevated,
                border: viewMode === 'archived' ? `1px solid ${colors.surfaceElevated}` : `1px solid ${colors.border}`,
                borderRadius: '8px', padding: '1.25rem 1.5rem', cursor: 'pointer',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                opacity: viewMode === 'archived' ? 0.65 : 1,
              }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.25rem' }}>
                  <span style={{ fontWeight: '600', fontSize: '1rem' }}>{p.name}</span>
                  {viewMode === 'archived' && (
                    <span style={{ fontSize: '0.65rem', padding: '1px 7px', borderRadius: '20px',
                      background: colors.surfaceElevated, color: colors.textMuted, border: `1px solid ${colors.border}` }}>
                      archived
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '0.8rem', color: colors.textSecondary }}>
                  {projectTypeLabel(p)} · {p.country} · {p.currency}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <span style={{ fontSize: '0.75rem', color: colors.textMuted }}>
                  {new Date(p.created_at).toLocaleDateString()}
                </span>
                {viewMode === 'active' ? (
                  <button
                    onClick={e => handleArchive(e, p.project_id)}
                    disabled={archivingId === p.project_id}
                    style={{
                      padding: '0.3rem 0.8rem', background: 'none',
                      border: `1px solid ${colors.border}`, borderRadius: '5px',
                      color: colors.textMuted, cursor: 'pointer', fontSize: '0.75rem',
                      opacity: archivingId === p.project_id ? 0.5 : 1,
                    }}>
                    {archivingId === p.project_id ? '...' : 'Archive'}
                  </button>
                ) : (
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      onClick={e => handleRestore(e, p.project_id)}
                      disabled={archivingId === p.project_id}
                      style={{
                        padding: '0.3rem 0.8rem', background: 'none',
                        border: `1px solid ${colors.accent}`, borderRadius: '5px',
                        color: colors.accent, cursor: 'pointer', fontSize: '0.75rem',
                        opacity: archivingId === p.project_id ? 0.5 : 1,
                      }}>
                      {archivingId === p.project_id ? '...' : 'Restore'}
                    </button>
                    <button
                      onClick={e => handleDelete(e, p.project_id, p.name)}
                      disabled={deletingId === p.project_id}
                      style={{
                        padding: '0.3rem 0.8rem', background: 'none',
                        border: `1px solid ${colors.danger}`, borderRadius: '5px',
                        color: colors.danger, cursor: 'pointer', fontSize: '0.75rem',
                        opacity: deletingId === p.project_id ? 0.5 : 1,
                      }}>
                      {deletingId === p.project_id ? 'Deleting...' : 'Delete'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && <NewProjectModal onClose={handleModalClose} />}
    </div>
  )
}
