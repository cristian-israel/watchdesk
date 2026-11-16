import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

type ShellModeValue = {
  immersive: boolean
  setImmersive: (value: boolean) => void
}

const ShellModeContext = createContext<ShellModeValue | null>(null)

export function ShellModeProvider({ children }: { children: ReactNode }) {
  const [immersive, setImmersive] = useState(false)
  const value = useMemo(() => ({ immersive, setImmersive }), [immersive])
  return <ShellModeContext.Provider value={value}>{children}</ShellModeContext.Provider>
}

export function useShellMode() {
  const value = useContext(ShellModeContext)
  if (!value) throw new Error('useShellMode fora do ShellModeProvider')
  return value
}

export function useImmersive(active: boolean) {
  const { setImmersive } = useShellMode()
  useEffect(() => {
    setImmersive(active)
    return () => setImmersive(false)
  }, [active, setImmersive])
}
