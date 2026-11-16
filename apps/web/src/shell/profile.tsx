import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, type Me } from '@/lib/api'

type ProfileValue = {
  ready: boolean
  deviceId: string
  displayName: string
  room: Me['room']
  error: string
  refresh: () => Promise<void>
  saveName: (name: string) => Promise<string | null>
}

const emptyMe: Me = { deviceId: '', displayName: '', room: null }
const ProfileContext = createContext<ProfileValue | null>(null)

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [me, setMe] = useState<Me>(emptyMe)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    const res = await api<Me>('/api/me')
    if (!res.ok) {
      setError(res.message)
      setReady(true)
      return
    }
    setError('')
    setMe(res.data)
    setReady(true)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const saveName = useCallback(async (name: string) => {
    const res = await api<Me>('/api/me', {
      method: 'PATCH',
      body: JSON.stringify({ displayName: name.trim() }),
    })
    if (!res.ok) return res.message
    setError('')
    setMe(res.data)
    return null
  }, [])

  const value = useMemo<ProfileValue>(
    () => ({
      ready,
      deviceId: me.deviceId,
      displayName: me.displayName,
      room: me.room,
      error,
      refresh,
      saveName,
    }),
    [ready, me, error, refresh, saveName],
  )

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>
}

export function useProfile() {
  const value = useContext(ProfileContext)
  if (!value) throw new Error('useProfile fora do ProfileProvider')
  return value
}
