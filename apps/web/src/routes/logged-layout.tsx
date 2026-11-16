import { Outlet } from 'react-router'
import { AppShell } from '@/shell/app-shell'
import { ProfileProvider } from '@/shell/profile'
import { ShellModeProvider } from '@/shell/shell-mode'

export function LoggedLayout() {
  return (
    <ProfileProvider>
      <ShellModeProvider>
        <AppShell>
          <Outlet />
        </AppShell>
      </ShellModeProvider>
    </ProfileProvider>
  )
}
