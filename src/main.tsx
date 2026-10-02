import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatApplication } from './application/ChatApplication'
import { GreenApiTelegramAdapter } from './adapters/GreenApiTelegramAdapter'
import { LocalStorageChatStore } from './infrastructure/LocalStorageChatStore'
import { ReactChatUI } from './ui/ReactChatUI'
import './ui/styles.css'

const application = new ChatApplication(new GreenApiTelegramAdapter(), new LocalStorageChatStore())

createRoot(document.getElementById('root')!).render(
  <StrictMode><ReactChatUI application={application} /></StrictMode>,
)

if (import.meta.hot) import.meta.hot.dispose(() => application.disconnect())
