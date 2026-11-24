import { readDigikalaProduct, searchDigikala, shoppingHostPermission } from "./shopping-digikala.js";
import { readSnappShopProduct, searchSnappShop, snappShopPermission } from "./shopping-snappshop.js";

export const shoppingPermissions = Object.freeze({ digikala: shoppingHostPermission, snappshop: snappShopPermission });

export function shoppingPermission(store) {
  return store === "snappshop" ? snappShopPermission : shoppingHostPermission;
}

export function readShoppingProduct({ store, productId }) {
  return store === "snappshop" ? readSnappShopProduct(productId) : readDigikalaProduct(productId);
}

export function searchShopping(store, query) {
  return store === "snappshop" ? searchSnappShop(query) : searchDigikala(query);
}
