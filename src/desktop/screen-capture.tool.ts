import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { removeTempFile } from '../module/support.js'
import type { IToolDefinition } from '../module/tool.js'
import type { InputControlService } from './input-control.js'

const input = z.object({})

export const createScreenCaptureTool = (inputControl: InputControlService): IToolDefinition<typeof input> => ({
  description:
    'macOS only. Capture the primary monitor and return the screenshot as an image attachment so you can see the ' +
    'current screen and decide what to do. This is your eyes: call it to inspect the UI before acting with ' +
    'macos_mouse_move/macos_mouse_click, dividing the pixel coordinates you read off it by the reported scale to ' +
    'get logical points. Inside the browser, prefer the tab_* tools, which target page elements exactly. Requires ' +
    'Screen Recording and Accessibility permissions (the shared input session grants both up front).',
  input,
  execute: async () => {
    const { path, width, height, monitor } = await inputControl.captureScreen()

    try {
      return {
        text:
          `Captured the primary monitor (${width}x${height} physical pixels, ` +
          `scale ${monitor.scaleFactor}). The screenshot is attached.`,
        // Inlined, because the host reads attachments after the call returns and the file is deleted by then.
        attachments: [
          {
            mime: 'image/png',
            url: `data:image/png;base64,${readFileSync(path).toString('base64')}`,
            filename: 'screen.png',
          },
        ],
      }
    } finally {
      removeTempFile(path)
    }
  },
})
