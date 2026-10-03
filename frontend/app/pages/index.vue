<script setup lang="ts">
import type { Product } from '~/types/api'

useHead({ title: 'Catalog · Ecommerce' })

const { get } = useApi()
const { data, pending, error, refresh } = await useAsyncData('catalog', () => get<Product[]>('/api/products'))

const search = ref('')
const sort = ref<'name' | 'price-asc' | 'price-desc'>('name')

const sortOptions = [
  { label: 'Name', value: 'name' },
  { label: 'Price: low to high', value: 'price-asc' },
  { label: 'Price: high to low', value: 'price-desc' },
]

const products = computed(() => {
  const term = search.value.trim().toLowerCase()
  const list = (data.value ?? []).filter(product => product.name.toLowerCase().includes(term))

  return [...list].sort((a, b) => {
    if (sort.value === 'price-asc') return a.price - b.price
    if (sort.value === 'price-desc') return b.price - a.price
    return a.name.localeCompare(b.name)
  })
})
</script>

<template>
  <section class="space-y-6">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold">
          Catalog
        </h1>
        <p class="text-sm text-muted">
          Product reads are public: this page works without signing in.
        </p>
      </div>

      <div class="flex flex-wrap items-end gap-3">
        <UFormField label="Search">
          <UInput
            v-model="search"
            placeholder="Filter by name"
          />
        </UFormField>
        <UFormField label="Sort">
          <USelect
            v-model="sort"
            :items="sortOptions"
          />
        </UFormField>
      </div>
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      title="Could not load products"
      description="The catalog request failed. Try refreshing."
    />

    <div
      v-else-if="pending"
      class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      <USkeleton
        v-for="n in 6"
        :key="n"
        class="h-44"
      />
    </div>

    <p
      v-else-if="products.length === 0"
      class="text-sm text-muted"
    >
      No products match.
    </p>

    <div
      v-else
      class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      <ProductCard
        v-for="product in products"
        :key="product.id"
        :product="product"
      />
    </div>

    <UButton
      variant="ghost"
      size="sm"
      @click="refresh()"
    >
      Refresh
    </UButton>
  </section>
</template>
