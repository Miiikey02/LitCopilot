import React from 'react'
import ReactDOM from 'react-dom/client'
import './i18n'
import './index.css'
import App from './App.jsx'
import ReaderPage from './components/ReaderPage.jsx'

// 精读模式 opens in its own window, so it is its own page rather than a modal:
// a reader wants the paper on a second monitor beside whatever else they are
// doing. Path-based rather than a router — one extra route does not justify
// the dependency, and the SPA catch-all on the server already serves it.
const isReader = window.location.pathname.replace(/\/+$/, '') === '/read'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isReader ? <ReaderPage /> : <App />}
  </React.StrictMode>
)
