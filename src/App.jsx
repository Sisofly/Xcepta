import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import AppLayout from './components/layout/AppLayout'
import Login from './pages/login'
import Dashboard from './pages/dashboard'
import Feasibility from './pages/Feasibility'
import FeasibilityProject from './pages/FeasibilityProject'
import FPA from './pages/FPA'
import FPAProject from './pages/FPAProject'
import { AuthProvider, useAuth } from './context/AuthContext'

function ProtectedRoute({ children }) {
  const { session, loading } = useAuth()
  if (loading) return <div style={{ color: '#8b949e', padding: '2rem' }}>Loading...</div>
  if (!session) return <Navigate to="/login" replace />
  return children
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }>
            <Route index element={<Dashboard />} />
            <Route path="feasibility" element={<Feasibility />} />
            <Route path="feasibility/:projectId" element={<FeasibilityProject />} />
            <Route path="fpa" element={<FPA />} />
            <Route path="fpa/:projectId" element={<FPAProject />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
