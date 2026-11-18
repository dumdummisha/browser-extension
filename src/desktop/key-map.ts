import { Key, Modifier } from 'robot-ts'
import { PluginError } from '../module/tool.js'

// robot-ts Key values are physical key positions (USB HID usages); lookups are lower-case. Text goes through
// typeText instead, so this map holds only named keys for presses and shortcuts.
const KEY_BY_NAME: Record<string, Key> = {
  'a': Key.A,
  'b': Key.B,
  'c': Key.C,
  'd': Key.D,
  'e': Key.E,
  'f': Key.F,
  'g': Key.G,
  'h': Key.H,
  'i': Key.I,
  'j': Key.J,
  'k': Key.K,
  'l': Key.L,
  'm': Key.M,
  'n': Key.N,
  'o': Key.O,
  'p': Key.P,
  'q': Key.Q,
  'r': Key.R,
  's': Key.S,
  't': Key.T,
  'u': Key.U,
  'v': Key.V,
  'w': Key.W,
  'x': Key.X,
  'y': Key.Y,
  'z': Key.Z,

  '1': Key.Digit1,
  '2': Key.Digit2,
  '3': Key.Digit3,
  '4': Key.Digit4,
  '5': Key.Digit5,
  '6': Key.Digit6,
  '7': Key.Digit7,
  '8': Key.Digit8,
  '9': Key.Digit9,
  '0': Key.Digit0,
  'digit1': Key.Digit1,
  'digit2': Key.Digit2,
  'digit3': Key.Digit3,
  'digit4': Key.Digit4,
  'digit5': Key.Digit5,
  'digit6': Key.Digit6,
  'digit7': Key.Digit7,
  'digit8': Key.Digit8,
  'digit9': Key.Digit9,
  'digit0': Key.Digit0,

  'enter': Key.Enter,
  'return': Key.Enter,
  'escape': Key.Escape,
  'esc': Key.Escape,
  'backspace': Key.Backspace,
  'tab': Key.Tab,
  'space': Key.Space,
  'spacebar': Key.Space,
  'delete': Key.Delete,
  'del': Key.Delete,
  'insert': Key.Insert,

  'home': Key.Home,
  'end': Key.End,
  'pageup': Key.PageUp,
  'pagedown': Key.PageDown,
  'arrowup': Key.UpArrow,
  'arrowdown': Key.DownArrow,
  'arrowleft': Key.LeftArrow,
  'arrowright': Key.RightArrow,
  'up': Key.UpArrow,
  'down': Key.DownArrow,
  'left': Key.LeftArrow,
  'right': Key.RightArrow,

  'minus': Key.Minus,
  'equal': Key.Equal,
  'leftbracket': Key.LeftBracket,
  'rightbracket': Key.RightBracket,
  'backslash': Key.Backslash,
  'semicolon': Key.Semicolon,
  'quote': Key.Quote,
  'grave': Key.Grave,
  'comma': Key.Comma,
  'period': Key.Period,
  'slash': Key.Slash,

  'f1': Key.F1,
  'f2': Key.F2,
  'f3': Key.F3,
  'f4': Key.F4,
  'f5': Key.F5,
  'f6': Key.F6,
  'f7': Key.F7,
  'f8': Key.F8,
  'f9': Key.F9,
  'f10': Key.F10,
  'f11': Key.F11,
  'f12': Key.F12,
}

// Meta is Command on macOS.
const MODIFIER_BY_NAME: Record<string, Modifier> = {
  control: Modifier.Control,
  ctrl: Modifier.Control,
  shift: Modifier.Shift,
  alt: Modifier.Alt,
  option: Modifier.Alt,
  opt: Modifier.Alt,
  meta: Modifier.Meta,
  cmd: Modifier.Meta,
  command: Modifier.Meta,
  super: Modifier.Meta,
  win: Modifier.Meta,
  windows: Modifier.Meta,
}

export const keyFromName = (name: string): Key => {
  const key = KEY_BY_NAME[name.trim().toLowerCase()]
  if (key === undefined) {
    throw new PluginError(
      `Unknown key "${name}". Use a named key like Enter, Escape, Tab, Space, Backspace, ` +
        `Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, F1-F12, a letter A-Z, ` +
        `or a digit 0-9. To type arbitrary text, use macos_keyboard_type instead.`,
      'VALIDATION_ERROR'
    )
  }

  return key
}

// The left-hand key of each modifier, which is held to keep the modifier down across a click or a drag.
const KEY_BY_MODIFIER: Record<Modifier, Key> = {
  [Modifier.Control]: Key.LeftControl,
  [Modifier.Shift]: Key.LeftShift,
  [Modifier.Alt]: Key.LeftAlt,
  [Modifier.Meta]: Key.LeftMeta,
}

export const modifierKey = (modifier: Modifier): Key => KEY_BY_MODIFIER[modifier]

export const modifiersFromNames = (names: readonly string[]): Modifier[] =>
  names.map((name) => {
    const modifier = MODIFIER_BY_NAME[name.trim().toLowerCase()]
    if (modifier === undefined) {
      throw new PluginError(
        `Unknown modifier "${name}". Accepted modifiers: Control (ctrl), Shift, Alt (option), Meta (cmd/command).`,
        'VALIDATION_ERROR'
      )
    }

    return modifier
  })
