import { useEffect, useRef } from 'react'
import introVideo from '@assets/intro.mp4'

export default function Intro({ onComplete }) {
  const videoRef = useRef(null)
  const doneRef = useRef(false)

  function finish() {
    if (doneRef.current) return
    doneRef.current = true
    onComplete()
  }

  useEffect(() => {
    const onKey = () => finish()
    window.addEventListener('keydown', onKey)

    // Hard cap — never trap the user, even if the video stalls under software decoding.
    const cap = setTimeout(finish, 7000)
    // If real playback hasn't begun shortly after mount, the software decoder likely
    // choked (Crostini) — skip straight to the app rather than show a black screen.
    const stall = setTimeout(() => {
      const v = videoRef.current
      if (!v || v.paused || v.readyState < 3 || v.currentTime === 0) finish()
    }, 1900)

    return () => {
      window.removeEventListener('keydown', onKey)
      clearTimeout(cap)
      clearTimeout(stall)
    }
  }, [])

  return (
    <div className="intro" onClick={finish} onPointerDown={finish} title="Click or press any key to skip">
      <video
        ref={videoRef}
        className="intro-video"
        src={introVideo}
        autoPlay
        muted
        playsInline
        onEnded={finish}
        onError={finish}
      />
      <div className="intro-skip">click or press any key to skip</div>
    </div>
  )
}
