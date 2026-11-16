import { Outlet } from 'react-router'
import { AppShell } from '@/shell/app-shell'
import { ProfileProvider } from '@/shell/profile'

export function LoggedLayout() {
  return (
    <ProfileProvider>
      <AppShell>
        <Outlet />
      </AppShell>
    </ProfileProvider>
  )
}
