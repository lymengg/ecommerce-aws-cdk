<script setup lang="ts">
import type { Product } from '~/types/api'

const props = defineProps<{ product: Product }>()

const cart = useCartStore()

const outOfStock = computed(() => props.product.quantity <= 0)
</script>

<template>
  <UCard class="flex h-full flex-col">
    <template #header>
      <NuxtLink
        :to="`/products/${props.product.id}`"
        class="font-medium hover:underline"
      >
        {{ props.product.name }}
      </NuxtLink>
    </template>

    <p class="line-clamp-2 min-h-10 text-sm text-muted">
      {{ props.product.description ?? 'No description' }}
    </p>

    <p class="mt-3 text-lg font-semibold">
      {{ formatMoney(props.product.price) }}
    </p>

    <template #footer>
      <div class="flex items-center justify-between">
        <span class="text-xs text-muted">
          {{ outOfStock ? 'Out of stock' : `${props.product.quantity} in stock` }}
        </span>
        <UButton
          size="sm"
          :disabled="outOfStock"
          @click="cart.add(props.product)"
        >
          Add to cart
        </UButton>
      </div>
    </template>
  </UCard>
</template>
