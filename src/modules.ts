import { BridgeClient, RECONNECT_DELAY_MS } from './client/bridge-client.js'
import { focusAppTool } from './desktop/focus-app.tool.js'
import { InputControlService } from './desktop/input-control.js'
import { createKeyboardPressTool } from './desktop/keyboard-press.tool.js'
import { createKeyboardTypeTool } from './desktop/keyboard-type.tool.js'
import { listAppsTool } from './desktop/list-apps.tool.js'
import { createMouseClickTool } from './desktop/mouse-click.tool.js'
import { createMouseCurrentPositionTool } from './desktop/mouse-current-position.tool.js'
import { createMouseDragTool } from './desktop/mouse-drag.tool.js'
import { createMouseMoveTool } from './desktop/mouse-move.tool.js'
import { createMouseScrollTool } from './desktop/mouse-scroll.tool.js'
import { createScreenCaptureTool } from './desktop/screen-capture.tool.js'
import { SOCKET_PATH } from './host/paths.js'
import { logWarning } from './module/support.js'
import { type IModuleDefinition, zodJsonSchema } from './module/tool.js'
import { BrowserControlService } from './tools/browser-control.js'
import { createClickTool } from './tools/click.tool.js'
import { createCloseTabTool } from './tools/close-tab.tool.js'
import { REQUEST_TIMEOUT_MS } from './tools/config.js'
import { createDragTool } from './tools/drag.tool.js'
import { createFillTool } from './tools/fill.tool.js'
import { createFindTool } from './tools/find.tool.js'
import { createListTabsTool } from './tools/list-tabs.tool.js'
import { createNetworkTool } from './tools/network.tool.js'
import { createOpenTabTool } from './tools/open-tab.tool.js'
import { createPressTool } from './tools/press.tool.js'
import { createReadTool } from './tools/read.tool.js'
import { createScreenshotTool } from './tools/screenshot.tool.js'
import { createScrollTool } from './tools/scroll.tool.js'
import { createSelectOptionTool } from './tools/select-option.tool.js'
import { createSwitchTabTool } from './tools/switch-tab.tool.js'
import { createTypeTool } from './tools/type.tool.js'
import { createWaitTool } from './tools/wait.tool.js'

// The two modules misha-browser serves, as a host loads them (module/tool.ts IModuleDefinition): misha-browser's own MCP
// server, and a Misha extension through a one-line entry that re-exports one of them. The robot-ts input session is
// never disposed: on Bun, a call into a freed native handle is a fatal napi error.

// The tab_* tools: the user's own browser, read through the extension and driven with real input.
export const browserModule: IModuleDefinition = {
  create: () => {
    // The tools never listen for the extension's events, so none can reach this client.
    const bridge = new BridgeClient({
      socketPath: SOCKET_PATH,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      reconnectDelayMs: RECONNECT_DELAY_MS,
      onHandlerError: (event) =>
        logWarning('browser', `event ${event.id} reached a bridge client that does not listen`),
    })

    const browser = new BrowserControlService(bridge, new InputControlService())

    return {
      tools: {
        tab_list: createListTabsTool(browser),
        tab_switch: createSwitchTabTool(browser),
        tab_open: createOpenTabTool(browser),
        tab_close: createCloseTabTool(browser),
        tab_read: createReadTool(browser),
        tab_find: createFindTool(browser),
        tab_wait: createWaitTool(browser),
        tab_screenshot: createScreenshotTool(browser),
        tab_network: createNetworkTool(browser),
        tab_click: createClickTool(browser),
        tab_drag: createDragTool(browser),
        tab_type: createTypeTool(browser),
        tab_fill: createFillTool(browser),
        tab_select_option: createSelectOptionTool(browser),
        tab_press: createPressTool(browser),
        tab_scroll: createScrollTool(browser),
      },
      dispose: () => bridge.close(),
    }
  },
  jsonSchema: zodJsonSchema,
}

// The macos_* tools: the mouse, keyboard and screen of the Mac, and its running apps.
export const desktopModule: IModuleDefinition = {
  create: () => {
    const input = new InputControlService()

    return {
      tools: {
        macos_mouse_move: createMouseMoveTool(input),
        macos_mouse_click: createMouseClickTool(input),
        macos_mouse_current_position: createMouseCurrentPositionTool(input),
        macos_mouse_drag: createMouseDragTool(input),
        macos_mouse_scroll: createMouseScrollTool(input),
        macos_keyboard_type: createKeyboardTypeTool(input),
        macos_keyboard_press: createKeyboardPressTool(input),
        macos_screen_capture: createScreenCaptureTool(input),
        macos_list_apps: listAppsTool,
        macos_focus_app: focusAppTool,
      },
    }
  },
  jsonSchema: zodJsonSchema,
}
