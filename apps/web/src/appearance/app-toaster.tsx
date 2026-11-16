import { Toaster } from '@/components/ui/sonner'
import { useAppearance } from './appearance-store'

export function AppToaster() {
  const resolvedMode = useAppearance((state) => state.resolvedMode)

  return <Toaster key={resolvedMode} theme={resolvedMode} position="top-center" />
}
