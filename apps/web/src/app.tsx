import { Navigate, Route, Routes } from 'react-router'
import { HostPage } from './routes/host-page'
import { HomePage } from './routes/home-page'
import { LoggedLayout } from './routes/logged-layout'
import { PreferenciasPage } from './routes/preferencias-page'
import { SalaPage } from './routes/sala-page'
import { SalasPage } from './routes/salas-page'

export function App() {
  return (
    <Routes>
      <Route element={<LoggedLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/salas" element={<SalasPage />} />
        <Route path="/criar" element={<Navigate to="/salas" replace />} />
        <Route path="/preferencias" element={<PreferenciasPage />} />
        <Route path="/host/:room" element={<HostPage />} />
        <Route path="/sala/:room" element={<SalaPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
