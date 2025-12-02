export interface InventoryCard {
  cardId: string;
  cardName: string;
  level: number;
  variant: string;
  yps: number;
  placed: boolean;
}

export interface UserInventory {
  userId: string;
  packs: Record<string, number>;
  cards: InventoryCard[];
  totalYps: number;
  version?: number;
}

export type ModifyInventoryAction =
  | { action: 'addCard'; card: InventoryCard }
  | { action: 'removeCard'; cardId: string }
  | { action: 'updateCardPlaced'; cardId: string; placed: boolean }
  | { action: 'addPack'; packName: string; quantity?: number }
  | { action: 'removePack'; packName: string; quantity?: number };

export interface ModifyInventoryRequest {
  userId: string;
  operations: ModifyInventoryAction[];
}
