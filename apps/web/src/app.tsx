import { Navigate, Route, Routes, useParams } from 'react-router'
import { ActionDialogProvider } from '@/actions/action-dialog'
import { AppToaster } from '@/appearance/app-toaster'
import { HostPage } from './routes/host-page'
import { HomePage } from './routes/home-page'
import { LoggedLayout } from './routes/logged-layout'
import { PreferenciasPage } from './routes/preferencias-page'
import { SalaPage } from './routes/sala-page'
import { SalasPage } from './routes/salas-page'

function HostRedirect() {
  const { room = '' } = useParams()
  return <Navigate to={`/salas/${encodeURIComponent(room)}`} replace />
}

export function App() {
  return (
    <ActionDialogProvider>
      <AppToaster />
      <Routes>
        <Route element={<LoggedLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/salas" element={<SalasPage />} />
          <Route path="/salas/:room" element={<HostPage />} />
          <Route path="/preferencias" element={<PreferenciasPage />} />
          <Route path="/host/:room" element={<HostRedirect />} />
          <Route path="/sala/:room" element={<SalaPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ActionDialogProvider>
  )
}
