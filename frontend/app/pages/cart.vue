<script setup lang="ts">
useHead({ title: 'Cart · Ecommerce' })

const cart = useCartStore()

onMounted(() => cart.load())
</script>

<template>
  <section class="space-y-6">
    <h1 class="text-2xl font-semibold">
      Cart
    </h1>

    <p
      v-if="cart.lines.length === 0"
      class="text-sm text-muted"
    >
      Your cart is empty.
      <NuxtLink
        to="/"
        class="underline"
      >
        Browse the catalog
      </NuxtLink>
      .
    </p>

    <template v-else>
      <UCard>
        <ul class="divide-y divide-default">
          <li
            v-for="line in cart.lines"
            :key="line.productId"
            class="flex flex-wrap items-center justify-between gap-4 py-3"
          >
            <div>
              <NuxtLink
                :to="`/products/${line.productId}`"
                class="font-medium hover:underline"
              >
                {{ line.name }}
              </NuxtLink>
              <p class="text-sm text-muted">
                {{ formatMoney(line.price) }} each
              </p>
            </div>

            <div class="flex items-center gap-3">
              <UInput
                :model-value="line.quantity"
                type="number"
                min="1"
                class="w-20"
                @update:model-value="(value) => cart.setQuantity(line.productId, Number(value))"
              />
              <span class="w-24 text-right font-medium">
                {{ formatMoney(line.price * line.quantity) }}
              </span>
              <UButton
                size="xs"
                variant="ghost"
                color="error"
                @click="cart.remove(line.productId)"
              >
                Remove
              </UButton>
            </div>
          </li>
        </ul>
      </UCard>

      <div class="flex flex-wrap items-center justify-between gap-4">
        <p class="text-lg">
          Subtotal <span class="font-semibold">{{ formatMoney(cart.subtotal) }}</span>
        </p>
        <div class="flex gap-2">
          <UButton
            variant="soft"
            color="neutral"
            @click="cart.clear"
          >
            Clear
          </UButton>
          <UButton to="/checkout">
            Checkout
          </UButton>
        </div>
      </div>
    </template>
  </section>
</template>
