const INPUT_KEY = 'watchdesk.audioInput'
const OUTPUT_KEY = 'watchdesk.audioOutput'

export type AudioDeviceOption = {
  deviceId: string
  label: string
}

export function readAudioInputId() {
  try {
    return localStorage.getItem(INPUT_KEY) || ''
  } catch {
    return ''
  }
}

export function readAudioOutputId() {
  try {
    return localStorage.getItem(OUTPUT_KEY) || ''
  } catch {
    return ''
  }
}

export function writeAudioInputId(deviceId: string) {
  try {
    if (deviceId) localStorage.setItem(INPUT_KEY, deviceId)
    else localStorage.removeItem(INPUT_KEY)
  } catch {
    /* ignore */
  }
}

export function writeAudioOutputId(deviceId: string) {
  try {
    if (deviceId) localStorage.setItem(OUTPUT_KEY, deviceId)
    else localStorage.removeItem(OUTPUT_KEY)
  } catch {
    /* ignore */
  }
}

export function supportsAudioOutputSelect() {
  return typeof HTMLAudioElement !== 'undefined' && 'setSinkId' in HTMLAudioElement.prototype
}

export async function listAudioDevices(): Promise<{
  inputs: AudioDeviceOption[]
  outputs: AudioDeviceOption[]
}> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { inputs: [], outputs: [] }
  }
  const all = await navigator.mediaDevices.enumerateDevices()
  const inputs = all
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `Microfone ${i + 1}`,
    }))
  const outputs = all
    .filter((d) => d.kind === 'audiooutput')
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `Saída ${i + 1}`,
    }))
  return { inputs, outputs }
}

/** Libera labels dos dispositivos (precisa de permissão de mic uma vez). */
export async function unlockAudioDeviceLabels() {
  if (!navigator.mediaDevices?.getUserMedia) return
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    for (const t of stream.getTracks()) t.stop()
  } catch {
    /* permissão negada — lista pode vir sem label */
  }
}
