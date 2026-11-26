import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { api, type AuthUser, type Me } from '@/lib/api'

type ProfileValue = {
  ready: boolean
  deviceId: string
  displayName: string
  user: AuthUser | null
  rooms: Me['rooms']
  slots: Me['slots']
  error: string
  refresh: () => Promise<void>
  saveName: (name: string) => Promise<string | null>
  login: (login: string, password: string) => Promise<string | null>
  logout: () => Promise<void>
  exitGuest: () => Promise<string | null>
}

const emptyMe: Me = {
  deviceId: '',
  displayName: '',
  user: null,
  rooms: [],
  slots: { used: 0, max: 0 },
}
const ProfileContext = createContext<ProfileValue | null>(null)

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [me, setMe] = useState<Me>(emptyMe)
  const [error, setError] = useState('')

  const applyMe = useCallback((data: Me) => {
    setMe({
      deviceId: data.deviceId || '',
      displayName: data.displayName || data.user?.displayName || '',
      user: data.user || null,
      rooms: Array.isArray(data.rooms) ? data.rooms : [],
      slots: data.slots || { used: 0, max: 0 },
    })
  }, [])

  const refresh = useCallback(async () => {
    const res = await api<Me>('/api/me')
    if (!res.ok) {
      setError(res.message)
      setReady(true)
      return
    }
    setError('')
    applyMe(res.data)
    setReady(true)
  }, [applyMe])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const saveName = useCallback(
    async (name: string) => {
      const trimmed = name.trim()
      if (trimmed.length < 2 || trimmed.length > 32) {
        return 'Apelido: 2 a 32 caracteres.'
      }
      const res = await api<Me>('/api/me', {
        method: 'PATCH',
        body: JSON.stringify({ displayName: trimmed }),
      })
      if (!res.ok) return res.message
      setError('')
      applyMe(res.data)
      return null
    },
    [applyMe],
  )

  const login = useCallback(
    async (loginName: string, password: string) => {
      const res = await api<{ ok: boolean; user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ login: loginName, password }),
      })
      if (!res.ok) return res.message
      await refresh()
      return null
    },
    [refresh],
  )

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST', body: '{}' })
    await refresh()
  }, [refresh])

  const exitGuest = useCallback(async () => {
    const res = await api<Me>('/api/me/guest-exit', { method: 'POST', body: '{}' })
    if (!res.ok) return res.message
    setError('')
    applyMe(res.data)
    return null
  }, [applyMe])

  const value = useMemo<ProfileValue>(
    () => ({
      ready,
      deviceId: me.deviceId,
      displayName: me.displayName,
      user: me.user,
      rooms: me.rooms,
      slots: me.slots,
      error,
      refresh,
      saveName,
      login,
      logout,
      exitGuest,
    }),
    [ready, me, error, refresh, saveName, login, logout, exitGuest],
  )

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>
}

export function useProfile() {
  const value = useContext(ProfileContext)
  if (!value) throw new Error('useProfile fora do ProfileProvider')
  return value
}
