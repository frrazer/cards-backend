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
  | { action: 'setCardLevel'; cardId: string; level: number }
  | { action: 'addPack'; packName: string; quantity?: number }
  | { action: 'removePack'; packName: string; quantity?: number };

export interface ModifyInventoryRequest {
  userId: string;
  operations: ModifyInventoryAction[];
}

// Marketplace Types
export type ListingType = 'card' | 'pack';

export interface CardListing {
  type: 'card';
  cardName: string;
  cardId: string;
  cardLevel: number;
  cardVariant: string;
  sellerId: string;
  sellerUsername: string;
  cost: number;
  timestamp: string;
}

export interface PackListing {
  type: 'pack';
  listingId: string;
  packName: string;
  sellerId: string;
  sellerUsername: string;
  cost: number;
  timestamp: string;
}

export type MarketplaceListing = CardListing | PackListing;

export interface RapRecord {
  rap: number;
  lastUpdated: string;
  lastSnapshotDate?: string;
}

export interface RapHistoryEntry {
  date: string;
  rap: number;
}

export interface ItemRapData {
  rap: number;
  history: RapHistoryEntry[];
}

export interface MarketplaceHistoryResponse {
  cards: Record<string, ItemRapData>;
  packs: Record<string, ItemRapData>;
}
