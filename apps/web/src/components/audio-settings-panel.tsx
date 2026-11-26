import { useEffect, useState } from 'react'
import { Label } from '@/components/ui/label'
import {
  listAudioDevices,
  readAudioInputId,
  readAudioOutputId,
  supportsAudioOutputSelect,
  unlockAudioDeviceLabels,
  writeAudioInputId,
  writeAudioOutputId,
  type AudioDeviceOption,
} from '@/lib/media-devices'
import { voiceMeshSupportsDevices, type VoiceMesh } from '@/lib/voice-mesh'

type Props = {
  voice: VoiceMesh | null
  voiceEnabled: boolean
  onError?: (message: string) => void
}

export function AudioSettingsPanel({ voice, voiceEnabled, onError }: Props) {
  const [inputs, setInputs] = useState<AudioDeviceOption[]>([])
  const [outputs, setOutputs] = useState<AudioDeviceOption[]>([])
  const [inputId, setInputId] = useState(() => readAudioInputId())
  const [outputId, setOutputId] = useState(() => readAudioOutputId())
  const [loading, setLoading] = useState(true)
  const canPickOutput = supportsAudioOutputSelect()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      await unlockAudioDeviceLabels()
      if (cancelled) return
      const { inputs: ins, outputs: outs } = await listAudioDevices()
      if (cancelled) return
      setInputs(ins)
      setOutputs(outs)
      setLoading(false)
    })()

    function onChange() {
      void listAudioDevices().then(({ inputs: ins, outputs: outs }) => {
        if (cancelled) return
        setInputs(ins)
        setOutputs(outs)
      })
    }
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange)
    return () => {
      cancelled = true
      navigator.mediaDevices?.removeEventListener?.('devicechange', onChange)
    }
  }, [])

  async function changeInput(next: string) {
    setInputId(next)
    writeAudioInputId(next)
    if (!voiceEnabled) return
    if (!voiceMeshSupportsDevices(voice) || !voice) {
      onError?.('Recarregue a página para aplicar o microfone.')
      return
    }
    try {
      await voice.setInputDevice(next)
    } catch (err) {
      onError?.(err instanceof Error ? err.message : 'Falha ao trocar o microfone.')
    }
  }

  async function changeOutput(next: string) {
    setOutputId(next)
    writeAudioOutputId(next)
    if (!voiceMeshSupportsDevices(voice) || !voice) {
      onError?.('Recarregue a página para aplicar a saída de áudio.')
      return
    }
    try {
      await voice.setOutputDevice(next)
    } catch (err) {
      onError?.(err instanceof Error ? err.message : 'Falha ao trocar a saída de áudio.')
    }
  }

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">Áudio deste aparelho</p>
        <p className="text-xs text-muted-foreground">
          {voiceEnabled
            ? 'A troca vale na hora nesta sala.'
            : 'Salvo neste aparelho; entra em vigor quando a voz estiver ligada.'}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="audio-input" className="text-xs">
          Microfone
        </Label>
        <select
          id="audio-input"
          className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          value={inputId}
          disabled={loading}
          onChange={(e) => void changeInput(e.target.value)}
        >
          <option value="">Padrão do sistema</option>
          {inputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="audio-output" className="text-xs">
          Saída de som
        </Label>
        {canPickOutput ? (
          <select
            id="audio-output"
            className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            value={outputId}
            disabled={loading}
            onChange={(e) => void changeOutput(e.target.value)}
          >
            <option value="">Padrão do sistema</option>
            {outputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-xs text-muted-foreground">
            Este navegador não permite escolher a saída (setSinkId).
          </p>
        )}
      </div>
    </div>
  )
}
