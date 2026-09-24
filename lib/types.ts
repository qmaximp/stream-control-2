export type ElementType = 'image' | 'gif' | 'video' | 'iframe' | 'text' | 'timer';

export interface StreamElement {
  id: string;
  type: ElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  src?: string;
  text?: string;
  fontSize?: number;
  color?: string;
  fontWeight?: string;
  bgColor?: string;
  opacity?: number;
  duration?: number;
  timerDirection?: 'up' | 'down';
  startTime?: number | null;
  isRunning?: boolean;
  elapsed?: number;
  timerLabel?: string;
  visible: boolean;
  alwaysLoaded?: boolean;
  zIndex: number;
}

export interface ObsSceneItem {
  itemId: number;
  sourceName: string;
  sourceType: string;
  sceneName: string;
  visible: boolean;
  isGroup: boolean;
  groupName?: string;
  children?: ObsSceneItem[];
}

export interface ObsScene {
  name: string;
  index: number;
  isCurrent: boolean;
}

export interface SyncState {
  elements: StreamElement[];
  canvasW: number;
  canvasH: number;
}
