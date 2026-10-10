import colors from '../../theme/colors.js'

// P-023: renders a PPP engine blocking error and/or reasonableness warnings.
// `error` is an Error thrown by runPPPEngine (message "CODE: text");
// `warnings` is the engine's warnings array [{ code, severity, message }].
function pppErrorText(error) {
  if (!error) return ''
  const msg = String(error.message || error)
  return error.code && msg.startsWith(error.code + ':') ? msg.slice(error.code.length + 1).trim() : msg
}

export default function PPPMessages({ error, warnings, title }) {
  const list = (warnings || []).filter(w => w && w.message)
  if (!error && list.length === 0) return null
  const box = (border, bg) => ({
    background: bg, border: `1px solid ${border}`, borderRadius: '8px',
    padding: '0.75rem 1.1rem', marginBottom: '1rem',
  })
  return (
    <div>
      {error && (
        <div style={box(colors.danger, colors.dangerSoft)}>
          <p style={{fontSize:'0.82rem',color:colors.danger,fontWeight:'600',marginBottom:'0.25rem'}}>
            ⛔ Model cannot be calculated{error.code ? ` (${error.code})` : ''}
          </p>
          <p style={{fontSize:'0.78rem',color:colors.textSecondary,lineHeight:1.5}}>{pppErrorText(error)}</p>
        </div>
      )}
      {list.length > 0 && (
        <div style={box(colors.warning, colors.warningSoft)}>
          <p style={{fontSize:'0.82rem',color:colors.warning,fontWeight:'600',marginBottom:'0.35rem'}}>
            {title || 'Model checks'} — {list.length} item{list.length > 1 ? 's' : ''}
          </p>
          <ul style={{margin:0,paddingLeft:'1.1rem'}}>
            {list.map((w, i) => (
              <li key={w.code + i} style={{fontSize:'0.76rem',color:colors.textSecondary,lineHeight:1.5,marginBottom:'0.2rem'}}>
                <strong style={{color: w.severity === 'warning' ? colors.warning : colors.textPrimary}}>
                  {w.severity === 'warning' ? 'Warning' : 'Note'}:
                </strong>{' '}{w.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
