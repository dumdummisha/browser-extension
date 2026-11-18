import type { LogicalPoint } from 'robot-ts'
import type { ClientPoint, TabInfo, TargetPoint } from '../protocol/tab.js'

// Where the viewport's top-left corner sits relative to the window's, in screen points.
export interface IViewportOffset {
  x: number
  y: number
}

type TabGeometry = Pick<TabInfo, 'zoom' | 'windowBounds'>

// The page cannot see where its viewport sits inside the window, so the first guess anchors it to the window's
// bottom-right corner: what the browser adds around the viewport sits above it (tab strip, toolbar, bookmarks bar) and
// to its left (Brave's sidebar and vertical tabs). Developer tools docked at the bottom or right break that guess; a
// measured offset replaces it.
export const estimatedViewportOffset = (target: TargetPoint, { zoom, windowBounds }: TabGeometry): IViewportOffset => ({
  x: windowBounds.width - target.innerWidth * zoom,
  y: windowBounds.height - target.innerHeight * zoom,
})

// A mousemove the page reports for the resting pointer pins the viewport's position exactly.
export const measuredViewportOffset = (
  landed: ClientPoint,
  pointer: LogicalPoint,
  { zoom, windowBounds }: TabGeometry
): IViewportOffset => ({
  x: pointer.x - landed.clientX * zoom - windowBounds.left,
  y: pointer.y - landed.clientY * zoom - windowBounds.top,
})

export const screenPoint = (
  target: ClientPoint,
  offset: IViewportOffset,
  { zoom, windowBounds }: TabGeometry
): LogicalPoint => ({
  x: windowBounds.left + offset.x + target.clientX * zoom,
  y: windowBounds.top + offset.y + target.clientY * zoom,
})
