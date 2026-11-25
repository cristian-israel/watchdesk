/** Threshold RMS (0..1) to start speaking. */
export const SPEAK_ON = 0.02
/** Threshold RMS to stop speaking (hysteresis). */
export const SPEAK_OFF = 0.012
/** Hold speaking true for this many ms after level drops below SPEAK_OFF. */
export const SPEAK_HOLD_MS = 200

/**
 * Hysteresis for speaking indicator.
 * Returns whether the peer should be considered speaking now.
 */
export function isSpeaking(
  rms: number,
  wasSpeaking: boolean,
  lastSpokeAt: number,
  now = Date.now(),
): boolean {
  if (rms >= SPEAK_ON) return true
  if (!wasSpeaking) return false
  if (rms >= SPEAK_OFF) return true
  return now - lastSpokeAt < SPEAK_HOLD_MS
}

/** Time-domain RMS from AnalyserNode byte data (0..1). */
export function rmsFromTimeDomain(data: Uint8Array): number {
  if (!data.length) return 0
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    const v = (data[i]! - 128) / 128
    sum += v * v
  }
  return Math.sqrt(sum / data.length)
}
