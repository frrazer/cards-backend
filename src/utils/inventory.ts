import { InventoryCard } from '../types/inventory';

export interface ParsedInventory {
  userId: string;
  cards: InventoryCard[];
  packs: Record<string, number>;
  version: number;
  exists: boolean;
}

export function parseInventoryItem(userId: string, item: Record<string, unknown> | undefined): ParsedInventory {
  if (!item) {
    return { userId, cards: [], packs: {}, version: 0, exists: false };
  }

  return {
    userId: (item.userId as string) || userId,
    cards: (item.cards as InventoryCard[]) || [],
    packs: (item.packs as Record<string, number>) || {},
    version: (item.version as number) || 0,
    exists: true,
  };
}

export function reconstructCard(listing: {
  cardId: string;
  cardName: string;
  cardLevel: number;
  cardVariant: string;
}): InventoryCard {
  return {
    cardId: listing.cardId,
    cardName: listing.cardName,
    level: listing.cardLevel,
    variant: listing.cardVariant,
  };
}
