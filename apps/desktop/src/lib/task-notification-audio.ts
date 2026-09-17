import type { TaskRunNotification } from "@/lib/api"

let audioContext: AudioContext | null = null
let dingAudio: HTMLAudioElement | null = null

const DING_SOUND_URL = "/sounds/ding.wav"

function getAudioContext() {
  if (audioContext) {
    return audioContext
  }
  const AudioContextConstructor = window.AudioContext
  if (!AudioContextConstructor) {
    return null
  }
  audioContext = new AudioContextConstructor()
  return audioContext
}

/** Call from a user gesture such as the task-start button to permit playback. */
export async function unlockTaskNotificationAudio() {
  const context = getAudioContext()
  if (context?.state === "suspended") {
    await context.resume()
  }
}

export function announceTaskNotification(notification: TaskRunNotification) {
  if (notification.sound === "ding") {
    playDing()
  }
  speak(notification.speech || notification.message)
}

function playDing() {
  const audio = getDingAudio()
  audio.currentTime = 0
  void audio.play().catch(() => playSynthesizedDing())
}

function getDingAudio() {
  if (!dingAudio) {
    dingAudio = new Audio(DING_SOUND_URL)
    dingAudio.preload = "auto"
  }
  return dingAudio
}

// Browsers can reject delayed media playback. Keep the Web Audio tone as a
// fallback once it has been unlocked from the task-start user gesture.
function playSynthesizedDing() {
  const context = getAudioContext()
  if (!context || context.state !== "running") {
    return
  }

  const start = context.currentTime
  for (const [offset, frequency] of [[0, 880], [0.14, 1320]] as const) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = "sine"
    oscillator.frequency.setValueAtTime(frequency, start + offset)
    gain.gain.setValueAtTime(0.0001, start + offset)
    gain.gain.exponentialRampToValueAtTime(0.22, start + offset + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.42)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(start + offset)
    oscillator.stop(start + offset + 0.45)
  }
}

function speak(text: string) {
  if (!text || !window.speechSynthesis) {
    return
  }
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = "zh-CN"
  utterance.rate = 1
  window.speechSynthesis.speak(utterance)
}
