import { cn } from '@/lib/utils'
import * as ResizablePrimitive from "react-resizable-panels"

function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        // Hit area ~8px; linha de 1px no centro — sem isso o drag “engasga”
        'relative flex w-2 shrink-0 items-center justify-center bg-transparent',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border',
        'hover:after:bg-primary/50 active:after:bg-primary',
        'focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden',
        'aria-[orientation=horizontal]:h-2 aria-[orientation=horizontal]:w-full',
        'aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:top-1/2 aria-[orientation=horizontal]:after:bottom-auto aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-px aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2',
        'aria-[orientation=horizontal]:[&>div]:rotate-90',
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-10 w-1 shrink-0 items-center justify-center rounded-full bg-border" />
      )}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
