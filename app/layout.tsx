import './globals.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Stream Control Panel',
  description: 'OBS Stream Control',
}

const themeInit = `try{if(localStorage.getItem('theme')==='light')document.documentElement.classList.add('light')}catch(e){}`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        {children}
      </body>
    </html>
  )
}
