// звук окончания обратного таймера: три нарастающих сигнала через Web Audio
export function playFinishSound() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
    if (ctx.state === "suspended") ctx.resume()
    const notes = [880, 1174, 880]
    notes.forEach((freq, i) => {
      const t0 = ctx.currentTime + i * 0.28
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = "sine"
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t0)
      gain.gain.exponentialRampToValueAtTime(0.5, t0 + 0.03)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.26)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t0)
      osc.stop(t0 + 0.3)
    })
    setTimeout(() => ctx.close(), 1500)
  } catch {
    // звук — необязательная часть
  }
}
