import { useAuth } from '../context/AuthContext'
import './Dashboard.css'

export default function Dashboard() {
  const { session } = useAuth()

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h2>Dashboard</h2>
        <p>Welcome back — Jordan · JOD</p>
      </div>

      <div className="module-grid">
        <div className="module-card active">
          <div className="module-tag">MVP</div>
          <h3>Feasibility</h3>
          <p>Real Estate · Jordan</p>
          <span className="module-status building">In Build</span>
        </div>
        <div className="module-card active">
          <div className="module-tag">MVP</div>
          <h3>FP&A</h3>
          <p>Variance & Actuals</p>
          <span className="module-status building">In Build</span>
        </div>
        <div className="module-card disabled">
          <h3>Valuation</h3>
          <p>DCF · Comps · NAV</p>
          <span className="module-status phase2">Phase 2</span>
        </div>
        <div className="module-card disabled">
          <h3>Budget Builder</h3>
          <p>Driver-based planning</p>
          <span className="module-status phase2">Phase 2</span>
        </div>
        <div className="module-card disabled">
          <h3>Board Pack</h3>
          <p>Automated assembly</p>
          <span className="module-status phase2">Phase 2</span>
        </div>
      </div>
    </div>
  )
}