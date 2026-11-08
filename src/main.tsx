import './theme'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { WindowFrame } from './components/TitleBar'
import './styles.css'
import './wallpaper-surfaces.css'
import './privacy.css'
import './qol.css'

ReactDOM.createRoot(document.getElementById('root')!).render(<WindowFrame><App /></WindowFrame>)
