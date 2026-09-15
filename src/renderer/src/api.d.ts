import type { OpenDesktopApi } from '../../preload'

declare global {
  interface Window {
    opendesktop: OpenDesktopApi
  }

  namespace React {
    namespace JSX {
      interface IntrinsicElements {
        /** Electron's <webview>, enabled via webviewTag in the main process. */
        webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
          src?: string
          partition?: string
          allowpopups?: string
          preload?: string
        }
      }
    }
  }
}

export {}
