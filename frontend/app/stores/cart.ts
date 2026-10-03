import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Product } from '~/types/api'

/** One line of the cart. Only the fields the cart needs are kept. */
export interface CartLine {
  productId: number
  name: string
  price: number
  quantity: number
}

/** Local storage key. The cart holds no secrets - prices and ids only. */
const STORAGE_KEY = 'ecommerce.cart'

function isCartLine(value: unknown): value is CartLine {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const line = value as Record<string, unknown>
  return (
    typeof line.productId === 'number'
    && typeof line.name === 'string'
    && typeof line.price === 'number'
    && typeof line.quantity === 'number'
  )
}

/**
 * The cart, held client side.
 *
 * There is no cart endpoint yet - orders are Phase 5's domain model - so the cart is a client-side
 * convenience persisted to `localStorage`. It deliberately stores only ids, names and prices: never
 * anything the server considers sensitive, and never a token.
 */
export const useCartStore = defineStore('cart', () => {
  const lines = ref<CartLine[]>([])

  /** Reads the persisted cart. Safe to call more than once; only runs in the browser. */
  function load(): void {
    if (!import.meta.client) {
      return
    }
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) {
      return
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      lines.value = Array.isArray(parsed) ? parsed.filter(isCartLine) : []
    }
    catch {
      // A corrupted entry is not worth failing the page over; start from an empty cart.
      lines.value = []
    }
  }

  function persist(): void {
    if (!import.meta.client) {
      return
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lines.value))
  }

  function add(product: Product, quantity = 1): void {
    const existing = lines.value.find(line => line.productId === product.id)
    if (existing !== undefined) {
      existing.quantity += quantity
    }
    else {
      lines.value.push({
        productId: product.id,
        name: product.name,
        price: product.price,
        quantity,
      })
    }
    persist()
  }

  function setQuantity(productId: number, quantity: number): void {
    const line = lines.value.find(entry => entry.productId === productId)
    if (line === undefined) {
      return
    }
    if (quantity <= 0) {
      remove(productId)
      return
    }
    line.quantity = quantity
    persist()
  }

  function remove(productId: number): void {
    lines.value = lines.value.filter(line => line.productId !== productId)
    persist()
  }

  function clear(): void {
    lines.value = []
    persist()
  }

  const count = computed(() => lines.value.reduce((total, line) => total + line.quantity, 0))
  const subtotal = computed(() => lines.value.reduce((total, line) => total + line.price * line.quantity, 0))

  return { lines, load, add, setQuantity, remove, clear, count, subtotal }
})
