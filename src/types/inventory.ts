export interface InventoryCard {
  cardId: string;
  cardName: string;
  level: number;
  variant: string;
}

export interface UserInventory {
  userId: string;
  packs: Record<string, number>;
  cards: InventoryCard[];
  version?: number;
}

export type ModifyInventoryAction =
  | { action: 'addCard'; card: InventoryCard }
  | { action: 'removeCard'; cardId: string }
  | { action: 'addPack'; packName: string; quantity?: number }
  | { action: 'removePack'; packName: string; quantity?: number };

export interface ModifyInventoryRequest {
  userId: string;
  operations: ModifyInventoryAction[];
}
