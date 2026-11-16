import { Navigate, Route, Routes } from 'react-router'
import { ThemeToggle } from './components/theme-toggle'
import { HostPage } from './routes/host-page'
import { HomePage } from './routes/home-page'
import { SalaPage } from './routes/sala-page'

export function App() {
  return (
    <>
      <div className="fixed top-3 right-3 z-50">
        <ThemeToggle />
      </div>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/sala/:room" element={<SalaPage />} />
        <Route path="/host/:room" element={<HostPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}
