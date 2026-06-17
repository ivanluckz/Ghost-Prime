import { useState } from 'react'
import Intro from './screens/Intro.jsx'
import Main from './screens/Main.jsx'

const skipIntro = new URLSearchParams(window.location.search).get('skipIntro')

export default function App() {
  const [stage, setStage] = useState(skipIntro ? 'main' : 'intro') // 'intro' | 'main'

  return (
    <div className="window-shell">
      <div className="app">
        {stage === 'intro' ? <Intro onComplete={() => setStage('main')} /> : <Main />}
      </div>
    </div>
  )
}
