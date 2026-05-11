import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// ── XCEPTA full logo — dark version (white text on dark bg) ──
function XceptaLogoDark({ width = 200 }) {
  const height = Math.round(width * 90 / 430)
  return (
    <svg width={width} height={height} viewBox="0 0 430 90" xmlns="http://www.w3.org/2000/svg">
      <circle cx="108" cy="45" r="28" fill="none" stroke="#e8eff6" strokeWidth="1.5"/>
      <line x1="96" y1="33" x2="120" y2="57" stroke="#e8eff6" strokeWidth="5" strokeLinecap="round"/>
      <line x1="96" y1="57" x2="108" y2="45" stroke="#e8eff6" strokeWidth="5" strokeLinecap="round"/>
      <line x1="108" y1="45" x2="120" y2="33" stroke="#3db896" strokeWidth="5" strokeLinecap="round"/>
      <text x="152" y="62"
        fontFamily="'Helvetica Neue',Helvetica,Arial,sans-serif"
        fontSize="44" fontWeight="700" fill="#e8eff6" letterSpacing="1">
        XCEPTA
      </text>
      <text x="154" y="80"
        fontFamily="'Helvetica Neue',Helvetica,Arial,sans-serif"
        fontSize="10.5" fontWeight="400" fill="#7a8b9a" letterSpacing="2.2">
        VALUATIONS · FP&amp;A · BOARDS
      </text>
    </svg>
  )
}

export default function Login() {
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState(null)
  const [loading, setLoading]   = useState(false)
  const navigate = useNavigate()

  async function handleLogin(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      navigate('/')
    }
  }

  const inputStyle = {
    width: '100%',
    padding: '0.875rem 0.9rem',   /* ~52px height */
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: '8px',
    color: '#e6edf3',
    fontSize: '0.95rem',
    boxSizing: 'border-box',
    outline: 'none',
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0d1117',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      paddingTop: '120px',
      padding: '0 2rem',
    }}>
      {/* Logo */}
      <div style={{ marginTop: '120px', marginBottom: '3rem' }}>
        <XceptaLogoDark width={480} />
      </div>

      {/* Login card */}
      <div style={{
        width: '100%',
        maxWidth: '480px',
        background: '#161b22',
        border: '1px solid #30363d',
        borderRadius: '12px',
        padding: '2.5rem',
      }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: '600', color: '#e6edf3', marginBottom: '2rem' }}>
          Sign in to your account
        </h2>

        <form onSubmit={handleLogin}>
          <div style={{ marginBottom: '1.25rem' }}>
            <label style={{ display: 'block', fontSize: '0.78rem', color: '#8b949e', marginBottom: '0.5rem', letterSpacing: '0.03em' }}>
              Email address
            </label>
            <input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              style={inputStyle}
            />
          </div>

          <div style={{ marginBottom: '1.75rem' }}>
            <label style={{ display: 'block', fontSize: '0.78rem', color: '#8b949e', marginBottom: '0.5rem', letterSpacing: '0.03em' }}>
              Password
            </label>
            <input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              style={inputStyle}
            />
          </div>

          {error && (
            <div style={{
              background: '#3a1a1a', border: '1px solid #f85149', borderRadius: '6px',
              padding: '0.65rem 0.9rem', marginBottom: '1.25rem',
              fontSize: '0.82rem', color: '#f85149',
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: '0.875rem',
              background: '#1f6feb',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              fontSize: '0.95rem',
              fontWeight: '600',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.6 : 1,
              letterSpacing: '0.02em',
            }}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>

      <p style={{ marginTop: '2rem', fontSize: '0.75rem', color: '#484f58' }}>
        XCEPTA · Confidential
      </p>
    </div>
  )
}
