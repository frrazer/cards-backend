/**
 * Card in a user's inventory
 */
export interface InventoryCard {
    cardId: string;
    cardName: string;
    level: number;
    variant: string;
}

/**
 * User's inventory structure
 */
export interface UserInventory {
    userId: string;
    packs: Record<string, number>; // { [packname]: count }
    cards: InventoryCard[];
    version?: number; // For optimistic locking
}

/**
 * Modify inventory request types
 */
export type ModifyInventoryAction =
    | { action: 'addCard'; card: InventoryCard }
    | { action: 'removeCard'; cardId: string }
    | { action: 'addPack'; packName: string; quantity?: number }
    | { action: 'removePack'; packName: string; quantity?: number };

export interface ModifyInventoryRequest {
    userId: string;
    operations: ModifyInventoryAction[];
}
