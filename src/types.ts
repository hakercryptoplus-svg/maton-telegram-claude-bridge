export type BridgeMode = 'idle' | 'awaiting-email' | 'awaiting-confirmation' | 'awaiting-task' | 'ready';

export interface BridgeState {
  taskUrl?: string;
  mode: BridgeMode;
  lastChatId?: number;
}

export interface StreamUpdate {
  text: string;
  isFinal: boolean;
}

export type UpdateCallback = (update: string) => Promise<void>;
