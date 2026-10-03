import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useCartStore } from '../app/stores/cart'
import type { Product } from '../app/types/api'

function product(id: number, name: string, price: number, quantity = 10): Product {
  return {
    id,
    name,
    description: null,
    price,
    quantity,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

describe('cart store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('starts empty', () => {
    const cart = useCartStore()

    expect(cart.lines).toHaveLength(0)
    expect(cart.count).toBe(0)
    expect(cart.subtotal).toBe(0)
  })

  it('adds a product as a line', () => {
    const cart = useCartStore()

    cart.add(product(1, 'Laptop', 1200))

    expect(cart.lines).toHaveLength(1)
    expect(cart.lines[0]).toMatchObject({ productId: 1, name: 'Laptop', price: 1200, quantity: 1 })
    expect(cart.count).toBe(1)
    expect(cart.subtotal).toBe(1200)
  })

  it('merges a repeated add into the existing line', () => {
    const cart = useCartStore()

    cart.add(product(1, 'Laptop', 1200))
    cart.add(product(1, 'Laptop', 1200), 2)

    expect(cart.lines).toHaveLength(1)
    expect(cart.lines[0].quantity).toBe(3)
    expect(cart.count).toBe(3)
    expect(cart.subtotal).toBe(3600)
  })

  it('computes the subtotal across lines', () => {
    const cart = useCartStore()

    cart.add(product(1, 'Laptop', 1200), 1)
    cart.add(product(2, 'Cable', 9.99), 2)

    expect(cart.count).toBe(3)
    expect(cart.subtotal).toBeCloseTo(1219.98, 2)
  })

  it('removes a line when its quantity drops to zero', () => {
    const cart = useCartStore()

    cart.add(product(1, 'Laptop', 1200))
    cart.setQuantity(1, 0)

    expect(cart.lines).toHaveLength(0)
    expect(cart.count).toBe(0)
  })

  it('updates a line quantity', () => {
    const cart = useCartStore()

    cart.add(product(1, 'Laptop', 1200))
    cart.setQuantity(1, 5)

    expect(cart.lines[0].quantity).toBe(5)
    expect(cart.subtotal).toBe(6000)
  })

  it('ignores a quantity update for a line that is not in the cart', () => {
    const cart = useCartStore()

    cart.setQuantity(999, 3)

    expect(cart.lines).toHaveLength(0)
  })

  it('clears every line', () => {
    const cart = useCartStore()

    cart.add(product(1, 'Laptop', 1200))
    cart.add(product(2, 'Cable', 9.99))
    cart.clear()

    expect(cart.lines).toHaveLength(0)
    expect(cart.subtotal).toBe(0)
  })
})
