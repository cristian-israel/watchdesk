import { Navigate, Route, Routes } from 'react-router'
import { HostPage } from './routes/host-page'
import { HomePage } from './routes/home-page'
import { SalaPage } from './routes/sala-page'

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/sala/:room" element={<SalaPage />} />
      <Route path="/host/:room" element={<HostPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
