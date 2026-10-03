<script setup lang="ts">
const { user, isAuthenticated, isAdmin, ensureLoaded, login, logout } = useAuth()
const cart = useCartStore()

onMounted(() => {
  // The cart lives in localStorage and the session lives on the server, so both are read on mount.
  cart.load()
  void ensureLoaded()
})
</script>

<template>
  <header class="border-b border-default bg-elevated/50">
    <div class="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
      <NuxtLink
        to="/"
        class="text-lg font-semibold"
      >
        Ecommerce
      </NuxtLink>

      <nav class="flex flex-wrap items-center gap-4 text-sm">
        <NuxtLink
          to="/"
          class="hover:underline"
        >
          Catalog
        </NuxtLink>
        <NuxtLink
          to="/cart"
          class="hover:underline"
        >
          Cart
          <UBadge
            v-if="cart.count > 0"
            size="sm"
            variant="subtle"
            class="ml-1"
          >
            {{ cart.count }}
          </UBadge>
        </NuxtLink>
        <NuxtLink
          v-if="isAdmin"
          to="/admin/products"
          class="hover:underline"
        >
          Admin
        </NuxtLink>

        <template v-if="isAuthenticated">
          <NuxtLink
            to="/account"
            class="hover:underline"
          >
            {{ user?.name }}
          </NuxtLink>
          <UButton
            size="xs"
            variant="soft"
            color="neutral"
            @click="logout"
          >
            Sign out
          </UButton>
        </template>
        <UButton
          v-else
          size="xs"
          @click="login()"
        >
          Sign in
        </UButton>
      </nav>
    </div>
  </header>
</template>
