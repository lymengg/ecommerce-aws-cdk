<script setup lang="ts">
import type { Product, ProductInput } from '~/types/api'

useHead({ title: 'Admin · Products' })

const { isAdmin, isAuthenticated, ensureLoaded, login } = useAuth()
const { post } = useApi()
const toast = useToast()

onMounted(() => void ensureLoaded())

// A local shape: the description is an empty string while editing and `null` on the wire.
const form = reactive({
  name: '',
  description: '',
  price: 0,
  quantity: 0,
})

const submitting = ref(false)
const error = ref<string | null>(null)
const created = ref<Product | null>(null)

async function submit(): Promise<void> {
  error.value = null
  created.value = null
  submitting.value = true

  const payload: ProductInput = {
    name: form.name,
    description: form.description === '' ? null : form.description,
    price: form.price,
    quantity: form.quantity,
  }

  try {
    created.value = await post<Product>('/api/products', payload)
    toast.add({ title: 'Product created', description: created.value.name, color: 'success' })

    form.name = ''
    form.description = ''
    form.price = 0
    form.quantity = 0
  }
  catch (failure) {
    // The API is the authority: a 401 means no session, a 403 means no admin group, a 400 means the
    // body failed validation. The UI just reports what the server decided.
    error.value = describeApiError(failure)
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <section class="space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">
        Admin · Products
      </h1>
      <p class="text-sm text-muted">
        Writes require the <code>admin</code> Cognito group. The API enforces it - this page only
        hides itself.
      </p>
    </div>

    <UAlert
      v-if="!isAuthenticated"
      color="warning"
      variant="soft"
      title="Sign in required"
      description="An anonymous write is rejected with 401."
    >
      <template #actions>
        <UButton
          size="sm"
          @click="login()"
        >
          Sign in
        </UButton>
      </template>
    </UAlert>

    <UAlert
      v-else-if="!isAdmin"
      color="warning"
      variant="soft"
      title="Not an admin"
      description="You are signed in, but not in the admin group. The API would answer 403."
    />

    <UCard>
      <template #header>
        <h2 class="font-medium">
          Create a product
        </h2>
      </template>

      <form
        class="grid gap-4 sm:grid-cols-2"
        @submit.prevent="submit"
      >
        <UFormField
          label="Name"
          required
          class="sm:col-span-2"
        >
          <UInput
            v-model="form.name"
            placeholder="Laptop"
          />
        </UFormField>

        <UFormField
          label="Description"
          class="sm:col-span-2"
        >
          <UInput
            v-model="form.description"
            placeholder="A 14 inch laptop"
          />
        </UFormField>

        <UFormField
          label="Price"
          required
        >
          <UInput
            v-model.number="form.price"
            type="number"
            step="0.01"
            min="0.01"
          />
        </UFormField>

        <UFormField label="Quantity">
          <UInput
            v-model.number="form.quantity"
            type="number"
            min="0"
          />
        </UFormField>

        <div class="sm:col-span-2">
          <UButton
            type="submit"
            :loading="submitting"
            :disabled="!isAdmin"
          >
            Create product
          </UButton>
        </div>
      </form>

      <UAlert
        v-if="error"
        class="mt-4"
        color="error"
        variant="soft"
        title="Write rejected"
        :description="error ?? ''"
      />
      <UAlert
        v-else-if="created"
        class="mt-4"
        color="success"
        variant="soft"
        title="Created"
        :description="`${created.name} is now in the catalog.`"
      />
    </UCard>
  </section>
</template>
