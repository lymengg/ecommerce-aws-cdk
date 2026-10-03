<script setup lang="ts">
import type { Product } from '~/types/api'

const route = useRoute()
const { get } = useApi()
const cart = useCartStore()

const id = Number(route.params.id)
const quantity = ref(1)

const { data: product, pending, error } = await useAsyncData(
  `product-${id}`,
  () => get<Product>(`/api/products/${id}`),
)

useHead(() => ({ title: product.value ? `${product.value.name} · Ecommerce` : 'Product · Ecommerce' }))

function addToCart(): void {
  if (product.value) {
    cart.add(product.value, quantity.value)
  }
}
</script>

<template>
  <section class="space-y-6">
    <UButton
      to="/"
      variant="link"
      size="sm"
      icon="i-lucide-arrow-left"
    >
      Back to catalog
    </UButton>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      title="Product not found"
      description="This product does not exist, or the catalog request failed."
    />

    <div
      v-else-if="pending"
      class="space-y-4"
    >
      <USkeleton class="h-8 w-1/2" />
      <USkeleton class="h-32 w-full" />
    </div>

    <UCard v-else-if="product">
      <template #header>
        <h1 class="text-xl font-semibold">
          {{ product.name }}
        </h1>
      </template>

      <p class="text-sm text-muted">
        {{ product.description ?? 'No description' }}
      </p>

      <div class="mt-6 flex flex-wrap items-center gap-6">
        <p class="text-2xl font-semibold">
          {{ formatMoney(product.price) }}
        </p>
        <p class="text-sm text-muted">
          {{ product.quantity > 0 ? `${product.quantity} in stock` : 'Out of stock' }}
        </p>
      </div>

      <template #footer>
        <div class="flex items-end gap-3">
          <UFormField label="Quantity">
            <UInput
              v-model.number="quantity"
              type="number"
              min="1"
              class="w-24"
            />
          </UFormField>
          <UButton
            :disabled="product.quantity <= 0"
            @click="addToCart"
          >
            Add to cart
          </UButton>
        </div>
      </template>
    </UCard>
  </section>
</template>
