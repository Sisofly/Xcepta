import { Outlet, NavLink } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { LayoutDashboard, TrendingUp, BarChart3, LogOut } from 'lucide-react'
import './AppLayout.css'

export default function AppLayout() {
  const { signOut, session } = useAuth()

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <span className="logo-text">XCEPTA</span>
          <span className="logo-tag">BETA</span>
        </div>

        <nav className="sidebar-nav">
          <NavLink to="/" end className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
            <LayoutDashboard size={16} />
            <span>Dashboard</span>
          </NavLink>
          <NavLink to="/feasibility" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
            <TrendingUp size={16} />
            <span>Feasibility</span>
          </NavLink>
          <NavLink to="/fpa" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
            <BarChart3 size={16} />
            <span>FP&A</span>
          </NavLink>
        </nav>

        <div className="sidebar-footer">
          <span className="user-email">{session?.user?.email}</span>
          <button className="signout-btn" onClick={signOut}>
            <LogOut size={14} />
          </button>
        </div>
      </aside>

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  )
}