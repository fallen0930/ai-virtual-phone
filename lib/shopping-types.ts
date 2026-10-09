import type {
  CheckPhoneShoppingCartItem,
  CheckPhoneShoppingOrder,
  CheckPhoneShoppingShippingEvent,
  CheckPhoneShoppingPayload,
  CheckPhoneShoppingProduct,
} from "./checkphone-config";

export type ShoppingProduct = CheckPhoneShoppingProduct;
export type ShoppingCartItem = CheckPhoneShoppingCartItem;
export type ShoppingOrder = CheckPhoneShoppingOrder;
export type ShoppingShippingEvent = CheckPhoneShoppingShippingEvent;

export type ShoppingCategory = {
  id: string;
  title: string;
  subtitle: string;
  items: ShoppingProduct[];
};

export type ShoppingCatalog = {
  categories: ShoppingCategory[];
  recommendations: ShoppingProduct[];
};

export type ShoppingSettings = {
  refreshPrompt: string;
  searchPrompt: string;
  deliveryMinMinutes: number;
  deliveryMaxMinutes: number;
};

export type ShoppingSearchResult = {
  query: string;
  items: ShoppingProduct[];
  generatedAt: string;
};

export type ShoppingState = {
  catalog: ShoppingCatalog;
  searchResult?: ShoppingSearchResult;
  savedItems: ShoppingProduct[];
  cartItems: ShoppingCartItem[];
  orders: ShoppingOrder[];
  settings: ShoppingSettings;
  generatedAt?: string;
  updatedAt: string;
};

export type ShoppingRefreshResult = {
  catalog: ShoppingCatalog | null;
  rawOutput?: string;
  error?: string;
};

export type ShoppingSearchResponse = {
  result: ShoppingSearchResult | null;
  rawOutput?: string;
  error?: string;
};

export type ShoppingPayloadView = CheckPhoneShoppingPayload;
