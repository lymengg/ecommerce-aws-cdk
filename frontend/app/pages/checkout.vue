<script setup lang="ts">
useHead({ title: 'Checkout · Ecommerce' })

const cart = useCartStore()

onMounted(() => cart.load())
</script>

<template>
  <section class="space-y-6">
    <h1 class="text-2xl font-semibold">
      Checkout
    </h1>

    <!--
      Deliberately UI-only for now. Placing an order needs the orders domain (POST /api/orders, an
      order status, and the SNS/SQS pipeline) which is Phase 5. This screen shows the shape of the
      flow and the totals, and is honest about the missing half rather than pretending to submit.
    -->
    <UAlert
      color="warning"
      variant="soft"
      icon="i-lucide-construction"
      title="Checkout is not wired up yet"
      description="Order placement arrives with Phase 5 (the orders API and the SNS/SQS order pipeline). The cart is held in your browser for now."
    />

    <UCard v-if="cart.lines.length > 0">
      <template #header>
        <h2 class="font-medium">
          Order summary
        </h2>
      </template>

      <ul class="space-y-2 text-sm">
        <li
          v-for="line in cart.lines"
          :key="line.productId"
          class="flex justify-between"
        >
          <span>{{ line.name }} × {{ line.quantity }}</span>
          <span>{{ formatMoney(line.price * line.quantity) }}</span>
        </li>
      </ul>

      <template #footer>
        <div class="flex justify-between text-lg">
          <span>Subtotal</span>
          <span class="font-semibold">{{ formatMoney(cart.subtotal) }}</span>
        </div>
      </template>
    </UCard>

    <p
      v-else
      class="text-sm text-muted"
    >
      Your cart is empty.
    </p>

    <UButton
      to="/cart"
      variant="soft"
      color="neutral"
    >
      Back to cart
    </UButton>
  </section>
</template>
