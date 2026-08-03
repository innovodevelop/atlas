/**
 * The Atlas UI primitives.
 *
 * One import path for every surface:
 *
 *   import { Card, Panel, Row, Empty, Button } from '@/components/atlas-ui/primitives';
 *
 * These emit Workshop class names (`.cardB`, `.gpanel`, `.row0`, `.dock`…)
 * rather than inline styles or CSS-in-JS, which is the convention the rest of
 * the app follows and what keeps a restyle a stylesheet-only change. New
 * classes exist only where the app had no equivalent — Card skins, Panel tones,
 * the Button set and the three Empty scales. See the block marked
 * "T1 — SHARED PRIMITIVES" at the end of src/styles/workshop.css.
 *
 * Do NOT build these on `src/components/ui/` — that is shadcn scaffolding used
 * almost exclusively by the URL-only routes, and its variants carry borders.
 */
export { Card, type CardSkin, type CardSize } from './Card';
export { Panel, type PanelTone, type PanelPad } from './Panel';
export { StatTile, type StatDirection } from './StatTile';
export { Button, type ButtonVariant, type ButtonSize } from './Button';
export { Row } from './Row';
export { Empty, type EmptySize, type EmptyStatus } from './Empty';
export { Dock, type DockItem, type DockItemKind } from './Dock';
